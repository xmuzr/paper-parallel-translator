const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1912, height: 948 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:8765');
    await page.locator('#example-button').click();
    const frame = () => page.locator('.workspace').boundingBox();
    const bottom = box => box.y + box.height;
    async function drag(selector, dx, dy) {
      const box = await page.locator(selector).boundingBox();
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      await page.mouse.move(x, y); await page.mouse.down();
      await page.mouse.move(x + dx, y + dy, { steps: 10 }); await page.mouse.up();
    }
    const original = await frame();
    await drag('#workspace-top-resizer', 0, 86);
    const shrunk = await frame();
    assert.ok(Math.abs(shrunk.y - original.y - 86) < 2);
    assert.ok(Math.abs(shrunk.height - original.height + 86) < 2);
    assert.ok(Math.abs(bottom(shrunk) - bottom(original)) < 2, 'top resizing must anchor the bottom');
    assert.ok(Math.abs(shrunk.width - original.width) < 2);
    await drag('#workspace-top-resizer', 0, -50);
    const expanded = await frame();
    assert.ok(Math.abs(expanded.y - shrunk.y + 50) < 2);
    assert.ok(Math.abs(bottom(expanded) - bottom(original)) < 2);
    await drag('#workspace-resizer', 0, 64);
    const bottomMoved = await frame();
    assert.ok(Math.abs(bottomMoved.y - expanded.y) < 2);
    assert.ok(Math.abs(bottomMoved.height - expanded.height - 64) < 2);
    await page.locator('#workspace-top-resizer').press('ArrowDown');
    const keyboard = await frame();
    assert.ok(Math.abs(keyboard.y - bottomMoved.y - 24) < 2);
    assert.ok(Math.abs(bottom(keyboard) - bottom(bottomMoved)) < 2);
    await page.reload();
    await page.locator('.sentence-text').first().waitFor();
    const restored = await frame();
    assert.ok(Math.abs(restored.y - keyboard.y) < 2 && Math.abs(restored.height - keyboard.height) < 2);
    const grips = await page.locator('.edge-resizer .resize-grip').evaluateAll(els => els.map(el => {
      const css = getComputedStyle(el), rect = el.getBoundingClientRect();
      return { text: el.textContent.trim(), width: rect.width, height: rect.height, background: css.backgroundColor, radius: css.borderRadius };
    }));
    assert.equal(grips.length, 4);
    assert.ok(grips.every(grip => grip.text === '' && grip.background === grips[0].background && grip.radius === grips[0].radius));
    assert.equal(await page.evaluate(() => document.body.innerText.includes('上下拖动')), false);
    const point = await page.locator('.source-sentence[data-sentence-key="0:s1"]').evaluate(el => {
      const rect = el.getClientRects()[0]; return { x: rect.left + 10, y: rect.top + rect.height / 2 };
    });
    await page.mouse.move(point.x, point.y);
    await page.waitForFunction(() => document.querySelector('.sentence-text.sentence-active')?.dataset.sentenceKey === '0:s1');
    await page.screenshot({ path: path.join(__dirname, 'four-edge-handles.png'), fullPage: true });
    await drag('#workspace-top-resizer', 0, 1200);
    assert.ok((await frame()).height >= 319);
    assert.ok(Math.abs(bottom(await frame()) - bottom(keyboard)) < 2);
    await page.locator('#reset-size-button').click();
    const reset = await frame();
    assert.ok(Math.abs(reset.y - original.y) < 2 && Math.abs(reset.height - original.height) < 2);
    assert.deepEqual(errors, []);
    console.log('Four-edge checks passed: top shrink/expand anchors bottom, bottom resize anchors top, keyboard, restored dimensions, unified empty grips, no drag text, linked hover, minimum height and reset.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
