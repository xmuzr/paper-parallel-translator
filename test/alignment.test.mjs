import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server.mjs';
import { segmentSentences, validateAlignment, joinTranslations, reconcileResults } from '../public/sentence-alignment.mjs';

test('segments scientific English without splitting abbreviations, decimals or math', () => {
  const source = 'As shown in Fig. 2, the cost is 1.25 with $f(x.) = 2$. Smith et al. [12] use e.g. RRT*. Does it work? Yes!';
  const sentences = segmentSentences(source);
  assert.deepEqual(sentences.map(item => item.source), [
    'As shown in Fig. 2, the cost is 1.25 with $f(x.) = 2$.',
    'Smith et al. [12] use e.g. RRT*.', 'Does it work?', 'Yes!',
  ]);
  for (const item of sentences) assert.equal(source.slice(item.start, item.end), item.source);
});

test('keeps repeated sentences distinct and preserves multi-sentence Chinese under one id', () => {
  const source = 'Same sentence. Same sentence.';
  const alignment = validateAlignment(source, [
    { id: 's1', translation: '相同的第二句。' },
    { id: 's0', translation: '第一句译文。这句有两句话。' },
  ]);
  assert.equal(alignment[0].id, 's0');
  assert.equal(alignment[1].id, 's1');
  assert.equal(joinTranslations(source, alignment), '第一句译文。这句有两句话。相同的第二句。');
  assert.equal(validateAlignment(source, [{ id: 's0', translation: '缺一句。' }]), null);
  assert.equal(validateAlignment(source, [{ id: 's0', translation: '一。' }, { id: 's0', translation: '二。' }]), null);
  assert.equal(validateAlignment(source, [{ id: 's0', translation: '一。' }, { id: 's2', translation: '二。' }]), null);
  assert.equal(validateAlignment(source, [{ id: 's0', source: 'Changed.', translation: '一。' }, { id: 's1', translation: '二。' }]), null);
});

function translated(source, translations) {
  const alignment = segmentSentences(source).map((item, i) => ({ ...item, translation: translations[i] }));
  return { source, alignment, translation: joinTranslations(source, alignment) };
}

test('deleting a sentence retains only surviving pairs and renumbers them', () => {
  const before = 'First sentence. Second sentence. Third sentence.';
  const after = 'First sentence. Third sentence.';
  const retained = reconcileResults(before, after, [translated(before, ['一。', '二。', '三。'])]);
  assert.deepEqual(retained[0].alignment.map(item => [item.id, item.source, item.translation]), [
    ['s0', 'First sentence.', '一。'], ['s1', 'Third sentence.', '三。'],
  ]);
  assert.ok(retained[0].alignment.every(item => !item.pending));
});

test('rewriting one sentence keeps other pairs and marks only the changed sentence pending', () => {
  const before = 'First sentence. Second sentence. Third sentence.';
  const after = 'First sentence. A changed sentence. Third sentence.';
  const retained = reconcileResults(before, after, [translated(before, ['一。', '二。', '三。'])]);
  assert.equal(retained[0].alignment[0].translation, '一。');
  assert.equal(retained[0].alignment[1].pending, true);
  assert.equal(retained[0].alignment[2].translation, '三。');
  assert.ok(validateAlignment(after, retained[0].alignment, { allowPending: true }));
  assert.equal(validateAlignment(after, retained[0].alignment), null);
});

test('editing across paragraphs preserves repeated sentences by their unchanged positions', () => {
  const before = 'Same sentence. Same sentence. Last sentence.';
  const after = 'Same sentence. Last sentence.';
  const retained = reconcileResults(before, after, [translated(before, ['第一次。', '第二次。', '最后。'])]);
  assert.equal(retained[0].alignment[0].translation, '第一次。');
  assert.equal(retained[0].alignment[1].translation, '最后。');
  const moved = 'Same sentence.\n\nSame sentence. Last sentence.';
  const paragraphs = reconcileResults(before, moved, [translated(before, ['第一次。', '第二次。', '最后。'])]);
  assert.equal(paragraphs[0].alignment[0].translation, '第一次。');
  assert.equal(paragraphs[1].alignment[0].translation, '第二次。');
});

async function listen(server, t) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('aligned API requests full-paragraph context and verifies returned sentence IDs', async t => {
  let sent;
  let responseSentences = [{ id: 's1', translation: '这说明方法可行。' }, { id: 's0', translation: '代价为 1.25。这是第一句的补充译文。' }];
  const mock = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    sent = JSON.parse(Buffer.concat(chunks));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ sentences: responseSentences }) } }] }));
  });
  const upstream = await listen(mock, t);
  const base = await listen(createApp({ apiKey: 'mock-only', baseUrl: upstream }), t);
  const source = 'The cost is 1.25. This supports feasibility.';
  async function request() {
    return fetch(base + '/api/translate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: source, alignSentences: true }) });
  }
  const response = await request();
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.alignment.length, 2);
  assert.equal(result.alignment[0].source, 'The cost is 1.25.');
  assert.equal(result.alignment[0].translation, '代价为 1.25。这是第一句的补充译文。');
  assert.equal(sent.response_format.type, 'json_object');
  const input = JSON.parse(sent.messages[1].content);
  assert.equal(input.english_text, source);
  assert.deepEqual(input.sentences, [{ id: 's0', source: 'The cost is 1.25.' }, { id: 's1', source: 'This supports feasibility.' }]);
  responseSentences = [{ id: 's0', translation: '遗漏第二句。' }];
  const invalid = await request();
  assert.equal(invalid.status, 502);
  assert.match((await invalid.json()).error, /编号不完整/);
});
