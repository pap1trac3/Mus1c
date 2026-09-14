'use strict';

/**
 * Export formats for taking a sheet into the booth.
 *
 * Everything here is pure: it turns a generation result into rows, text or CSV
 * and touches no DOM, so the formats can be tested without a browser. The page
 * renders the same row model for the printable sheet.
 */

/** Seconds as m:ss, so a marker time reads the way a DAW displays it. */
function formatClock(seconds) {
  const whole = Math.floor(seconds);
  const mins = Math.floor(whole / 60);
  const secs = whole % 60;
  return mins + ':' + String(secs).padStart(2, '0');
}

/** Quotes one CSV field: doubles inner quotes and wraps when it has to. */
function csvField(value) {
  const text = String(value == null ? '' : value);
  return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

/**
 * Bar markers as CSV. Generic on purpose — DAWs disagree on marker import
 * formats, so this is name/position/bar columns a user can map, not a claim
 * that any particular DAW imports it untouched.
 */
function buildMarkerCsv(result) {
  const grid = (result && result.bar_grid) || { rows: [] };
  const header = ['name', 'start_seconds', 'start_bar', 'end_bar', 'syllables'];
  const rows = grid.rows.map((row) =>
    [row.line, row.start_seconds == null ? '' : row.start_seconds, row.start_bar, row.end_bar, row.syllables]
      .map(csvField)
      .join(',')
  );
  return [header.join(','), ...rows].join('\n') + '\n';
}

/**
 * The marker row that sits under a lyric line.
 *
 * A digit is the beat that word lands on; "·" means the beat falls inside the
 * word rather than at its start. Two beats inside one word would collide on the
 * same column, so the second is nudged one place right — still inside the word,
 * and honest about there being two.
 */
function beatMarkerRow(beats) {
  let row = '';

  for (const beat of beats || []) {
    const column = Math.max(beat.column, row.length);
    row = row.padEnd(column) + (beat.on_word_start ? String(beat.beat) : '·');
  }

  return row;
}

/**
 * The sheet as rows: its own section headers and blank lines, each sung line
 * paired with the bar grid row that measured it.
 *
 * Paired by walking both in order and matching on the line's text rather than
 * by re-deciding what a section header is — the grid already made that call
 * server-side, where the syllable counter lives.
 */
function recordingSheetRows(result) {
  const sheet = (result && result.structured_lyrics) || '';
  const pending = [...(((result && result.bar_grid) || {}).rows || [])];

  return sheet.split('\n').map((line) => {
    const text = line.trim();
    if (!text) return { type: 'blank', text: '' };

    if (pending.length > 0 && pending[0].line === text) {
      return { type: 'line', text, row: pending.shift() };
    }
    return { type: 'header', text };
  });
}

/** One line's annotation: where it sits and how dense it is. */
function annotateRow(row) {
  const bars = row.start_bar === row.end_bar ? 'Bar ' + row.start_bar : 'Bars ' + row.start_bar + '-' + row.end_bar;
  const parts = [bars, row.syllables + ' syll.'];
  if (row.start_seconds != null) parts.push(formatClock(row.start_seconds));
  return parts.join(' · ');
}

/** The measured mechanics of the sheet, as one line for the header block. */
function describeSheetProsody(prosody) {
  if (!prosody || typeof prosody.syllables_per_line?.avg !== 'number') return '';

  const { avg, min, max } = prosody.syllables_per_line;
  const parts = [avg + ' syllables per line (' + min + '-' + max + ')'];
  // "unknown" is the analyser saying it could not name a shape — not a fact
  // about the sheet worth printing on it.
  if (prosody.rhyme_scheme && prosody.rhyme_scheme !== 'unknown') {
    parts.push('rhyme ' + prosody.rhyme_scheme);
  }
  if (typeof prosody.internal_rhyme_density === 'number') {
    parts.push('internal rhyme ' + prosody.internal_rhyme_density);
  }
  return parts.join(' · ');
}

const MARKER_LEGEND =
  'Beat markers sit under the lyric: a digit is the beat that word lands on, "·" means the ' +
  'beat falls inside the word. Bars and beats are estimated from syllable count at the stated ' +
  'tempo, not transcribed from audio.';

/**
 * A tracking sheet as plain text: the lyric, annotated in place, with a beat
 * marker row under every line.
 *
 * Monospaced by assumption — the marker row is aligned by column, so it only
 * lines up in a fixed-width font. That is what a notes app, a DAW comment field
 * and a printed page all give you.
 */
function buildRecordingSheetText(result) {
  const grid = (result && result.bar_grid) || { rows: [], bpm: null, total_bars: 0 };
  const out = ['MOZART — RECORDING SHEET'];

  const heading = [];
  if (grid.bpm) heading.push(grid.bpm + ' BPM');
  if (grid.beats_per_bar) heading.push(grid.beats_per_bar + '/4');
  if (grid.total_bars) heading.push(grid.total_bars + ' bars');
  if (heading.length > 0) out.push(heading.join(' · '));

  const mechanics = describeSheetProsody(result && result.prosody);
  if (mechanics) out.push(mechanics);
  if (result && result.style_prompt) out.push('Style: ' + result.style_prompt);

  out.push('', MARKER_LEGEND, '');

  for (const entry of recordingSheetRows(result)) {
    if (entry.type === 'blank') {
      out.push('');
    } else if (entry.type === 'header') {
      out.push(entry.text);
    } else {
      out.push('  ' + annotateRow(entry.row));
      out.push('  ' + entry.text);
      const markers = beatMarkerRow(entry.row.beats);
      if (markers.trim()) out.push('  ' + markers);
      // Each line is three rows tall now; without a gap a verse reads as one
      // block of digits.
      out.push('');
    }
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

if (typeof window !== 'undefined') {
  window.formatClock = formatClock;
  window.csvField = csvField;
  window.buildMarkerCsv = buildMarkerCsv;
  window.beatMarkerRow = beatMarkerRow;
  window.recordingSheetRows = recordingSheetRows;
  window.annotateRow = annotateRow;
  window.buildRecordingSheetText = buildRecordingSheetText;
  window.MARKER_LEGEND = MARKER_LEGEND;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    formatClock,
    csvField,
    buildMarkerCsv,
    beatMarkerRow,
    recordingSheetRows,
    annotateRow,
    describeSheetProsody,
    buildRecordingSheetText,
    MARKER_LEGEND,
  };
}
