const multer = require('multer');
const { normalizeLyricSheet } = require('./lyricFormat');

// The transcription API rejects anything over 25MB, so refuse it here rather
// than spending the upload and the round-trip to find out.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

// Formats the transcription API accepts. Checked server-side because the
// HTML `accept` attribute is a file-picker hint, not a control.
const ALLOWED_MIME = new Set([
  'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/m4a',
  'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/webm',
  'video/mp4', 'video/mpeg', 'video/webm',
]);
const ALLOWED_EXT = /\.(mp3|mp4|mpeg|mpga|m4a|wav|webm)$/i;

const MAX_DOMAINS = 6;

const TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-transcribe';

/**
 * In-memory upload: the buffer goes straight to the transcription API and is
 * never written to disk, so there is no upload directory to provision, secure,
 * or clean up — and the runtime image stays read-only-friendly.
 */
const reelUpload = multer({
  storage: multer.memoryStorage(),
  // topic, remember, language, keywords, duration_seconds, reference_lyrics,
  // plus headroom. A field cap still matters: it bounds a multipart flood.
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10 },
  fileFilter: (req, file, cb) => {
    const okMime = ALLOWED_MIME.has((file.mimetype || '').toLowerCase());
    const okExt = ALLOWED_EXT.test(file.originalname || '');
    if (okMime || okExt) return cb(null, true);
    cb(Object.assign(new Error('Unsupported file type'), { code: 'UNSUPPORTED_MEDIA' }));
  },
}).single('reel');

/**
 * Static by design. The caller's topic is passed in the user message rather
 * than interpolated in here: the system prompt is the highest-trust position,
 * so injecting untrusted text into it is what lets "ignore previous
 * instructions" actually land. Interpolation via String.replace would also
 * corrupt the prompt outright — `$&`, `` $` `` and `$'` are substitution
 * patterns in the replacement string.
 */
const analysisSystemPrompt = `You are an expert lyricist, musicologist, and audio analyst embedded in Mozart Tool. You deconstruct the stylistic DNA of a short clip and write brand-new, completely original lyrics that adopt its flow, cadence and metaphor density without plagiarizing a single line.

### INPUT
The user message contains a TRANSCRIPT of the clip (already transcribed; you
do not receive the audio itself) and the REQUESTED TOPIC for the new lyrics.

### INSTRUCTIONS

1. ANALYZE the transcript:
   - Feel & emotional vibe: the underlying mood (late-night reflective,
     aggressive, atmospheric, triumphant, and so on).
   - Metaphor & imagery domains: the core visual categories in play
     (weather/rain, urban isolation, physical temperature, digital noise...).
   - Cadence & structure: line lengths, average syllables per bar, rhyme
     density (end rhymes, internal rhymes, slant rhymes), and hook/verse
     dynamics.

2. GENERATE original lyrics on the requested topic:
   - STRICT ORIGINALITY: do NOT copy or reuse specific phrases, distinct
     nouns, or exact word pairings from the transcript. Write about the
     requested topic, not about the clip — this is not a paraphrase.
   - NO LINE-FOR-LINE MIRRORING: do NOT walk the transcript line by line
     swapping each image for an equivalent. Writing "rain on the windshield,
     counting the exits" as "dust on the canvas, sketching my visions" is a
     find-and-replace, not a new song — the borrowed sentence frame makes it
     a derivative work even though no word is shared. Never let the source's
     line count, clause order, or stanza layout dictate yours.
   - RHYTHMIC ARCHETYPE, NOT METER COPYING: carry over the delivery's overall
     character — where it sits between conversational and syncopated, whether
     it runs double-time or leans back, whether rhymes cluster inside the bar
     or land on the ends, how the hook contrasts with the verse. Name that
     archetype in "cadence". Do NOT reproduce specific line lengths or the
     position of individual rhymes.
   - FIGURATIVE SYNTHESIS: take the metaphor DOMAINS as raw material and
     invent fresh imagery for the requested topic out of them. Reach for a
     comparable abstract domain rather than reusing the source's images, and
     let the topic — not the transcript — decide which images the song needs.
   - ORIGINAL STRUCTURE: choose your own section plan and vary line lengths,
     bar counts and rhyme placement to suit the topic. Expand or compress
     relative to the source wherever the song is better for it.

3. If the transcript is empty, unintelligible, or has no lyrical content, say
   so in "feel" and still write original lyrics on the requested topic.

### OUTPUT
Respond with a valid JSON object and nothing else — no markdown fence, no
preamble:

{
  "feel": "punchy description of the emotional vibe, e.g. 'Atmospheric / late-night reflective'",
  "cadence": "the rhythmic archetype, e.g. 'relaxed conversational 16ths, rhymes clustered mid-bar, hook drops to half-time'",
  "metaphor_domains": ["domain 1", "domain 2"],
  "generated_lyrics": "[Verse 1]\\nLine...\\n\\n[Chorus]\\nLine..."
}

"generated_lyrics" is a single string carrying its own line breaks:
- Every lyric line ends with \\n. Never run several lines together into one
  long line — a verse packed onto one line is unusable as a lyric sheet.
- Every section opens with a bracketed header on its own line, e.g.
  [Verse 1], [Pre-Chorus], [Chorus], [Bridge], [Outro].
- Sections are separated by a blank line, i.e. \\n\\n.`;

