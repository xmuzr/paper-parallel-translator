const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1912, height: 948 } });
    const errors = [];
    let translationCalls = 0;
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.url().includes('/api/translate')) translationCalls += 1; });
    await page.goto('http://127.0.0.1:8765');
    await page.locator('#example-button').click();
    const source = await page.locator('#source').inputValue();
    const translation = await page.locator('#translations').textContent();
    const frame = () => page.locator('.workspace').boundingBox();
    const right = bounds => bounds.x + bounds.width;
    async function drag(selector, distance) {
      const bounds = await page.locator(selector).boundingBox();
      const x = bounds.x + bounds.width / 2;
      const y = bounds.y + bounds.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + distance, y, { steps: 12 });
      await page.mouse.up();
    }
    const initial = await frame();
    await drag('#workspace-left-resizer', 280);
    const leftMoved = await frame();
    assert.ok(Math.abs(leftMoved.x - initial.x - 280) < 2);
    assert.ok(Math.abs(right(leftMoved) - right(initial)) < 2, 'left-edge dragging must keep the right edge fixed');
    await drag('#workspace-right-resizer', -240);
    const bothMoved = await frame();
    assert.ok(Math.abs(right(bothMoved) - right(leftMoved) + 240) < 2);
    assert.ok(Math.abs(bothMoved.x - leftMoved.x) < 2, 'right-edge dragging must keep the left edge fixed');
    assert.ok(Math.abs(bothMoved.height - initial.height) < 2);
    await page.reload();
    await page.locator('.sentence-text').first().waitFor();
    const restored = await frame();
    assert.ok(Math.abs(restored.x - bothMoved.x) < 2);
    assert.ok(Math.abs(restored.width - bothMoved.width) < 2);
    assert.equal(await page.locator('#source').inputValue(), source);
    assert.equal(await page.locator('#translations').textContent(), translation);
    await page.screenshot({ path: path.join(__dirname, 'outer-edges-adjusted.png'), fullPage: true });
    await drag('#workspace-left-resizer', -280);
    const expandedLeft = await frame();
    assert.ok(Math.abs(expandedLeft.x - initial.x) < 2);
    assert.ok(Math.abs(right(expandedLeft) - right(bothMoved)) < 2);
    await drag('#workspace-right-resizer', 240);
    const expandedBoth = await frame();
    assert.ok(Math.abs(expandedBoth.width - initial.width) < 2);
    await drag('#workspace-left-resizer', 1700);
    assert.ok((await frame()).width >= 719);
    await page.locator('#workspace-left-resizer').press('Home');
    assert.ok(Math.abs((await frame()).x - initial.x) < 2);
    await page.locator('#workspace-right-resizer').press('ArrowLeft');
    assert.ok(Math.abs((await frame()).width - initial.width + 24) < 2);
    await page.locator('#reset-size-button').click();
    assert.ok(Math.abs((await frame()).width - initial.width) < 2);
    const point = await page.locator('.source-sentence[data-sentence-key="0:s1"]').evaluate(el => {
      const bounds = el.getClientRects()[0]; return { x: bounds.left + 12, y: bounds.top + bounds.height / 2 };
    });
    await page.mouse.move(point.x, point.y);
    await page.waitForFunction(() => document.querySelector('.sentence-text.sentence-active')?.dataset.sentenceKey === '0:s1');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(translationCalls, 0);
    assert.deepEqual(errors, []);
    console.log('Outer-edge checks passed: left and right borders each shrink and expand independently, opposite border fixed, saved positions restored, text unchanged, minimum width, keyboard adjustment, reset and linked highlights. No API calls.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
