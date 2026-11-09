const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1912, height: 948 } });
    const errors = [];
    let apiCalls = 0;
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.url().includes('/api/translate')) apiCalls += 1; });
    await page.goto('http://127.0.0.1:8765');
    await page.locator('#example-button').click();
    const frame = () => page.locator('.workspace').boundingBox();
    async function dragEdge(selector, distance) {
      const bounds = await page.locator(selector).boundingBox();
      const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
      await page.mouse.move(x, y); await page.mouse.down();
      await page.mouse.move(x + distance, y, { steps: 8 }); await page.mouse.up();
    }
    await dragEdge('#workspace-left-resizer', 240);
    await dragEdge('#workspace-right-resizer', -180);
    async function hoverSentence() {
      const point = await page.locator('.source-sentence[data-sentence-key="0:s1"]').evaluate(el => {
        const r = el.getClientRects()[0]; return { x: r.left + 10, y: r.top + r.height / 2 };
      });
      await page.mouse.move(point.x, point.y);
      await page.waitForFunction(() => document.querySelector('.sentence-text.sentence-active')?.dataset.sentenceKey === '0:s1');
    }
    await hoverSentence();
    const before = await frame();
    const source = await page.locator('#source').inputValue();
    const chinese = await page.locator('#translations').textContent();
    async function move(dx, dy) {
      const bounds = await page.locator('#workspace-drag-handle').boundingBox();
      const x = bounds.x + bounds.width * 0.6, y = bounds.y + bounds.height / 2;
      await page.mouse.move(x, y); await page.mouse.down();
      await page.mouse.move(x + dx, y + dy, { steps: 12 }); await page.mouse.up();
    }
    await move(100, 70);
    const moved = await frame();
    assert.ok(Math.abs(moved.x - before.x - 100) < 2);
    assert.ok(Math.abs(moved.y - before.y - 70) < 2);
    assert.ok(Math.abs(moved.width - before.width) < 2);
    assert.ok(Math.abs(moved.height - before.height) < 2);
    await hoverSentence(); // Cached hit rectangles must move with the whole workspace.
    await page.screenshot({ path: path.join(__dirname, 'workspace-moved.png'), fullPage: true });
    await move(-150, -30);
    const final = await frame();
    assert.ok(Math.abs(final.x - before.x + 50) < 2);
    assert.ok(Math.abs(final.y - before.y - 40) < 2);
    await page.reload();
    await page.locator('.sentence-text').first().waitFor();
    const restored = await frame();
    assert.ok(Math.abs(restored.x - final.x) < 2);
    assert.ok(Math.abs(restored.y - final.y) < 2);
    assert.ok(Math.abs(restored.width - final.width) < 2);
    assert.equal(await page.locator('#source').inputValue(), source);
    assert.equal(await page.locator('#translations').textContent(), chinese);
    await page.locator('#example-button').click();
    const afterClick = await frame();
    assert.ok(Math.abs(afterClick.x - restored.x) < 2 && Math.abs(afterClick.y - restored.y) < 2);
    await page.locator('#model').selectOption('deepseek-v4-pro');
    const afterSelect = await frame();
    assert.ok(Math.abs(afterSelect.x - restored.x) < 2 && Math.abs(afterSelect.y - restored.y) < 2);
    await page.locator('#workspace-drag-handle').focus();
    await page.locator('#workspace-drag-handle').press('ArrowDown');
    assert.ok(Math.abs((await frame()).y - restored.y - 24) < 2);
    await page.locator('#reset-size-button').click();
    const reset = await frame();
    assert.ok(Math.abs(reset.y - before.y) < 2);
    assert.ok(reset.width > before.width);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(apiCalls, 0);
    assert.deepEqual(errors, []);
    console.log('Workspace movement checks passed: whole-frame movement in both axes, fixed dimensions, updated hover geometry, saved position, unchanged text, normal toolbar buttons/select, keyboard movement and reset. No API calls.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
