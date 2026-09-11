/**
 * Transcription tuning for the reel analyzer.
 *
 * A reel is close to the worst case for speech-to-text: vocals are sung or
 * rapped rather than spoken, they sit on top of a backing track, and they are
 * usually compressed and reverbed. The original call passed only `file` and
 * `model`, leaving every accuracy lever the API offers unused. This module
 * supplies them — and, because the levers are not uniform across models,
 * sends each one only to a model documented to accept it. An unsupported
 * parameter is a 400 from the API, which would take the whole feature down.
 */

/**
 * Per-model parameter support, from the SDK's own documentation of
 * `TranscriptionCreateParams`. Anything not listed here (a fine-tune, a model
 * released after this was written) falls back to CONSERVATIVE below.
 */
const MODEL_CAPABILITIES = {
  'gpt-transcribe': {
    prompt: true, language: true, keywords: true, chunking: true, temperature: true,
  },
  'gpt-4o-transcribe': {
    prompt: true, language: true, keywords: false, chunking: true, temperature: true,
  },
  'gpt-4o-mini-transcribe': {
    prompt: true, language: true, keywords: false, chunking: true, temperature: true,
  },
  'gpt-4o-mini-transcribe-2025-12-15': {
    prompt: true, language: true, keywords: false, chunking: true, temperature: true,
  },
  'whisper-1': {
    prompt: true, language: true, keywords: false, chunking: false, temperature: true,
  },
  // `prompt` is explicitly not supported by the diarizing model.
  'gpt-4o-transcribe-diarize': {
    prompt: false, language: true, keywords: false, chunking: true, temperature: true,
  },
};

/** What an unrecognized model gets: only the parameters every model has taken. */
const CONSERVATIVE = {
  prompt: true, language: true, keywords: false, chunking: false, temperature: true,
};

function capabilitiesFor(model) {
  return MODEL_CAPABILITIES[model] || CONSERVATIVE;
}

/**
 * Biases decoding toward song lyrics instead of conversational speech. The
 * API treats `prompt` as a stylistic continuation, so this reads as the kind
 * of text we want out rather than as an instruction.
 */
const LYRIC_BIAS_PROMPT =
  'A transcript of song lyrics. Sung and rapped vocals over a backing track, ' +
  'including ad-libs and repeated hooks. Written as plain lines, one lyric line ' +
  'per line, with slang and contractions kept as sung.';

const MAX_KEYWORDS = 24;
const MAX_KEYWORD_CHARS = 60;
// ISO-639-1 is two letters; the API accepts that form.
const LANGUAGE_PATTERN = /^[a-z]{2}$/i;

/**
 * Checks a code against the real ISO registry rather than a hand-kept list:
 * with fallback 'none', DisplayNames returns undefined for a code it does not
 * know. Guarded because a Node build without full ICU would throw, and losing
 * the hint is a far better outcome than a 400 that takes the request down.
 */
let languageNames = null;
try {
  languageNames = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' });
} catch (err) {
  languageNames = null;
}

function isRealLanguage(code) {
  if (!languageNames) return true; // shape check already passed; let the API judge
  try {
    return languageNames.of(code) !== undefined;
  } catch (err) {
    return false;
  }
}

/**
 * Splits a caller's free-text hint ("names, slang, ad-libs") into keywords.
 * Commas and newlines separate; whitespace inside an entry is kept, since a
 * multi-word phrase is a legitimate hint.
 */
function parseKeywords(raw) {
  if (typeof raw !== 'string') return [];
  return raw
    .split(/[,\n]/)
    .map((word) => word.trim().slice(0, MAX_KEYWORD_CHARS))
    .filter(Boolean)
    .slice(0, MAX_KEYWORDS);
}

function normalizeLanguage(raw) {
  if (typeof raw !== 'string') return '';
  const code = raw.trim().toLowerCase();
  if (!LANGUAGE_PATTERN.test(code)) return '';
  return isRealLanguage(code) ? code : '';
}

/**
 * Builds the transcription request.
 *
 * `chunking_strategy: 'auto'` is the one that matters most for music: left
 * unset, the API transcribes the clip as a single block, while 'auto' first
 * normalizes loudness and then picks boundaries by voice activity — which is
 * exactly the problem a vocal buried under a beat presents. Set
 * TRANSCRIBE_CHUNKING=off to compare.
 *
 * `temperature: 0` is not "be deterministic" here: at 0 the API escalates
 * temperature on its own using log probabilities when decoding gets stuck,
 * which is the documented best default rather than a fixed low setting.
 */