/**
 * Analysis only — no lyric generation. Used when the caller is training the
 * vault rather than asking for a song, so there is no topic and nothing to
 * write. Static for the same reason as the reel prompt: the reference text is
 * untrusted input and belongs in the user turn, never the operator turn.
 *
 * The reference text itself is never stored; only this derived blueprint is.
 */
const styleOnlySystemPrompt = `You are Mozart Tool's style and rhythmic analyst. You read a piece of reference writing — lyrics, a verse, a poem — and extract its stylistic blueprint. You do not write lyrics here.

### INPUT
The user message contains REFERENCE TEXT, and optionally a title for it.

### EXTRACT
1. Feel: the underlying mood and atmosphere (dark and reflective, triumphant,
   late-night conversational, and so on).
2. Cadence: the rhythmic archetype — where the delivery sits between
   conversational and syncopated, whether it runs double-time or leans back,
   whether rhymes cluster inside the bar or land on the ends, how a hook would
   contrast with a verse. Describe the archetype, not specific line lengths.
3. Metaphor domains: 3-6 imagery categories the writing draws on (weather,
   urban isolation, celestial, industrial, physical temperature...).
4. Literary devices: the dominant techniques (slant rhyme, internal rhyme,
   heavy alliteration, abstract simile, anaphora...).

Describe the style in the abstract. Do NOT quote the reference text, and do
NOT reproduce its distinctive phrases or proper nouns in any field — this
blueprint is stored and reused, and the reference itself is not.

### OUTPUT
Respond with a valid JSON object and nothing else — no markdown fence, no
preamble:

{
  "feel": "e.g. 'Dark, reflective, quietly defiant'",
  "cadence": "e.g. 'Conversational 16ths with double-time bursts, rhymes clustered mid-bar'",
  "metaphor_domains": ["domain 1", "domain 2"],
  "literary_devices": ["device 1", "device 2"],
  "summary": "one or two sentences on the overall artistic vibe"
}`;

/** Normalizes the analysis response; every field is optional in practice. */
function parseAnalysis(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw || '{}');
  } catch (err) {
    throw new Error('Failed to parse reel analysis output as JSON');
  }

  const text = (value) => (typeof value === 'string' ? value.trim() : '');

  // Accept either casing: the schema asks for snake_case to match this API,
  // but models drift toward camelCase and a silent [] is worse than tolerance.
  const rawDomains = parsed.metaphor_domains ?? parsed.metaphorDomains;
  const domains = (Array.isArray(rawDomains) ? rawDomains : [rawDomains])
    .map(text)
    .filter(Boolean)
    .slice(0, MAX_DOMAINS)
    .map((domain) => domain.slice(0, 60));

  const rawDevices = parsed.literary_devices ?? parsed.literaryDevices;
  const devices = (Array.isArray(rawDevices) ? rawDevices : [rawDevices])
    .map(text)
    .filter(Boolean)
    .slice(0, MAX_DOMAINS)
    .map((device) => device.slice(0, 60));

  return {
    style_dna: {
      feel: text(parsed.feel) || 'Unknown',
      cadence: text(parsed.cadence) || 'Unknown',
      metaphor_domains: domains,
      literary_devices: devices,
    },
    summary: text(parsed.summary),
    // The prompt asks for one line per lyric line; this guarantees it, because
    // compliance is not reliable enough for something the UI depends on.
    generated_lyrics: normalizeLyricSheet(text(parsed.generated_lyrics ?? parsed.generatedLyrics)),
  };
}

module.exports = {
  reelUpload,
  analysisSystemPrompt,
  styleOnlySystemPrompt,
  parseAnalysis,
  MAX_UPLOAD_BYTES,
  TRANSCRIBE_MODEL,
  MAX_DOMAINS,
};
