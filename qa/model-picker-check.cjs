const { chromium } = require('playwright');
const http = require('node:http');
const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
  const { createApp } = await import('../server.mjs');
  const upstreamCalls = [];
  const upstream = http.createServer((req, res) => {
    upstreamCalls.push({ path: req.url, key: req.headers.authorization });
    if (req.headers.authorization === 'Bearer sk-invalid-test') { res.writeHead(401); return res.end('invalid'); }
    const data = req.headers.authorization === 'Bearer sk-deepseek-test'
      ? [{ id: 'deepseek-flash' }, { id: 'deepseek-new-text', output_modalities: ['text'] }]
      : [{ id: 'gpt-6.1-sol' }, { id: 'gpt-6.1-terra' }, { id: 'gpt-5.4-mini' }, { id: 'gpt-5.4' }, { id: 'gpt-image-2' }];
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  const app = createApp({ apiKey: '', openaiApiKey: '', baseUrl: upstreamUrl, openaiBaseUrl: upstreamUrl });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${app.address().port}`);
    await page.locator('#settings-button').click();
    await page.locator('#settings-provider').selectOption('openai');
    assert.equal(await page.locator('#api-model').evaluate(el => el.tagName), 'SELECT');
    const countBefore = await page.locator('#api-model option').count();
    assert.ok(countBefore >= 9);
    await page.locator('#api-model').selectOption('gpt-6.1-terra');
    assert.equal(await page.locator('#api-model option').count(), countBefore, 'selecting one model must not filter out others');
    await page.locator('#load-models-button').click();
    await page.locator('#models-status').filter({ hasText: '请先填写' }).waitFor();
    assert.equal(await page.locator('#api-model option').count(), countBefore);
    await page.locator('#api-key').fill('sk-openai-test');
    await page.locator('#load-models-button').click();
    await page.locator('#models-status').filter({ hasText: '读取到 4 个文本模型' }).waitFor();
    assert.equal(await page.locator('#api-model optgroup[label="接口返回的文本模型"] option').count(), 4);
    assert.equal(await page.locator('#api-model option[value="gpt-image-2"]').count(), 0);
    await page.locator('#api-model').selectOption('gpt-6.1-sol');
    await page.locator('#save-settings').click();
    await page.locator('#settings-dialog').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#model').inputValue(), 'gpt-6.1-sol');
    await page.reload();
    await page.locator('#connection-status').filter({ hasText: '已配置' }).waitFor();
    await page.locator('#settings-button').click();
    assert.equal(await page.locator('#api-model optgroup[label="接口返回的文本模型"] option').count(), 4);
    await page.locator('#load-models-button').click(); // Saved key, no re-entry.
    await page.locator('#models-status').filter({ hasText: '读取到 4 个文本模型' }).waitFor();
    await page.locator('#api-key').fill('sk-invalid-test');
    await page.locator('#load-models-button').click();
    await page.locator('#models-status').filter({ hasText: 'API Key 无效' }).waitFor();
    assert.equal(await page.locator('#api-model optgroup[label="接口返回的文本模型"] option').count(), 4);
    await page.locator('#api-key').fill('');
    await page.screenshot({ path: path.join(__dirname, 'model-picker-desktop.png'), fullPage: true });
    await page.locator('#settings-provider').selectOption('deepseek');
    await page.locator('#api-key').fill('sk-deepseek-test');
    await page.locator('#load-models-button').click();
    await page.locator('#models-status').filter({ hasText: '读取到 2 个文本模型' }).waitFor();
    await page.locator('#api-model').selectOption('deepseek-new-text');
    await page.locator('#save-settings').click();
    await page.locator('#settings-dialog').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#model').inputValue(), 'deepseek-new-text');
    await page.locator('#settings-button').click();
    await page.locator('#settings-provider').selectOption('openai');
    assert.equal(await page.locator('#api-model optgroup[label="接口返回的文本模型"] option').count(), 4);
    await page.locator('#api-model').selectOption('__custom__');
    assert.equal(await page.locator('#custom-model').isVisible(), true);
    await page.locator('#custom-model').fill('gpt-6.1-sol-custom-snapshot');
    await page.locator('#save-settings').click();
    await page.locator('#settings-dialog').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#model').inputValue(), 'gpt-6.1-sol-custom-snapshot');
    assert.ok(upstreamCalls.length >= 4);
    assert.ok(upstreamCalls.every(call => call.path === '/models'));
    assert.doesNotMatch(await page.evaluate(() => JSON.stringify(localStorage)), /sk-openai-test|sk-deepseek-test/);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#settings-button').click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(__dirname, 'model-picker-mobile.png'), fullPage: true });
    assert.deepEqual(errors, []);
    console.log('Model picker checks passed: full native select, no filtering, missing-key guidance, live-model loading through local mocks, saved-key reuse, catalog restore, failure preservation, provider isolation, new DeepSeek IDs, manual model, mobile layout. No real provider requests.');
  } finally {
    await browser.close();
    for (const server of [app, upstream]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
