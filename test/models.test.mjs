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

test('model discovery uses the selected key and separates text models from specialized models', async t => {
  const calls = [];
  const upstream = await listen(http.createServer((req, res) => {
    calls.push({ path: req.url, key: req.headers.authorization });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [
      { id: 'gpt-6.1-sol' }, { id: 'gpt-6.1-terra' }, { id: 'gpt-5.4-mini' },
      { id: 'gpt-image-2' }, { id: 'text-embedding-3-small' }, { id: 'gpt-realtime-2' },
      { id: 'gpt-4.1-old', shutdown_date: '2020-01-01' }, { id: 'gpt-6.1-sol' },
    ] }));
  }), t);
  const base = await listen(createApp({ apiKey: '', openaiApiKey: '', openaiBaseUrl: upstream }), t);
  const response = await post(base, '/api/models', { provider: 'openai', key: 'sk-test-model-key' });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.models, ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-5.4-mini']);
  assert.equal(data.total, 8);
  assert.deepEqual(calls, [{ path: '/models', key: 'Bearer sk-test-model-key' }]);
  const notSaved = await (await fetch(base + '/api/config')).json();
  assert.equal(notSaved.providers.openai.configured, false, 'reading with a draft key must not save the key');
  const saved = await post(base, '/api/session', { provider: 'openai', key: 'sk-test-model-key', model: 'gpt-6.1-terra' });
  const configuration = await saved.json();
  assert.equal(configuration.providers.openai.modelsSource, 'api');
  assert.deepEqual(configuration.providers.openai.models, data.models);
  assert.doesNotMatch(JSON.stringify(configuration), /sk-test-model-key/);
});

test('model catalogs are scoped to provider and key; newly returned DeepSeek IDs can be selected', async t => {
  const upstream = await listen(http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: req.headers.authorization === 'Bearer sk-dynamic-deepseek'
      ? [{ id: 'deepseek-new-text', output_modalities: ['text'] }, { id: 'deepseek-new-image', output_modalities: ['image'] }]
      : [{ id: 'gpt-6.1-sol' }] }));
  }), t);
  const base = await listen(createApp({ apiKey: '', openaiApiKey: '', baseUrl: upstream, openaiBaseUrl: upstream }), t);
  const read = await post(base, '/api/models', { provider: 'deepseek', key: 'sk-dynamic-deepseek' });
  assert.deepEqual((await read.json()).models, ['deepseek-new-text']);
  const saved = await post(base, '/api/session', { provider: 'deepseek', key: 'sk-dynamic-deepseek', model: 'deepseek-new-text' });
  assert.equal(saved.status, 200);
  const cookie = saved.headers.get('set-cookie').split(';')[0];
  const fromStoredKey = await post(base, '/api/models', { provider: 'deepseek' }, cookie);
  assert.equal(fromStoredKey.status, 200);
  const otherKey = await post(base, '/api/session', { provider: 'openai', key: 'sk-other-model-key', model: 'gpt-5.4-mini' }, cookie);
  const configuration = await otherKey.json();
  assert.equal(configuration.providers.deepseek.modelsSource, 'api');
  assert.equal(configuration.providers.openai.modelsSource, 'preset');
});

test('missing keys and failed discovery do not replace presets or expose upstream secrets', async t => {
  const upstream = await listen(http.createServer((req, res) => { res.writeHead(401); res.end('sk-do-not-expose-this'); }), t);
  const base = await listen(createApp({ apiKey: '', openaiApiKey: '', openaiBaseUrl: upstream }), t);
  assert.equal((await post(base, '/api/models', { provider: 'openai' })).status, 400);
  const response = await post(base, '/api/models', { provider: 'openai', key: 'bad-key' });
  assert.equal(response.status, 401);
  assert.doesNotMatch(await response.text(), /sk-do-not-expose/);
  const configuration = await (await fetch(base + '/api/config')).json();
  assert.equal(configuration.providers.openai.modelsSource, 'preset');
  assert.ok(configuration.providers.openai.models.length >= 8);
});

test('a hanging model endpoint times out and leaves existing choices available', async t => {
  const upstream = await listen(http.createServer(() => {}), t);
  const base = await listen(createApp({ apiKey: '', openaiApiKey: '', openaiBaseUrl: upstream, modelsTimeout: 30 }), t);
  const response = await post(base, '/api/models', { provider: 'openai', key: 'mock-only' });
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /超时/);
});
