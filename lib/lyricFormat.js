/**
 * Deterministic lyric-sheet formatting.
 *
 * Both prompts ask for one lyric line per line, and both models comply most
 * of the time — but not reliably: sampled at the temperature this app uses,
 * a verse still comes back packed onto a single 160-character line often
 * enough to matter. A lyric sheet that renders as a paragraph is unusable,
 * and "ask the model again, more firmly" is not a fix for an invariant the
 * UI depends on. So the prompt asks, and this enforces.
 *
 * Deliberately conservative: output that already has line breaks passes
 * through untouched, and nothing is split unless the line is long enough
 * that it cannot be a single sung line.
 */

// Section headers get their own line; inline performance tags
// ([whispered], [soft female vocal]) must not, so only this vocabulary counts.
const SECTION_WORDS =
  'intro|verse|pre[- ]?chorus|chorus|post[- ]?chorus|hook|refrain|bridge|breakdown|drop|interlude|outro|ad[- ]?lib[s]?|coda|tag';
const SECTION_HEADER = new RegExp(`\\[\\s*(?:${SECTION_WORDS})\\b[^\\]]*\\]`, 'gi');

// Below this a long line is plausibly one sung phrase; above it, it is prose.
const LONG_LINE = 90;

/**
 * Splits on sentence ends, and on the ellipses this app's prompts use as
 * micro-pauses — but only where a new phrase clearly begins, so a mid-line
 * "..." breath does not become a line break.
 */
function splitPackedLine(line) {
  return line
    .replace(/([.!?])\s+(?=["'(\[]?[A-Z])/g, '$1\n')
    .replace(/(\.{3}|…)\s+(?=[A-Z])/g, '$1\n')
    .split('\n')
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Normalizes a lyric sheet: section headers on their own line, sections
 * separated by a blank line, and packed verses broken into lines.
 */
function normalizeLyricSheet(text) {
  if (typeof text !== 'string' || text.trim() === '') return '';

  // 1. Break before and after any section header, wherever it sits.
  const withHeaders = text.replace(SECTION_HEADER, (header) => `\n${header.trim()}\n`);

  // 2. Split any remaining packed line, leaving short lines alone.
  const lines = [];
  for (const raw of withHeaders.split('\n')) {
    const line = raw.trim();
    if (line === '') {
      lines.push('');
      continue;
    }
    if (line.length > LONG_LINE) {
      lines.push(...splitPackedLine(line));
    } else {
      lines.push(line);
    }
  }

  // 3. One blank line before each header, never after it, none at the very
  //    top, and never two blank lines in a row.
  const headerAt = new RegExp(`^\\[\\s*(?:${SECTION_WORDS})\\b`, 'i');
  const out = [];
  let lastWasHeader = false;

  for (const line of lines) {
    if (line === '') {
      // A section header is followed immediately by its first lyric line.
      if (lastWasHeader) continue;
      if (out.length > 0 && out[out.length - 1] !== '') out.push('');
      continue;
    }

    const isHeader = headerAt.test(line);
    if (isHeader && out.length > 0 && out[out.length - 1] !== '') out.push('');
    out.push(line);
    lastWasHeader = isHeader;
  }

  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

module.exports = { normalizeLyricSheet, LONG_LINE };
