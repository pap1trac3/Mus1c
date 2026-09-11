// Scientific pitch notation, e.g. C4, F#3, Bb5.
const NOTE = /^[A-G][#b]?[0-8]$/;
// Tone.js duration notation: 1n/2n/4n/8n/16n/32n, dotted (4n.), or triplet (8t).
const DURATION = /^(1|2|4|8|16|32)n\.?$|^(2|4|8|16|32)t$/;
// Transport position "bar:beat:sixteenth" (sixteenth optional).
const TIME = /^\d{1,3}:\d{1,2}(:\d{1,2})?$/;

const MAX_EVENTS = 64;
const MAX_CHORD_NOTES = 6;
const MIN_BPM = 30;
const MAX_BPM = 300;
const DEFAULT_BPM = 120;

/**
 * Model output drives an audio scheduler in the browser, so it is validated
 * rather than trusted: anything that isn't a well-formed note/duration/time is
 * dropped instead of being handed to Tone.js, and the list is capped so a
 * runaway generation can't schedule thousands of events.
 */
function sanitizeMelody(raw) {
  if (!Array.isArray(raw)) return [];

  const events = [];

  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;

    const { note, duration, time } = item;

    let pitch = null;
    if (typeof note === 'string' && NOTE.test(note)) {
      pitch = note;
    } else if (Array.isArray(note)) {
      const chord = note.filter((n) => typeof n === 'string' && NOTE.test(n)).slice(0, MAX_CHORD_NOTES);
      if (chord.length > 0) pitch = chord;
    }
    if (!pitch) continue;

    if (typeof duration !== 'string' || !DURATION.test(duration)) continue;
    if (typeof time !== 'string' || !TIME.test(time)) continue;

    events.push({ note: pitch, duration, time });
    if (events.length >= MAX_EVENTS) break;
  }

  return events;
}

/**
 * Keeps tempo inside the same bounds the request schema accepts.
 *
 * Deliberately does not lean on Number(): it coerces null, '', false and []
 * to 0, which is finite, so a model that omits tempo_bpm as null would clamp
 * to the 30 BPM floor and play the preview at a crawl instead of defaulting.
 */
function clampTempo(value, fallback = DEFAULT_BPM) {
  let numeric = NaN;
  if (typeof value === 'number') numeric = value;
  else if (typeof value === 'string' && value.trim() !== '') numeric = Number(value);

  const bpm = Math.round(numeric);
  if (!Number.isFinite(bpm)) return fallback;
  return Math.min(MAX_BPM, Math.max(MIN_BPM, bpm));
}

module.exports = { sanitizeMelody, clampTempo, MAX_EVENTS, DEFAULT_BPM };
