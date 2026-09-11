const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_TTL_MS = 15000;

/** Rejects if `promise` has not settled within `ms`. */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} check timed out after ${ms}ms`)), ms);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

/**
 * Runs dependency probes with a short result cache. Probes are real network
 * calls, and container healthchecks poll on a fixed interval, so caching keeps
 * a tight probe interval from turning into upstream load.
 */
function createReadinessChecker({ vaultRepo, openai, timeoutMs = DEFAULT_TIMEOUT_MS, ttlMs = DEFAULT_TTL_MS, now = Date.now }) {
  let cache = null;

  const probe = async (label, fn) => {
    const startedAt = now();
    try {
      await withTimeout(fn(), timeoutMs, label);
      return { status: 'healthy', latency_ms: now() - startedAt };
    } catch (err) {
      return { status: 'unhealthy', latency_ms: now() - startedAt, error: err.message };
    }
  };

  return async function check({ force = false } = {}) {
    if (!force && cache && now() - cache.at < ttlMs) {
      return { ...cache.result, cached: true };
    }

    const [vectorVault, openaiApi] = await Promise.all([
      // options() fetches collection metadata: proves reachability, auth and
      // that lyric_vault exists, without scanning documents.
      probe('vector_vault', () => vaultRepo.ping()),
      // A models lookup is an authenticated request that bills no tokens,
      // so it detects a revoked or expired key rather than assuming the
      // env var being set means the key still works.
      probe('openai_api', () => openai.models.retrieve('text-embedding-3-small')),
    ]);

    const dependencies = { vector_vault: vectorVault, openai_api: openaiApi };
    const ready = Object.values(dependencies).every((d) => d.status === 'healthy');

    const result = { status: ready ? 'ready' : 'degraded', ready, dependencies };
    cache = { at: now(), result };
    return { ...result, cached: false };
  };
}

module.exports = { createReadinessChecker, withTimeout };
