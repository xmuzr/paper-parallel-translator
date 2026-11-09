const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
  const { segmentSentences, joinTranslations } = await import('../public/sentence-alignment.mjs');
  const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    let paidRequests = 0;
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', req => { if (req.url().includes('/api/translate')) paidRequests += 1; });
    await page.addInitScript(() => {
      window.print = () => { window.__printCalls = (window.__printCalls || 0) + 1; };
      const seed = sessionStorage.getItem('qa-seed');
      if (seed) { localStorage.setItem('paper-parallel-draft-v1', seed); sessionStorage.removeItem('qa-seed'); }
      if (!sessionStorage.getItem('qa-layout-seeded')) {
        localStorage.setItem('paper-parallel-layout-v1', JSON.stringify({ width: 750, height: 586, fraction: 33 }));
        sessionStorage.setItem('qa-layout-seeded', 'true');
      }
    });
    await page.goto('http://127.0.0.1:8765');
    await page.locator('#example-button').click();

    // Removing or rewriting one sentence must not discard unrelated translations.
    const original = await page.locator('#source').inputValue();
    const afterDelete = original.replace(' However, unsuccessful extension attempts are often discarded, even though they may provide useful information about nearby obstacles.', '');
    await page.locator('#source').fill(afterDelete);
    assert.equal(await page.locator('.sentence-text').count(), 4);
    assert.equal(await page.locator('.pending-sentence').count(), 0);
    assert.equal(await page.locator('#translations').textContent().then(t => t.includes('失败的扩展尝试')), false);
    const firstTranslation = await page.locator('.sentence-text').first().textContent();
    await page.locator('#source').fill(afterDelete.replace('Sampling-based', 'Randomized'));
    assert.equal(await page.locator('.pending-sentence').count(), 1);
    assert.equal(await page.locator('.sentence-text:not(.pending-sentence)').count(), 3);
    await page.locator('#source').fill(afterDelete);
    assert.equal(await page.locator('.pending-sentence').count(), 0);
    assert.equal(await page.locator('.sentence-text').first().textContent(), firstTranslation);
    await page.waitForTimeout(450);
    await page.reload();
    await page.locator('.sentence-text').first().waitFor();
    assert.equal(await page.locator('.sentence-text').count(), 4);
    const point = await page.locator('.source-sentence[data-sentence-key="1:s1"]').evaluate(el => {
      const r = el.getClientRects()[0]; return { x: r.left + 10, y: r.top + r.height / 2 };
    });
    await page.mouse.move(point.x, point.y);
    await page.waitForFunction(() => document.querySelector('.sentence-text.sentence-active')?.dataset.sentenceKey === '1:s1');

    // Repair the old shrunken workspace and keep its width fixed during height dragging.
    const initial = await page.locator('.workspace').boundingBox();
    assert.ok(initial.width >= 1380);
    assert.equal(await page.locator('#column-resizer').getAttribute('aria-valuenow'), '50');
    const handle = await page.locator('#workspace-resizer').boundingBox();
    await page.mouse.move(handle.x + 9, handle.y + 9);
    await page.mouse.down(); await page.mouse.move(handle.x - 171, handle.y - 101, { steps: 6 }); await page.mouse.up();
    const resized = await page.locator('.workspace').boundingBox();
    assert.ok(Math.abs(resized.width - initial.width) < 2);
    assert.ok(resized.height < initial.height - 60);
    const divider = await page.locator('#column-resizer').boundingBox();
    await page.mouse.move(divider.x + 4, divider.y + divider.height / 2);
    await page.mouse.down(); await page.mouse.move(divider.x + 100, divider.y + divider.height / 2, { steps: 5 }); await page.mouse.up();
    assert.ok(Number(await page.locator('#column-resizer').getAttribute('aria-valuenow')) > 50);
    const sourceBefore = await page.locator('.source-column').boundingBox();
    const sourceHandle = await page.locator('#source-width-handle').boundingBox();
    await page.mouse.move(sourceHandle.x + sourceHandle.width / 2, sourceHandle.y + sourceHandle.height / 2);
    await page.mouse.down();
    await page.mouse.move(sourceHandle.x + sourceHandle.width / 2 + 80, sourceHandle.y + sourceHandle.height / 2, { steps: 6 });
    await page.mouse.up();
    assert.ok((await page.locator('.source-column').boundingBox()).width > sourceBefore.width + 30);
    assert.ok(Math.abs((await page.locator('.workspace').boundingBox()).width - initial.width) < 2);
    await page.reload();
    const restored = await page.locator('.workspace').boundingBox();
    assert.ok(Math.abs(restored.width - resized.width) < 3);
    assert.ok(Math.abs(restored.height - resized.height) < 3);
    await page.locator('#reset-size-button').click();
    assert.equal(await page.locator('#column-resizer').getAttribute('aria-valuenow'), '50');
    assert.ok(Math.abs((await page.locator('.workspace').boundingBox()).width - initial.width) < 2);
    const bounds = await page.locator('.columns').boundingBox();
    const split = await page.locator('#column-resizer').boundingBox();
    await page.mouse.move(split.x + split.width / 2, split.y + 40);
    await page.mouse.down(); await page.mouse.move(bounds.x + 1, split.y + 40, { steps: 6 }); await page.mouse.up();
    assert.ok((await page.locator('.source-column').boundingBox()).width >= 319);
    await page.locator('#reset-size-button').click();
    await page.screenshot({ path: path.join(__dirname, 'resizable-workspace.png'), fullPage: true });

    async function exportPdf(mode, filename) {
      await page.emulateMedia({ media: 'screen' });
      await page.locator('#export-pdf-button').click();
      await page.locator(`input[name="pdf-mode"][value="${mode}"]`).check();
      await page.locator('#pdf-form button[type="submit"]').click();
      assert.equal(await page.locator('#pdf-document').getAttribute('data-mode'), mode);
      assert.ok(await page.evaluate(() => window.__printCalls > 0));
      await page.emulateMedia({ media: 'print' });
      assert.equal(await page.locator('main').isVisible(), false);
      await page.pdf({ path: path.join(__dirname, filename), preferCSSPageSize: true, printBackground: true });
      await page.emulateMedia({ media: 'screen' });
      await page.evaluate(() => dispatchEvent(new Event('afterprint')));
    }
    await page.locator('#example-button').click();
    await exportPdf('en', 'export-english.pdf');
    await exportPdf('zh', 'export-chinese.pdf');
    await exportPdf('both', 'export-bilingual.pdf');

    // Partial translation keeps every source sentence in the bilingual output.
    await page.locator('#source').fill(original.replace('Sampling-based', 'Randomized'));
    await page.locator('#export-pdf-button').click();
    await page.locator('input[name="pdf-mode"][value="both"]').check();
    assert.match(await page.locator('#pdf-note').textContent(), /未翻译/);
    await page.locator('#pdf-form button[type="submit"]').click();
    assert.match(await page.locator('#pdf-document').textContent(), /〔未翻译〕/);
    assert.match(await page.locator('#pdf-document').textContent(), /Randomized/);
    await page.evaluate(() => dispatchEvent(new Event('afterprint')));

    // Generate a real multipage PDF with a sentence longer than one printed page.
    const paragraphs = Array.from({ length: 45 }, (_, i) => `Paragraph ${i + 1} provides a controlled example. The formula is $c(x)$ [12]. This is the final sentence for case ${i + 1}.`);
    paragraphs.push('Unusually long sentence ' + 'continues with further details '.repeat(155) + 'LONG_ENGLISH_END.');
    const results = paragraphs.map((source, i) => {
      const alignment = segmentSentences(source).map((item, j) => ({ ...item, translation: i === 45 ? '超长中文句子' + '此处检查跨页时是否完整保留原文和译文。'.repeat(150) + '长句末尾标记。' : `第${i + 1}段第${j + 1}句：` + '这是用于检查分页、中文字体和段落对照的测试内容。'.repeat(3) }));
      return { source, alignment, translation: joinTranslations(source, alignment) };
    });
    await page.evaluate(({ paragraphs, results }) => sessionStorage.setItem('qa-seed', JSON.stringify({ source: paragraphs.join('\n\n'), results, total: results.length })), { paragraphs, results });
    await page.reload();
    await page.locator('.sentence-text').first().waitFor();
    await exportPdf('both', 'export-long-bilingual.pdf');

    // English-only export is available without any translations or API key.
    await page.locator('#clear-button').click();
    await page.locator('#source').fill('English without translation or API key.');
    await page.locator('#export-pdf-button').click();
    assert.equal(await page.locator('input[value="zh"]').isDisabled(), true);
    assert.equal(await page.locator('input[value="en"]').isChecked(), true);
    await page.locator('#close-pdf').click();
    assert.equal(paidRequests, 0);
    assert.deepEqual(errors, []);
    console.log('Feature checks passed: sentence deletion, targeted invalidation, undo, saved pairs, linked hover, old narrow-layout repair, height-only resize, center and left-side width handles, minimum readable width, size restore, three actual PDF formats, partial-translation markers, multipage export, key-free English export. No translation API calls.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
