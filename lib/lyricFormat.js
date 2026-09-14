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

/**
 * Splits a normalized sheet into its sections.
 *
 * A section runs from one header to the next, so lines written before any
 * header still belong somewhere: they are returned as a leading section with
 * a null header, rather than dropped. Reassembling every section's `text` in
 * order reproduces the sheet, which is what lets one section be rewritten and
 * put back without touching the rest.
 */
function splitSections(text) {
  if (typeof text !== 'string' || text.trim() === '') return [];

  const headerAt = new RegExp(`^\\[\\s*(?:${SECTION_WORDS})\\b`, 'i');
  const sections = [];
  let current = null;

  for (const raw of text.split('\n')) {
    const line = raw.trim();

    if (headerAt.test(line)) {
      current = { header: line, name: sectionName(line), lines: [] };
      sections.push(current);
      continue;
    }

    if (!current) {
      // Lines before the first header are still part of the sheet.
      current = { header: null, name: '', lines: [] };
      sections.push(current);
    }
    current.lines.push(line);
  }

  return sections.map((section) => ({
    header: section.header,
    name: section.name,
    // Trailing blanks are separators between sections, not content.
    lines: trimBlankEdges(section.lines),
    text: [section.header, ...trimBlankEdges(section.lines)].filter((part) => part !== null).join('\n'),
  }));
}

/** "[Verse 2]" -> "Verse 2"; used to match a caller's requested section. */
function sectionName(header) {
  return String(header || '').replace(/^\[\s*/, '').replace(/\s*\]$/, '').trim();
}

function trimBlankEdges(lines) {
  const out = [...lines];
  while (out.length && out[0] === '') out.shift();
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

/**
 * Finds one section by name, case-insensitively. Matches the whole name first
 * ("Verse 2"), then falls back to a prefix ("verse" finding "[Verse 1]"), so a
 * caller need not reproduce a header's exact numbering to target it.
 */
function findSection(sections, name) {
  const wanted = String(name || '').trim().toLowerCase();
  if (!wanted) return -1;

  const exact = sections.findIndex((section) => section.name.toLowerCase() === wanted);
  if (exact !== -1) return exact;

  return sections.findIndex((section) => section.name.toLowerCase().startsWith(wanted));
}

/** Puts a rewritten section back, leaving every other section byte-identical. */
function replaceSection(sections, index, replacementText) {
  return sections
    .map((section, i) => (i === index ? String(replacementText || '').trim() : section.text))
    .filter(Boolean)
    .join('\n\n');
}

module.exports = {
  normalizeLyricSheet,
  splitSections,
  findSection,
  replaceSection,
  sectionName,
  LONG_LINE,
};
