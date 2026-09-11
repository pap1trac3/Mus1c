const HEARTBEAT_INTERVAL_MS = 15000;

/**
 * Periodic SSE comment frames, so an idle stream isn't culled by a proxy or
 * load balancer during a long pause between tokens. A line starting with ':'
 * is a comment: clients ignore it, but it keeps bytes moving on the socket.
 *
 * Returns a stop function. The timer is unref'd so a pending heartbeat can
 * never hold the process (or a test runner) open, and it clears itself if the
 * client disconnects, so a dropped connection doesn't leak an interval.
 */
function createHeartbeat(res, { intervalMs = HEARTBEAT_INTERVAL_MS } = {}) {
  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    res.write(': ping\n\n');
  }, intervalMs);

  if (typeof timer.unref === 'function') timer.unref();

  const stop = () => clearInterval(timer);
  res.once('close', stop);

  return stop;
}

module.exports = { createHeartbeat, HEARTBEAT_INTERVAL_MS };
