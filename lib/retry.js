const { logger } = require('./logger');

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

/**
 * Transient failures only. Retrying a 400 or a 401 cannot succeed — it just
 * adds latency and load — so only timeouts, conflicts, rate limits, 5xx, and
 * transport-level errors (which carry no status) are worth another attempt.
 */
function isTransient(err) {
  const status = err?.status ?? err?.statusCode ?? err?.response?.status;
  if (typeof status === 'number') return RETRYABLE_STATUS.has(status);
  return true; // no status: socket hang-up, DNS, timeout
}

/**
 * Retries an async operation with exponential backoff and full jitter.
 *
 * `attempts` is the total number of tries, not the number of retries after
 * the first. Note this is NOT used for OpenAI calls: that SDK already retries
 * 408/409/429/5xx internally and honours Retry-After, so wrapping it here
 * would just multiply the attempt count with dumber logic.
 */
async function withRetry(fn, options = {}) {
  const {
    attempts = 3,
    initialDelayMs = 200,
    factor = 2,
    maxDelayMs = 5000,
    isRetryable = isTransient,
    log = logger,
    label = 'operation',
  } = options;

  const total = Math.max(1, attempts);
  let lastError;

  for (let attempt = 1; attempt <= total; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (attempt >= total || !isRetryable(err)) {
        log.error(
          { err: err.message, attempt, attempts: total, retryable: isRetryable(err) },
          `${label} failed`
        );
        throw err;
      }

      // Full jitter: random across the whole window rather than a fixed delay
      // plus a small wobble, so concurrent callers don't retry in lockstep.
      const ceiling = Math.min(initialDelayMs * factor ** (attempt - 1), maxDelayMs);
      const delay = Math.random() * ceiling;

      log.warn(
        { err: err.message, attempt, attempts: total, next_retry_ms: Math.round(delay) },
        `${label} failed; retrying`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

module.exports = { withRetry, isTransient };
