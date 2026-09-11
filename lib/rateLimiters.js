const { rateLimit } = require('express-rate-limit');

const WINDOW_MS = 15 * 60 * 1000;

// Evaluated per request, so tests can opt back in by flipping NODE_ENV.
const skipWhenTesting = () => process.env.NODE_ENV === 'test';

const baseOptions = {
  windowMs: WINDOW_MS,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: skipWhenTesting,
};

/** Broad ceiling for all /api traffic. */
const apiLimiter = rateLimit({
  ...baseOptions,
  max: 100,
  message: { error: 'Too many requests, please try again later.' },
});

/** Tighter ceiling for the endpoints that spend OpenAI credits. */
const strictLimiter = rateLimit({
  ...baseOptions,
  max: 20,
  message: { error: 'Too many generation requests, please try again later.' },
});

module.exports = { apiLimiter, strictLimiter, WINDOW_MS };
