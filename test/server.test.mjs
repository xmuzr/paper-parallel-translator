import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server.mjs';

async function listen(server, t) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
const post = (base, route, body, headers = {}) => fetch(base + route, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
});

test('serves the input website and keeps server files private', async t => {
  const base = await listen(createApp({ apiKey: '' }), t);
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /输入英文原文/);
  for (const route of ['/.env', '/.env.example', '/server.mjs', '/README.md']) {
    assert.equal((await fetch(base + route)).status, 404);
  }
  const config = await (await fetch(base + '/api/config')).json();
  assert.equal(config.configured, false);
  assert.equal((await post(base, '/api/translate', { text: 'Test.' })).status, 503);
});

test('session key stays on the server; translated text and glossary reach upstream', async t => {
  let sent;
  const mock = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    sent = { path: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '路径规划的代价为 $c(x)$ [12]。' } }] }));
  });
  const upstream = await listen(mock, t);
  const base = await listen(createApp({ apiKey: '', baseUrl: upstream }), t);
  const connected = await post(base, '/api/session', { key: 'sk-test-local-only', model: 'deepseek-flash' });
  const cookie = connected.headers.get('set-cookie').split(';')[0];
  assert.match(connected.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.doesNotMatch(await connected.text(), /sk-test-local-only/);
  const result = await post(base, '/api/translate', { text: 'The cost of path planning is $c(x)$ [12].', glossary: 'path planning = 路径规划' }, { Cookie: cookie });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).translation, '路径规划的代价为 $c(x)$ [12]。');
  assert.equal(sent.path, '/chat/completions');
  assert.equal(sent.auth, 'Bearer sk-test-local-only');
  assert.equal(sent.body.thinking.type, 'disabled');
  assert.equal(sent.body.messages[0].role, 'system');
  assert.deepEqual(JSON.parse(sent.body.messages[1].content), { glossary: 'path planning = 路径规划', english_text: 'The cost of path planning is $c(x)$ [12].' });
  await post(base, '/api/session', { clear: true }, { Cookie: cookie });
  assert.equal((await post(base, '/api/translate', { text: 'Test.' }, { Cookie: cookie })).status, 503);
});

test('rejects foreign origins, wrong content types and invalid input before translation', async t => {
  const base = await listen(createApp({ apiKey: 'mock-only' }), t);
  assert.equal((await post(base, '/api/translate', { text: 'Test.' }, { Origin: 'https://unrelated.example' })).status, 403);
  assert.equal((await fetch(base + '/api/translate', { method: 'POST', body: '{}' })).status, 415);
  for (const body of [{ text: '' }, { text: 9 }, { text: 'Test.', model: 'invalid' }, { text: 'Test.', glossary: [] }]) {
    assert.equal((await post(base, '/api/translate', body)).status, 400);
  }
  assert.equal((await post(base, '/api/translate', { text: 'a'.repeat(8001) })).status, 413);
  assert.equal((await post(base, '/api/session', { key: '\ninvalid key', model: 'deepseek-flash' })).status, 400);
});

for (const code of [401, 402, 429, 500]) {
  test(`upstream ${code} produces a useful error without exposing upstream secrets`, async t => {
    const mock = http.createServer((req, res) => { res.writeHead(code); res.end('sk-secret-from-upstream'); });
    const upstream = await listen(mock, t);
    const base = await listen(createApp({ apiKey: 'mock-only', baseUrl: upstream }), t);
    const response = await post(base, '/api/translate', { text: 'Test.' });
    assert.equal(response.status, code === 401 ? 401 : 502);
    const data = await response.json();
    assert.ok(data.error);
    assert.doesNotMatch(data.error, /sk-secret/);
  });
}

test('rejects truncated or empty translations', async t => {
  let truncated = true;
  const mock = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ finish_reason: truncated ? 'length' : 'stop', message: { content: truncated ? '半段' : '' } }] }));
    truncated = false;
  });
  const upstream = await listen(mock, t);
  const base = await listen(createApp({ apiKey: 'mock-only', baseUrl: upstream }), t);
  const first = await post(base, '/api/translate', { text: 'Test.' });
  assert.equal(first.status, 502);
  assert.match((await first.json()).error, /输出长度/);
  const second = await post(base, '/api/translate', { text: 'Test.' });
  assert.equal(second.status, 502);
  assert.match((await second.json()).error, /未返回译文/);
});

test('times out an unresponsive upstream', async t => {
  const upstream = await listen(http.createServer(() => {}), t);
  const base = await listen(createApp({ apiKey: 'mock-only', baseUrl: upstream, timeout: 50 }), t);
  const response = await post(base, '/api/translate', { text: 'Test.' });
  assert.equal(response.status, 504);
  assert.match((await response.json()).error, /超时/);
});
