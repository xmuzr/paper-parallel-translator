import { segmentSentences, splitText } from './sentence-alignment.mjs';

export function createSentenceHover(textarea, mirror, target) {
  let sourceText;
  let sourceSpans = [];
  let sourceByKey = new Map();
  let activeKey;
  let activeSource;
  let activeTarget;
  let rectangles;
  let frame;
  let pointer;

  function clear() {
    activeSource?.classList.remove('sentence-active');
    activeTarget?.classList.remove('sentence-active');
    activeKey = activeSource = activeTarget = undefined;
  }

  function highlight(key, reveal = false) {
    if (key === activeKey) return;
    clear();
    if (!key) return;
    activeKey = key;
    activeSource = sourceByKey.get(key);
    activeTarget = target.querySelector(`[data-sentence-key="${key}"]`);
    activeSource?.classList.add('sentence-active');
    activeTarget?.classList.add('sentence-active');
    if (reveal && activeTarget) {
      const bounds = target.getBoundingClientRect();
      const firstLine = activeTarget.getClientRects()[0];
      if (firstLine && (firstLine.top < bounds.top + 8 || firstLine.bottom > bounds.bottom - 8)) {
        // Scroll only the translation panel; do not move the page or the input caret.
        target.scrollTop += firstLine.top - bounds.top - 16;
      }
    }
  }

  function syncGeometry() {
    const css = getComputedStyle(textarea);
    for (const key of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'wordSpacing', 'textIndent', 'textAlign', 'tabSize', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']) {
      mirror.style[key] = css[key];
    }
    mirror.style.width = `${textarea.clientWidth}px`;
    mirror.style.height = `${textarea.clientHeight}px`;
    mirror.scrollTop = textarea.scrollTop;
    mirror.scrollLeft = textarea.scrollLeft;
    rectangles = undefined;
  }

  function refresh() {
    clear();
    if (sourceText !== textarea.value) {
      sourceText = textarea.value;
      sourceSpans = [];
      sourceByKey = new Map();
      const fragment = document.createDocumentFragment();
      let previousEnd = 0;
      let searchFrom = 0;
      splitText(sourceText).forEach((paragraph, paragraphIndex) => {
        const offset = sourceText.indexOf(paragraph, searchFrom);
        if (offset < 0) return;
        searchFrom = offset + paragraph.length;
        for (const sentence of segmentSentences(paragraph)) {
          const start = offset + sentence.start;
          const end = offset + sentence.end;
          fragment.append(document.createTextNode(sourceText.slice(previousEnd, start)));
          const span = document.createElement('span');
          const key = `${paragraphIndex}:${sentence.id}`;
          span.className = 'source-sentence';
          span.dataset.sentenceKey = key;
          span.textContent = sourceText.slice(start, end);
          fragment.append(span);
          sourceSpans.push(span);
          sourceByKey.set(key, span);
          previousEnd = end;
        }
      });
      fragment.append(document.createTextNode(sourceText.slice(previousEnd) + '\u200b'));
      mirror.replaceChildren(fragment);
    }
    syncGeometry();
  }

  function locate(x, y) {
    const bounds = mirror.getBoundingClientRect();
    if (x < bounds.left || x >= bounds.right || y < bounds.top || y >= bounds.bottom) return undefined;
    if (!rectangles) {
      rectangles = [];
      for (const span of sourceSpans) {
        const rect = span.getBoundingClientRect();
        if (rect.bottom < bounds.top || rect.top > bounds.bottom) continue;
        for (const line of span.getClientRects()) {
          if (line.height && line.width) rectangles.push({ left: line.left, right: line.right, top: line.top, bottom: line.bottom, key: span.dataset.sentenceKey });
        }
      }
    }
    return rectangles.find(rect => x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom)?.key;
  }

  function schedulePointer() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => { if (pointer) highlight(locate(pointer.x, pointer.y), true); });
  }
  textarea.addEventListener('pointermove', event => { pointer = { x: event.clientX, y: event.clientY }; schedulePointer(); });
  textarea.addEventListener('pointerleave', () => { pointer = undefined; cancelAnimationFrame(frame); clear(); });
  textarea.addEventListener('scroll', () => { syncGeometry(); if (pointer) schedulePointer(); });
  const observer = new ResizeObserver(() => { syncGeometry(); if (pointer) schedulePointer(); });
  observer.observe(textarea);
  // The reverse direction also works for inspecting or editing a translated sentence.
  target.addEventListener('pointerover', event => {
    const sentence = event.target.closest('[data-sentence-key]');
    if (sentence) highlight(sentence.dataset.sentenceKey);
  });
  target.addEventListener('pointerleave', clear);
  target.addEventListener('focusin', event => {
    const sentence = event.target.closest('[data-sentence-key]');
    if (sentence) highlight(sentence.dataset.sentenceKey);
  });
  target.addEventListener('focusout', clear);
  window.addEventListener('scroll', () => { rectangles = undefined; }, { passive: true, capture: true });
  return { refresh, clear, invalidateGeometry: () => { rectangles = undefined; } };
}
