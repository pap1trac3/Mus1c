/**
 * Vocal stem isolation, delegated to the separator sidecar.
 *
 * Tuned transcription parameters help on clean speech but cannot recover a
 * vocal buried under a beat — the model is hearing the mix. Separating the
 * vocal stem first is the fix that actually addresses that, and Demucs is the
 * usual tool. It cannot live in this process: PyTorch has no musl wheels, so
 * it cannot be installed into the alpine runtime image, and rebasing that
 * image on Debian to fit torch would take it past 2GB. Hence a sidecar.
 *
 * Two properties matter more than the separation itself:
 *
 * - It is OPTIONAL. With SEPARATOR_URL unset the pipeline behaves exactly as
 *   it did before, so nobody is forced to run a multi-gigabyte container to
 *   use the app.
 * - It NEVER fails the request. Separation is an accuracy improvement, not a
 *   dependency: if the sidecar is down, slow, or returns nonsense, the
 *   original audio goes to transcription and the caller still gets a result.
 */

// Measured: htdemucs on 4 CPU cores runs at ~2x real time, so a 60-second
// reel takes ~120s and a 3-minute one ~6 minutes. A 120s default would have
// silently timed out on any reel over a minute — losing the accuracy benefit
// precisely on the longer clips. Generous by design: a timeout is not a
// failure here, it just falls back to the original mix.
const SEPARATION_TIMEOUT_MS = Number(process.env.SEPARATOR_TIMEOUT_MS) || 600000;

/** A WAV under this is silence or a decode failure, not an isolated vocal. */
const MIN_STEM_BYTES = 1024;

function separatorUrl() {
  const raw = (process.env.SEPARATOR_URL || '').trim();
  return raw ? raw.replace(/\/+$/, '') : '';
}

/** Whether the sidecar is configured at all. */
function separationEnabled() {
  return separatorUrl() !== '';
}

/**
 * Returns the isolated vocal stem for a clip, or the original audio when
 * separation is unavailable. The caller does not branch: it always receives
 * something transcribable plus a note of which it got.
 *
 * @returns {Promise<{buffer: Buffer, filename: string, mimetype: string,
 *   separated: boolean, reason: string|null, ms: number|null}>}
 */
async function isolateVocals({ buffer, filename, mimetype, log }) {
  const original = {
    buffer,
    filename: filename || 'reel.mp4',
    mimetype: mimetype || 'application/octet-stream',
    separated: false,
    reason: null,
    ms: null,
  };

  const base = separatorUrl();
  if (!base) return { ...original, reason: 'not_configured' };

  // Bounds the wait rather than the work: at ~2x real time a long clip
  // legitimately takes minutes, but a hung sidecar must not hold the
  // caller's request open indefinitely.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEPARATION_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const form = new FormData();
    form.append('clip', new Blob([buffer], { type: original.mimetype }), original.filename);

    const response = await fetch(`${base}/separate`, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      log?.warn(
        { status: response.status, detail: detail.slice(0, 200) },
        'vocal separation failed; transcribing the original mix'
      );
      return { ...original, reason: `http_${response.status}` };
    }

    const stem = Buffer.from(await response.arrayBuffer());
    if (stem.length < MIN_STEM_BYTES) {
      log?.warn({ bytes: stem.length }, 'vocal stem too small to be real; transcribing the original mix');
      return { ...original, reason: 'empty_stem' };
    }

    const ms = Date.now() - startedAt;
    log?.info(
      { separation_ms: ms, stem_bytes: stem.length, model: response.headers.get('x-separation-model') },
      'vocal stem isolated'
    );

    // Always a WAV from here, whatever the container went in as.
    return {
      buffer: stem,
      filename: 'vocals.wav',
      mimetype: 'audio/wav',
      separated: true,
      reason: null,
      ms,
    };
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    log?.warn(
      { err: err.message, timed_out: aborted },
      'vocal separation unavailable; transcribing the original mix'
    );
    return { ...original, reason: aborted ? 'timeout' : 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { isolateVocals, separationEnabled, SEPARATION_TIMEOUT_MS, MIN_STEM_BYTES };
