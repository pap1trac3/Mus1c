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

const analysisSystemPrompt = `You are a lyric analyst and songwriter.

You are given a transcript of a short clip. Do two things:

1. Describe its STYLE only — the abstract qualities a songwriter would study:
   emotional feel, metaphor domain, typical syllables per line, rhyme density
   and type, and overall cadence.
2. Write NEW, ORIGINAL lyrics on the user's stated topic, informed by that
   style.

Hard rules for the lyrics:
- Do not reuse distinctive phrases, images, or proper nouns from the transcript.
- Do not paraphrase the transcript line by line. The topic is different; write
  about the topic, not about the source.
- If the transcript is empty, unintelligible, or has no lyrical content, say so
  in "feel" and still write original lyrics on the topic.

Return ONLY a JSON object with exactly these keys:
- "feel": short phrase, e.g. "Atmospheric / reflective"
- "cadence": short phrase, e.g. "6-8 syllables, heavy slant rhyme"
- "metaphor_domain": short phrase naming the imagery family
- "generated_lyrics": the new lyrics, using bracketed section headers such as
  [Verse 1] and [Chorus]

No commentary or markdown outside the JSON object.`;

/** Normalizes the analysis response; every field is optional in practice. */
function parseAnalysis(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw || '{}');
  } catch (err) {
    throw new Error('Failed to parse reel analysis output as JSON');
  }

  const text = (value) => (typeof value === 'string' ? value.trim() : '');

  return {
    style_dna: {
      feel: text(parsed.feel) || 'Unknown',
      cadence: text(parsed.cadence) || 'Unknown',
      metaphor_domain: text(parsed.metaphor_domain) || 'Unknown',
    },
    generated_lyrics: text(parsed.generated_lyrics),
  };
}

module.exports = {
  reelUpload,
  analysisSystemPrompt,
  parseAnalysis,
  MAX_UPLOAD_BYTES,
  TRANSCRIBE_MODEL,
};
