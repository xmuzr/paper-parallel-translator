const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:8765');
  await page.locator('#connection-status').filter({ hasText: '未连接' }).waitFor();
  assert.equal(await page.locator('#source').inputValue(), '');
  await page.screenshot({ path: path.join(__dirname, 'desktop-empty.png'), fullPage: true });
  await page.locator('#source').fill('The cost is $c(x)$ [12].\n\nA second paragraph.');
  await page.locator('#translate-button').click();
  await page.locator('dialog[open]').waitFor();
  assert.match(await page.locator('#settings-message').textContent(), /连接 DeepSeek/);
  await page.locator('#close-settings').click();
  await page.locator('#example-button').click();
  assert.equal(await page.locator('.translation-block').count(), 2);
  assert.match(await page.locator('#result-label').textContent(), /非实时翻译/);
  await page.screenshot({ path: path.join(__dirname, 'desktop-example.png'), fullPage: true });
  await page.reload();
  await page.locator('.translation-block').first().waitFor();
  assert.equal(await page.locator('.translation-block').count(), 2);
  await page.locator('#source').fill('New input replaces the example.');
  assert.equal(await page.locator('.translation-block').count(), 0);

  // Local browser mocks only: no paid service is contacted.
  await page.route('**/api/config', route => route.fulfill({ json: { configured: true, source: 'server', model: 'deepseek-flash', models: ['deepseek-flash', 'deepseek-v4-pro'] } }));
  let calls = [];
  await page.route('**/api/translate', async route => {
    const body = route.request().postDataJSON();
    calls.push(body);
    await route.fulfill({ json: { translation: calls.length === 1 ? '代价为 $c(x)$ [12]。' : '<script>window.unsafe = true</script> 第二段。', model: 'deepseek-flash' } });
  });
  await page.reload();
  await page.locator('#connection-status').filter({ hasText: '已配置' }).waitFor();
  await page.locator('#source').fill('The cost is $c(x)$ [12].\n\nSecond paragraph.');
  await page.locator('#translate-button').click();
  await page.locator('#progress-status').filter({ hasText: '翻译完成' }).waitFor();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].text, 'The cost is $c(x)$ [12].');
  assert.equal(await page.evaluate(() => window.unsafe), undefined);
  const editable = page.locator('.translation-text').first();
  await editable.fill('人工修订的译文。');
  await page.locator('#source').click();
  await page.waitForTimeout(450);
  await page.reload();
  await page.locator('.translation-text').first().waitFor();
  assert.equal(await page.locator('.translation-text').first().textContent(), '人工修订的译文。');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#download-button').click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), '译读_英中对照.txt');

  // Long paragraphs are split, not truncated.
  calls = [];
  await page.locator('#source').fill('word '.repeat(2700));
  await page.locator('#translate-button').click();
  await page.locator('#progress-status').filter({ hasText: '翻译完成' }).waitFor();
  assert.equal(calls.length, 3);
  assert.ok(calls.every(body => body.text.length <= 6000));
  assert.equal(calls.map(body => body.text).join(' ').trim(), 'word '.repeat(2700).trim());

  // Failure retains completed translations and unlocks the editor.
  await page.unroute('**/api/translate');
  let failures = 0;
  await page.route('**/api/translate', route => {
    failures += 1;
    return failures === 1 ? route.fulfill({ json: { translation: '第一段已完成。' } }) : route.fulfill({ status: 502, json: { error: '模拟服务不可用。' } });
  });
  await page.locator('#source').fill('First.\n\nSecond.');
  await page.locator('#translate-button').click();
  await page.locator('#progress-status').filter({ hasText: '模拟服务不可用' }).waitFor();
  assert.equal(await page.locator('.translation-block').count(), 1);
  assert.equal(await page.locator('#source').getAttribute('readonly'), null);

  // Cancellation keeps completed paragraphs and prevents further requests.
  await page.unroute('**/api/translate');
  let stoppedCalls = 0;
  let releasePending;
  await page.route('**/api/translate', async route => {
    stoppedCalls += 1;
    if (stoppedCalls === 1) return route.fulfill({ json: { translation: '已完成的第一段。' } });
    await new Promise(resolve => { releasePending = resolve; });
    try { await route.fulfill({ json: { translation: '已取消的第二段。' } }); } catch {}
  });
  await page.locator('#source').fill('First.\n\nSecond.\n\nThird.');
  await page.locator('#translate-button').click();
  await page.locator('#progress-status').filter({ hasText: '第 2 / 3' }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.translation-block').length === 1);
  await page.locator('#stop-button').click();
  await page.locator('#progress-status').filter({ hasText: '已停止' }).waitFor();
  assert.equal(await page.locator('.translation-block').count(), 1);
  assert.equal(await page.locator('#source').getAttribute('readonly'), null);
  assert.equal(stoppedCalls, 2);
  releasePending?.();

  await page.locator('#example-button').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#toast').waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(__dirname, 'mobile-example.png'), fullPage: true });
  await page.locator('#settings-button').click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(__dirname, 'mobile-settings.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log('Browser checks passed: direct input, missing-key prompt, example labels, draft restore, paragraph translation, safe text display, edits, export, long input, failure recovery, cancellation, mobile layout. No live API calls.');
  await browser.close();
})().catch(error => { console.error(error); process.exitCode = 1; });
