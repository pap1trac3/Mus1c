'use strict';

const { slantKey, countLineSyllables, lineWords } = require('./prosody');

// What one call is allowed to return. The model is asked for a handful; these
// bound what a model that ignores the instruction can put on the page.
const MAX_ENTENDRES = 6;
const MAX_CLUSTERS = 4;
const MAX_IMAGES = 6;
const MAX_RHYMES = 10;
const MAX_TEXT = 200;

/**
 * The system prompt carries no caller input — the line being worked on, the
 * sheet around it and the genre all go in the user message, where they are
 * data rather than instructions.
 */
const WORDPLAY_SYSTEM_PROMPT = `You are a lyricist's writing-room partner. You are given one line from a lyric sheet and you propose ways to sharpen it. You do not rewrite the sheet.

You must return ONLY a JSON object with exactly three keys:
- "double_entendres": an array of objects, each { "text": a rewritten version of the line that carries two readings, "plays_on": the word or phrase doing both jobs }. The second reading must be real, not a pun the line does not actually support.
- "metaphor_clusters": an array of objects, each { "domain": a concrete world the line could be written through (e.g. "boxing", "tide charts", "a pawn shop"), "images": an array of short concrete images drawn from that domain that fit what the line is about }. A cluster is useful when its images can carry a whole verse, not one line.
- "rhyme_extensions": an array of objects, each { "phrase": a two-to-four-word phrase that rhymes with the END of the given line, "note": what it opens up }. Multi-syllabic: land two or three syllables together rather than ending on one stressed beat. Slant rhyme is welcome — match the vowel and let the consonant frame drift.

Rules:
- Concrete nouns over abstract ones. A thing you can point at beats a feeling you name.
- Never propose a phrase that rhymes a word with itself.
- Keep every suggestion in the register of the line you were given.
- Propose at most five of each. Fewer good ones beats a full list.

Do not include any commentary, markdown formatting, or text outside the JSON object.`;

function buildWordplayMessages({ line, sheet, genre, theme, tone }) {
  const userPrompt = `Work on this line:
${line}

Genre: ${genre || 'unspecified'}
Theme: ${theme || 'unspecified'}
${tone ? `${tone}\n` : ''}
${sheet ? `The sheet it sits in, for register and continuity only — do not rewrite it:\n${sheet}\n` : ''}
Return the JSON object now.`;

  return [
    { role: 'system', content: WORDPLAY_SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ];
}

/** A model-supplied string, trimmed and bounded, or '' if it was not one. */
function text(value) {
  return typeof value === 'string' ? value.trim().slice(0, MAX_TEXT) : '';
}

/**
 * Parses the model's proposals into the shape the API promises.
 *
 * Everything is shape-checked rather than trusted: a missing key becomes an
 * empty list, and an entry without the text that makes it useful is dropped.
 */
function parseWordplay(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Model did not return valid JSON');
  }

  const list = (value) => (Array.isArray(value) ? value : []);

  const doubleEntendres = list(parsed?.double_entendres)
    .map((entry) => ({ text: text(entry?.text), plays_on: text(entry?.plays_on) }))
    .filter((entry) => entry.text)
    .slice(0, MAX_ENTENDRES);

  const metaphorClusters = list(parsed?.metaphor_clusters)
    .map((entry) => ({
      domain: text(entry?.domain),
      images: list(entry?.images).map(text).filter(Boolean).slice(0, MAX_IMAGES),
    }))
    .filter((entry) => entry.domain && entry.images.length > 0)
    .slice(0, MAX_CLUSTERS);

  const rhymeExtensions = list(parsed?.rhyme_extensions)
    .map((entry) => ({ phrase: text(entry?.phrase), note: text(entry?.note) }))
    .filter((entry) => entry.phrase)
    .slice(0, MAX_RHYMES);

  if (doubleEntendres.length === 0 && metaphorClusters.length === 0 && rhymeExtensions.length === 0) {
    throw new Error('Model returned no usable suggestions');
  }

  return { doubleEntendres, metaphorClusters, rhymeExtensions };
}

/** The word a suggestion has to rhyme with: the last one in the line. */
function rhymeTarget(line) {
  const words = lineWords(line);
  return words.length > 0 ? words[words.length - 1] : '';
}

/**
 * Keeps only the proposals that actually rhyme.
 *
 * The model proposes and the syllable counter decides: language models are
 * unreliable at rhyme in exactly the way that matters here, offering pairs that
 * look like rhymes on the page and are not. slantKey is the same key the rhyme
 * overlay uses, so a suggestion that survives this is one the app would have
 * highlighted had the writer typed it.
 *
 * Repeating the target word back is not a rhyme either, and is the failure a
 * model falls into when it cannot find one.
 */
function verifyRhymes(line, extensions) {
  const target = rhymeTarget(line);
  const targetKey = slantKey(target);

  const kept = [];
  let dropped = 0;

  for (const extension of extensions) {
    const last = rhymeTarget(extension.phrase);
    const rhymes = Boolean(targetKey) && slantKey(last) === targetKey;
    const repeats = last.toLowerCase() === target.toLowerCase();

    if (!rhymes || repeats) {
      dropped += 1;
      continue;
    }

    kept.push({
      phrase: extension.phrase,
      note: extension.note,
      syllables: countLineSyllables(extension.phrase),
    });
  }

  return { kept, dropped, target };
}

module.exports = {
  WORDPLAY_SYSTEM_PROMPT,
  buildWordplayMessages,
  parseWordplay,
  verifyRhymes,
  rhymeTarget,
};