function buildTranscriptionParams({ file, model, language, keywords, chunkingDisabled = false }) {
  const supports = capabilitiesFor(model);
  const params = { file, model };

  if (supports.temperature) params.temperature = 0;
  if (supports.prompt) params.prompt = LYRIC_BIAS_PROMPT;

  // Pinning the language is documented to improve both accuracy and latency,
  // and auto-detection is least reliable on exactly this kind of audio.
  const normalized = normalizeLanguage(language);
  if (supports.language && normalized) params.language = normalized;

  // Proper nouns, slang and ad-libs are what transcription gets wrong first,
  // and the uploader is the one who knows them.
  if (supports.keywords && Array.isArray(keywords) && keywords.length > 0) {
    params.keywords = keywords;
  }

  if (supports.chunking && !chunkingDisabled) params.chunking_strategy = 'auto';

  return params;
}

// Rough floor for sung/rapped vocals. Conversational speech runs far higher;
// this is deliberately low so that only a transcript that is nearly empty for
// the length of audio trips it, rather than merely sparse lyrics.
const MIN_CHARS_PER_SECOND = 1.2;
// Below this there is too little audio for the rate to mean anything.
const MIN_ASSESSABLE_SECONDS = 5;
// Floor that needs no duration at all. This one is about the analysis rather
// than the audio: cadence, rhyme density and metaphor domains cannot be read
// off a couple of words, however long the clip was. Roughly two lyric lines.
const MIN_ANALYZABLE_CHARS = 80;

/**
 * Judges whether a transcript plausibly captured the vocal, without ever
 * looking at the words themselves.
 *
 * The obvious confidence signal — `include: ['logprobs']` — is documented as
 * working only with `gpt-4o-transcribe` and the mini models, not the default
 * `gpt-transcribe`, so it cannot be relied on here. Yield against the clip's
 * real duration is available for every model and catches the failure that
 * actually happens: the model hears the instrumental, returns a line or two,
 * and the analysis downstream is built on nothing.
 *
 * Duration comes from the browser, which reads it off the decoded media
 * element. It is a hint, not a measurement: when it is absent or implausible
 * the verdict is 'unknown' rather than a guess.
 */
function assessTranscriptQuality({ transcriptChars, durationSeconds }) {
  if (transcriptChars === 0) {
    return {
      verdict: 'empty',
      note: 'No speech or vocals were detected in the clip.',
    };
  }

  // Checked before the rate, and without a duration, so the gate still works
  // when the browser can't decode the clip and sends no length.
  if (transcriptChars < MIN_ANALYZABLE_CHARS) {
    return {
      verdict: 'low',
      note:
        'Only ' + transcriptChars + ' characters came back — too little to read a ' +
        'cadence or rhyme scheme from, so the style below is mostly guesswork. ' +
        'Vocals mixed under a loud beat are the usual cause: try a section with a ' +
        'clearer vocal, name the language, or paste the lyrics instead.',
    };
  }

  const usable =
    typeof durationSeconds === 'number' &&
    Number.isFinite(durationSeconds) &&
    durationSeconds >= MIN_ASSESSABLE_SECONDS;

  if (!usable) return { verdict: 'unknown', note: '' };

  const rate = transcriptChars / durationSeconds;
  if (rate < MIN_CHARS_PER_SECOND) {
    return {
      verdict: 'low',
      note:
        'Very little was transcribed for the length of this clip, so the style ' +
        'below may not reflect it. Vocals mixed under a loud beat are the usual ' +
        'cause — try a section with a clearer vocal, name the language, or paste ' +
        'the lyrics instead.',
    };
  }

  return { verdict: 'ok', note: '' };
}

module.exports = {
  buildTranscriptionParams,
  assessTranscriptQuality,
  capabilitiesFor,
  parseKeywords,
  normalizeLanguage,
  LYRIC_BIAS_PROMPT,
  MAX_KEYWORDS,
  MIN_CHARS_PER_SECOND,
  MIN_ANALYZABLE_CHARS,
};
