/**
 * Carries a route-specific, user-facing message alongside the low-level cause,
 * so the centralized error middleware can reproduce each route's original
 * `{ error, details }` response shape without each handler re-deriving it.
 */
class AppError extends Error {
  constructor(publicMessage, cause) {
    super(publicMessage);
    this.name = 'AppError';
    this.publicMessage = publicMessage;
    this.cause = cause;
  }
}

/**
 * Runs `fn`, rethrowing any failure as an AppError tagged with `publicMessage`.
 * Replaces per-route try/catch/log/respond boilerplate with a single call site.
 */
async function attempt(publicMessage, fn) {
  try {
    return await fn();
  } catch (err) {
    throw new AppError(publicMessage, err);
  }
}

/** Forwards a rejected async route handler's error to Express's next(err). */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { AppError, attempt, asyncHandler };
