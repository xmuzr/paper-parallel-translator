const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });

export function splitText(text) {
  const blocks = text.replace(/\r\n?/g, '\n').trim().split(/\n[ \t]*\n+/).map(t => t.trim()).filter(Boolean);
  const chunks = [];
  for (let block of blocks) {
    while (block.length > 6000) {
      const window = block.slice(0, 6000);
      let cut = Math.max(window.lastIndexOf('\n'), window.lastIndexOf('. '), window.lastIndexOf('; '));
      if (cut < 3000) cut = window.lastIndexOf(' ');
      if (cut < 1) cut = 6000;
      else cut += 1;
      chunks.push(block.slice(0, cut).trim());
      block = block.slice(cut).trim();
    }
    if (block) chunks.push(block);
  }
  return chunks;
}

export function segmentSentences(text) {
  // Mask punctuation in formulas, links and common academic abbreviations.
  // Replacements have the same UTF-16 length, so offsets still refer to the original.
  const mask = value => value.replace(/[.!?。！？]/g, '\uE000');
  const masked = text
    .replace(/\$\$[\s\S]*?\$\$|\$(?:\\.|[^$\n])+\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|`[^`]*`|https?:\/\/[^\s]+/g, mask)
    .replace(/\b(?:e\.g|i\.e|et al|Figs?|Eqs?|Secs?|Dr|Prof|Mr|Mrs|Ms|No|vs)\./gi, mask);
  const result = [];
  for (const part of segmenter.segment(masked)) {
    const raw = text.slice(part.index, part.index + part.segment.length);
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const start = part.index + raw.length - raw.trimStart().length;
    result.push({ id: `s${result.length}`, source: trimmed, start, end: start + trimmed.length });
  }
  return result;
}

export function validateAlignment(source, candidate, { allowPending = false } = {}) {
  const expected = segmentSentences(source);
  if (!Array.isArray(candidate) || candidate.length !== expected.length || !expected.length) return null;
  const entries = new Map();
  for (const item of candidate) {
    if (!item || typeof item.id !== 'string' || entries.has(item.id)
      || typeof item.translation !== 'string'
      || (!item.translation.trim() && !(allowPending && item.pending === true))
      || item.translation.length > 30000) return null;
    entries.set(item.id, item);
  }
  const alignment = [];
  for (const sentence of expected) {
    const item = entries.get(sentence.id);
    if (!item || (item.source !== undefined && item.source !== sentence.source)) return null;
    alignment.push({ ...sentence, translation: item.translation.trim(), ...(allowPending && item.pending === true ? { pending: true } : {}) });
  }
  return alignment;
}

export function sentenceSeparator(source, alignment, index) {
  const next = alignment[index + 1];
  if (!next) return '';
  const whitespace = source.slice(alignment[index].end, next.start);
  return whitespace.includes('\n') ? whitespace : '';
}

export function joinTranslations(source, alignment) {
  return alignment.map((item, index) => item.translation + sentenceSeparator(source, alignment, index)).join('');
}

export function reconcileResults(previousSource, nextSource, previousResults) {
  if (!nextSource.trim() || !previousResults.length) return [];
  let prefix = 0;
  while (prefix < Math.min(previousSource.length, nextSource.length) && previousSource[prefix] === nextSource[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < Math.min(previousSource.length - prefix, nextSource.length - prefix)
    && previousSource[previousSource.length - 1 - suffix] === nextSource[nextSource.length - 1 - suffix]) suffix += 1;
  const newEditEnd = nextSource.length - suffix;
  const delta = previousSource.length - nextSource.length;
  const oldByPosition = new Map();
  const oldByText = new Map();
  let searchFrom = 0;
  for (const item of previousResults) {
    const offset = previousSource.indexOf(item.source, searchFrom);
    if (offset < 0) continue;
    searchFrom = offset + item.source.length;
    for (const sentence of item.alignment || []) {
      if (sentence.pending) continue;
      oldByPosition.set(`${offset + sentence.start}:${offset + sentence.end}`, sentence);
      const matches = oldByText.get(sentence.source) || [];
      matches.push(sentence);
      oldByText.set(sentence.source, matches);
    }
  }
  const paragraphs = splitText(nextSource);
  const newCounts = new Map();
  for (const paragraph of paragraphs) for (const sentence of segmentSentences(paragraph)) {
    newCounts.set(sentence.source, (newCounts.get(sentence.source) || 0) + 1);
  }
  searchFrom = 0;
  const reconciled = paragraphs.map(source => {
    const offset = nextSource.indexOf(source, searchFrom);
    searchFrom = offset + source.length;
    const alignment = segmentSentences(source).map(sentence => {
      const start = offset + sentence.start;
      const end = offset + sentence.end;
      const oldStart = end <= prefix ? start : start >= newEditEnd ? start + delta : undefined;
      let previous = oldStart === undefined ? undefined : oldByPosition.get(`${oldStart}:${oldStart + sentence.source.length}`);
      if (previous?.source !== sentence.source) previous = undefined;
      // Unique unchanged sentences may have moved across paragraph boundaries.
      const candidates = oldByText.get(sentence.source);
      if (!previous && candidates?.length === 1 && newCounts.get(sentence.source) === 1) previous = candidates[0];
      return { ...sentence, translation: previous?.translation || '', ...(!previous ? { pending: true } : {}) };
    });
    const legacy = previousResults.find(item => !item.alignment && item.source === source);
    if (legacy) return { source, translation: legacy.translation };
    return { source, alignment, translation: joinTranslations(source, alignment) };
  });
  return reconciled.some(item => item.translation.trim()) ? reconciled : [];
}
