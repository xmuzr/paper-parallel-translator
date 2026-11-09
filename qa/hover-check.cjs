const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
  const { segmentSentences, joinTranslations } = await import('../public/sentence-alignment.mjs');
  const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.addInitScript(() => {
      const seed = sessionStorage.getItem('qa-draft-seed');
      if (seed) { localStorage.setItem('paper-parallel-draft-v1', seed); sessionStorage.removeItem('qa-draft-seed'); }
    });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:8765');
    await page.locator('#example-button').click();

    async function hoverSource(key, lineIndex = 0) {
      const point = await page.locator(`.source-sentence[data-sentence-key="${key}"]`).evaluate((el, index) => {
        const lines = [...el.getClientRects()];
        const rect = lines[Math.min(index, lines.length - 1)];
        return { x: rect.left + Math.min(rect.width / 2, 45), y: rect.top + rect.height / 2 };
      }, lineIndex);
      await page.mouse.move(point.x, point.y);
      await page.waitForFunction(key => document.querySelector('.source-sentence.sentence-active')?.dataset.sentenceKey === key, key);
      assert.equal(await page.locator('.source-sentence.sentence-active').count(), 1);
    }
    async function assertTarget(key) {
      assert.equal(await page.locator('.sentence-text.sentence-active').count(), 1);
      assert.equal(await page.locator('.sentence-text.sentence-active').getAttribute('data-sentence-key'), key);
    }

    assert.equal(await page.locator('.source-sentence').count(), 5);
    assert.equal(await page.locator('.sentence-text').count(), 5);
    await page.locator('#source').evaluate(el => { el.focus(); el.setSelectionRange(4, 15); });
    await hoverSource('0:s0');
    await assertTarget('0:s0');
    assert.deepEqual(await page.locator('#source').evaluate(el => [el.selectionStart, el.selectionEnd]), [4, 15]);
    await hoverSource('0:s1', 1);
    await assertTarget('0:s1');
    await page.screenshot({ path: path.join(__dirname, 'sentence-hover.png'), fullPage: true });
    await page.mouse.move(10, 10);
    await page.waitForFunction(() => !document.querySelector('.sentence-active'));

    // Reflow must keep character hit-testing in sync with native textarea wrapping.
    await page.setViewportSize({ width: 880, height: 650 });
    await hoverSource('0:s1', 2);
    await assertTarget('0:s1');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);

    // Mock a new aligned response: Chinese splits a source sentence into two sentences.
    await page.route('**/api/config', route => route.fulfill({ json: { configured: true, source: 'server', model: 'deepseek-flash', models: ['deepseek-flash', 'deepseek-v4-pro'] } }));
    const chinese = ['代价为 $c(x)$ [12]。这是同一英文句子的第二句译文。', '这是第二个英文句子的译文。'];
    await page.route('**/api/translate', route => {
      const body = route.request().postDataJSON();
      assert.equal(body.alignSentences, true);
      const alignment = segmentSentences(body.text).map((item, i) => ({ ...item, translation: chinese[i] }));
      return route.fulfill({ json: { translation: joinTranslations(body.text, alignment), alignment, model: 'deepseek-flash' } });
    });
    await page.reload();
    await page.locator('#connection-status').filter({ hasText: '已配置' }).waitFor();
    await page.locator('#source').fill('The cost is $c(x)$ [12]. This is the second sentence.');
    await page.locator('#translate-button').click();
    await page.locator('#progress-status').filter({ hasText: '翻译完成' }).waitFor();
    await hoverSource('0:s0');
    await assertTarget('0:s0');
    assert.equal(await page.locator('.sentence-text.sentence-active').textContent(), chinese[0]);
    await hoverSource('0:s1');
    await assertTarget('0:s1');
    await page.locator('.sentence-text[data-sentence-key="0:s1"]').fill('人工修改第二句。保留同一配对。');
    await page.locator('#source').click();
    await page.waitForTimeout(450);
    await page.reload();
    await page.locator('.sentence-text').first().waitFor();
    await hoverSource('0:s1');
    await assertTarget('0:s1');
    assert.equal(await page.locator('.sentence-text.sentence-active').textContent(), '人工修改第二句。保留同一配对。');

    // Source scroll and target scroll have deliberately different paragraph heights.
    const paragraphs = Array.from({ length: 35 }, (_, i) => `Paragraph ${i + 1} describes a different planning condition with a clearly numbered sentence.`);
    const results = paragraphs.map((source, i) => {
      const alignment = segmentSentences(source).map(item => ({ ...item, translation: `第 ${i + 1} 段：` + '这是一段用于检查对应句子自动定位的模拟译文。'.repeat(7) }));
      return { source, translation: joinTranslations(source, alignment), alignment };
    });
    await page.evaluate(({ paragraphs, results }) => sessionStorage.setItem('qa-draft-seed', JSON.stringify({ source: paragraphs.join('\n\n'), results, total: results.length })), { paragraphs, results });
    await page.reload();
    await page.locator('.sentence-text').first().waitFor();
    await page.locator('#source').evaluate(el => { el.scrollTop = el.scrollHeight; });
    await page.waitForFunction(() => document.querySelector('#source-mirror').scrollTop === document.querySelector('#source').scrollTop);
    const scrollBefore = await page.locator('#source').evaluate(el => el.scrollTop);
    await hoverSource('34:s0');
    await assertTarget('34:s0');
    assert.equal(await page.locator('#source').evaluate(el => el.scrollTop), scrollBefore);
    assert.ok(await page.locator('#target').evaluate(el => el.scrollTop > 0));
    const visible = await page.locator('.sentence-text.sentence-active').evaluate(el => {
      const rect = el.getClientRects()[0];
      const bounds = document.querySelector('#target').getBoundingClientRect();
      return rect.top >= bounds.top && rect.bottom <= bounds.bottom;
    });
    assert.equal(visible, true);

    // Old text-only drafts must not guess sentence correspondence from punctuation counts.
    const legacy = { source: 'First sentence. Second sentence.', translation: '一段未保存逐句对应关系的旧译文。' };
    await page.evaluate(item => sessionStorage.setItem('qa-draft-seed', JSON.stringify({ source: item.source, results: [item], total: 1 })), legacy);
    await page.reload();
    await page.locator('#progress-status').filter({ hasText: '旧译文' }).waitFor();
    await hoverSource('0:s1');
    assert.equal(await page.locator('.sentence-text.sentence-active').count(), 0);
    assert.deepEqual(errors, []);
    console.log('Sentence hover checks passed: exact sentence pairs, wrapped lines, unchanged selection, mouse leave, resize, split Chinese sentences, edits, saved alignment, source scroll, target auto-scroll, legacy draft safety. No live API calls.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
