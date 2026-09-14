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

module.exports = {
  ingestSchema,
  generateSchema,
  trainStyleSchema,
  profileTagsSchema,
  validateBody,
  MAX_REFERENCE_TEXT,
};
