const { z } = require('zod');

// HTML forms submit blank fields as empty strings; coercing those would turn
// "" into 0 and trip the numeric bounds, so treat blank as "not provided".
const blank = (schema) =>
  z.preprocess((value) => (value === '' || value === null ? undefined : value), schema);

const optionalText = blank(z.string().trim().min(1).optional());

const TRANSCRIPT_REQUIRED = 'transcript is required and must be a non-empty string';
const GENRE_OR_THEME_REQUIRED = 'At least one of "genre" or "theme" is required';
const TAGS_MUST_BE_ARRAY = 'tags must be an array of strings';

// Bounds match styleMemory's MAX_TAGS / MAX_TAG_CHARS: reject oversized input
// at the edge rather than silently truncating it to something the caller
// never asked for. Canonical form (lowercase, deduped) is applied after this.
const tagList = z
  .array(z.string({ error: TAGS_MUST_BE_ARRAY }).trim().min(1).max(40), { error: TAGS_MUST_BE_ARRAY })
  .max(12, 'tags must contain 12 entries or fewer');

const ingestSchema = z.object({
  // `error` also covers the invalid_type case, so a missing transcript reports
  // this message rather than Zod's generic "expected string, received undefined".
  transcript: z.string({ error: TRANSCRIPT_REQUIRED }).trim().min(1, TRANSCRIPT_REQUIRED),
  // looseObject: callers attach arbitrary metadata that gets stored alongside
  // each chunk, and a strict object would silently strip those keys.
  metadata: z.looseObject({ document_id: optionalText }).optional(),
});

// Profile ids are opaque document ids, not free text: bounded so a malformed
// id cannot become an unbounded filter value.
const profileId = blank(z.string().trim().min(1).max(200).optional());

/**
 * An explicit rhyme/meter target, saved as a preset in the editor.
 *
 * Every field is optional: a preset that only pins the rhyme scheme is a
 * legitimate preset, and the fields left out fall back to whatever the
 * retrieved profiles measured.
 */
const schemeSpec = z
  .object({
    rhyme_scheme: blank(z.string().trim().min(1).max(16).optional()),
    syllables_avg: blank(z.coerce.number().int().min(1).max(40).optional()),
    syllables_min: blank(z.coerce.number().int().min(1).max(40).optional()),
    syllables_max: blank(z.coerce.number().int().min(1).max(40).optional()),
    internal_rhyme_density: blank(z.coerce.number().min(0).max(1).optional()),
  })
  .optional()
  .superRefine((value, ctx) => {
    if (!value) return;
    const { syllables_min: min, syllables_max: max } = value;
    if (typeof min === 'number' && typeof max === 'number' && min > max) {
      ctx.addIssue({
        code: 'custom',
        message: 'syllables_min must not exceed syllables_max',
        path: ['syllables_min'],
      });
    }
  });

/** How the lyrics should police their own language. See lib/tone.js. */
const toneMode = blank(z.enum(['raw', 'radio', 'sync']).optional());

const generateSchema = z
  .object({
    genre: optionalText,
    theme: optionalText,
    key: optionalText,
    vocal_timbre: optionalText,
    acoustics: optionalText,
    bpm: blank(z.coerce.number().int().min(30).max(300).optional()),
    retrieval_limit: blank(z.coerce.number().int().min(1).max(20).optional()),
    // Omitted or empty means "draw on the whole vault" — the behaviour before
    // tagging existed, and the behaviour the UI falls back to on a blank field.
    tags: tagList.optional(),
    // A field-level blend: one profile supplies the rhythmic target, another
    // the imagery. Either may be given alone.
    cadence_profile_id: profileId,
    imagery_profile_id: profileId,
    tone: toneMode,
    scheme: schemeSpec,
    stream: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.genre && !value.theme) {
      ctx.addIssue({ code: 'custom', message: GENRE_OR_THEME_REQUIRED, path: [] });
    }
  });

const REFERENCE_TEXT_REQUIRED = 'reference_text is required and must be a non-empty string';

// Long enough for a full lyric sheet, bounded so one request cannot hand the
// analyzer an entire book.
const MAX_REFERENCE_TEXT = 12000;

const trainStyleSchema = z.object({
  reference_text: z
    .string({ error: REFERENCE_TEXT_REQUIRED })
    .trim()
    .min(1, REFERENCE_TEXT_REQUIRED)
    .max(MAX_REFERENCE_TEXT, `reference_text must be ${MAX_REFERENCE_TEXT} characters or fewer`),
  title: blank(z.string().trim().min(1).max(120).optional()),
});

/**
 * Validates req.body against a schema, replacing it with the parsed result so
 * handlers receive trimmed strings and coerced numbers. Failures return 400 in
 * the same `{ error }` shape the rest of the API uses, with per-field `details`.
 */
function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body || {});

    if (!result.success) {
      return res.status(400).json({
        error: result.error.issues[0].message,
        details: result.error.issues.map((issue) => ({
          field: issue.path.join('.') || null,
          message: issue.message,
        })),
      });
    }

    req.body = result.data;
    next();
  };
}

const profileTagsSchema = z.object({ tags: tagList });

const SECTION_REQUIRED = 'section is required and must name a section of the sheet';
const SHEET_REQUIRED = 'lyrics is required and must be a non-empty lyric sheet';

// One sheet, not a library: bounds what one rewrite costs.
const MAX_SHEET_CHARS = 20000;

const sectionSchema = z.object({
  lyrics: z
    .string({ error: SHEET_REQUIRED })
    .trim()
    .min(1, SHEET_REQUIRED)
    .max(MAX_SHEET_CHARS, `lyrics must be ${MAX_SHEET_CHARS} characters or fewer`),
  section: z.string({ error: SECTION_REQUIRED }).trim().min(1, SECTION_REQUIRED).max(80),
  // What the rewrite should do differently. Optional: "write it again" is a
  // legitimate request on its own.
  direction: blank(z.string().trim().min(1).max(600).optional()),
  genre: optionalText,
  theme: optionalText,
  bpm: blank(z.coerce.number().int().min(30).max(300).optional()),
  cadence_profile_id: profileId,
  imagery_profile_id: profileId,
  tone: toneMode,
  scheme: schemeSpec,
});

const WORDPLAY_LINE_REQUIRED = 'line is required and must be the lyric line to work on';

// One line, not a verse: the suggestions are about a single line's turn of
// phrase, and a paragraph pasted in here would get a paragraph's worth of
// unfocused answers.
const MAX_WORDPLAY_LINE = 300;

const wordplaySchema = z.object({
  line: z
    .string({ error: WORDPLAY_LINE_REQUIRED })
    .trim()
    .min(1, WORDPLAY_LINE_REQUIRED)
    .max(MAX_WORDPLAY_LINE, `line must be ${MAX_WORDPLAY_LINE} characters or fewer`),
  // The sheet the line sits in, for register and continuity. Optional: working
  // on a line in isolation is a legitimate request.
  sheet: blank(z.string().trim().min(1).max(MAX_SHEET_CHARS).optional()),
  genre: optionalText,
  theme: optionalText,
  tone: toneMode,
});

module.exports = {
  ingestSchema,
  generateSchema,
  trainStyleSchema,
  profileTagsSchema,
  sectionSchema,
  wordplaySchema,
  validateBody,
  MAX_REFERENCE_TEXT,
  MAX_WORDPLAY_LINE,
};
