import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server.mjs';

async function listen(server, t) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
function post(base, route, body, cookie = '') {
  return fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
}

test('OpenAI and DeepSeek keep separate credentials and models in one browser session', async t => {
  const calls = [];
  const mock = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    calls.push({ path: req.url, key: req.headers.authorization, body });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url === '/responses'
      ? { status: 'completed', output: [{ type: 'reasoning', summary: [] }, { type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ sentences: [{ id: 's0', translation: '第一句。第二句仍对应同一个英文句子。' }] }) }] }] }
      : { choices: [{ finish_reason: 'stop', message: { content: 'DeepSeek 译文。' } }] }));
  });
  const upstream = await listen(mock, t);
  const base = await listen(createApp({ apiKey: '', openaiApiKey: '', baseUrl: upstream, openaiBaseUrl: upstream }), t);
  const first = await post(base, '/api/session', { provider: 'deepseek', key: 'sk-deepseek-mock', model: 'deepseek-flash' });
  const cookie = first.headers.get('set-cookie').split(';')[0];
  const second = await post(base, '/api/session', { provider: 'openai', key: 'sk-openai-mock', model: 'gpt-5.4-mini' }, cookie);
  assert.equal(second.status, 200);
  const configuration = await second.json();
  assert.equal(configuration.providers.deepseek.configured, true);
  assert.equal(configuration.providers.openai.configured, true);
  assert.doesNotMatch(JSON.stringify(configuration), /sk-deepseek|sk-openai/);
  const openai = await post(base, '/api/translate', { provider: 'openai', text: 'One English sentence.', model: 'gpt-5.4-mini', alignSentences: true }, cookie);
  assert.equal(openai.status, 200);
  assert.equal((await openai.json()).alignment[0].source, 'One English sentence.');
  assert.equal(calls[0].path, '/responses');
  assert.equal(calls[0].key, 'Bearer sk-openai-mock');
  assert.equal(calls[0].body.store, false);
  assert.equal(calls[0].body.text.format.type, 'json_object');
  assert.equal(calls[0].body.thinking, undefined);
  assert.equal(JSON.parse(calls[0].body.input).sentences[0].source, 'One English sentence.');
  const deepseek = await post(base, '/api/translate', { provider: 'deepseek', text: 'Test.' }, cookie);
  assert.equal(deepseek.status, 200);
  assert.equal(calls[1].path, '/chat/completions');
  assert.equal(calls[1].key, 'Bearer sk-deepseek-mock');
  await post(base, '/api/session', { provider: 'openai', model: 'gpt-5.4' }, cookie);
  const saved = await (await fetch(base + '/api/config', { headers: { Cookie: cookie } })).json();
  assert.equal(saved.providers.openai.model, 'gpt-5.4');
  assert.equal(saved.providers.deepseek.model, 'deepseek-flash');
  const cleared = await (await post(base, '/api/session', { provider: 'deepseek', clear: true }, cookie)).json();
  assert.equal(cleared.providers.deepseek.configured, false);
  assert.equal(cleared.providers.openai.configured, true);
  assert.equal((await post(base, '/api/translate', { provider: 'deepseek', text: 'Test.' }, cookie)).status, 503);
  assert.equal((await post(base, '/api/translate', { provider: 'openai', text: 'One English sentence.', alignSentences: true }, cookie)).status, 200);
});

test('OpenAI never falls back to a DeepSeek key; unknown providers and models are rejected', async t => {
  const base = await listen(createApp({ apiKey: 'sk-deepseek-mock', openaiApiKey: '' }), t);
  assert.equal((await post(base, '/api/translate', { provider: 'openai', text: 'Test.' })).status, 503);
  assert.equal((await post(base, '/api/translate', { provider: 'unknown', text: 'Test.' })).status, 400);
  assert.equal((await post(base, '/api/session', { provider: 'openai', key: 'mock', model: 'bad model' })).status, 400);
});

test('OpenAI truncated and incomplete responses do not become successful translations', async t => {
  const upstream = await listen(http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'incomplete', output: [{ type: 'message', content: [{ type: 'output_text', text: '半段译文' }] }] }));
  }), t);
  const base = await listen(createApp({ apiKey: '', openaiApiKey: 'mock', openaiBaseUrl: upstream }), t);
  const response = await post(base, '/api/translate', { provider: 'openai', text: 'Test.' });
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /输出长度/);
});
