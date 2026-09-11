const multer = require('multer');

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
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 4 },
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
   - CADENCE MATCHING: match the line meter, rhythm transitions and rhyme
     placement of the original delivery.
   - FIGURATIVE MATCHING: use the same TYPE and DENSITY of metaphor. If the
     original uses physical temperature to stand for emotional distance, reach
     for a comparable abstract physical domain rather than reusing that image.

3. If the transcript is empty, unintelligible, or has no lyrical content, say
   so in "feel" and still write original lyrics on the requested topic.

### OUTPUT
Respond with a valid JSON object and nothing else — no markdown fence, no
preamble:

{
  "feel": "punchy description of the emotional vibe, e.g. 'Atmospheric / late-night reflective'",
  "cadence": "meter and rhyme structure, e.g. '6-8 syllables per line, heavy internal slant rhymes'",
  "metaphor_domains": ["domain 1", "domain 2"],
  "generated_lyrics": "[Verse 1]\\nLine...\\n\\n[Chorus]\\nLine..."
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

  return {
    style_dna: {
      feel: text(parsed.feel) || 'Unknown',
      cadence: text(parsed.cadence) || 'Unknown',
      metaphor_domains: domains,
    },
    generated_lyrics: text(parsed.generated_lyrics ?? parsed.generatedLyrics),
  };
}

module.exports = {
  reelUpload,
  analysisSystemPrompt,
  parseAnalysis,
  MAX_UPLOAD_BYTES,
  TRANSCRIBE_MODEL,
  MAX_DOMAINS,
};
