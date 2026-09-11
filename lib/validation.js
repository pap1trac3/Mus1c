const { z } = require('zod');

// HTML forms submit blank fields as empty strings; coercing those would turn
// "" into 0 and trip the numeric bounds, so treat blank as "not provided".
const blank = (schema) =>
  z.preprocess((value) => (value === '' || value === null ? undefined : value), schema);

const optionalText = blank(z.string().trim().min(1).optional());

const TRANSCRIPT_REQUIRED = 'transcript is required and must be a non-empty string';
const GENRE_OR_THEME_REQUIRED = 'At least one of "genre" or "theme" is required';

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
    stream: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.genre && !value.theme) {
      ctx.addIssue({ code: 'custom', message: GENRE_OR_THEME_REQUIRED, path: [] });
    }
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

module.exports = { ingestSchema, generateSchema, validateBody };
