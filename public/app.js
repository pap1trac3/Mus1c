'use strict';

const $ = (id) => document.getElementById(id);

function setStatus(el, message, kind, details) {
  el.className = 'status' + (kind ? ' ' + kind : '');
  el.textContent = message;

  // Only field-scoped issues add information; a pathless issue (e.g. the
  // cross-field "genre or theme" rule) is already the headline message.
  const fieldIssues = (details || []).filter((detail) => detail.field);
  if (fieldIssues.length) {
    const list = document.createElement('ul');
    for (const detail of fieldIssues) {
      const item = document.createElement('li');
      item.textContent = detail.field + ': ' + detail.message;
      list.appendChild(item);
    }
    el.appendChild(list);
  }
}

/** Collects non-empty form values; blank fields are omitted entirely. */
function collectForm(form) {
  const payload = {};
  for (const [name, raw] of new FormData(form).entries()) {
    const value = raw.trim();
    if (value) payload[name] = value;
  }
  return payload;
}

/**
 * Parses one SSE frame into { event, data }. Uses slice rather than replace so
 * a "data: " sequence occurring inside the payload can't corrupt the value.
 */
function parseFrame(frame) {
  let event = 'message';
  let data = null;

  for (const line of frame.split('\n')) {
    if (line.startsWith('event: ')) event = line.slice(7).trim();
    else if (line.startsWith('data: ')) data = line.slice(6);
  }

  return data === null ? null : { event, data };
}

/**
 * Reads an SSE response, buffering across network reads: frames are split on a
 * blank line and the trailing partial frame is carried into the next chunk, so
 * a token split across TCP packets is never dropped.
 */
async function readEventStream(response, { onToken, onComplete }) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const frames = buffer.split('\n\n');
    buffer = frames.pop(); // incomplete tail, completed by a later read

    for (const frame of frames) {
      if (!frame.trim()) continue;

      const parsed = parseFrame(frame);
      if (!parsed) continue;

      if (parsed.data === '[DONE]') return;

      if (parsed.event === 'complete') {
        onComplete(JSON.parse(parsed.data));
        return;
      }
      if (parsed.event === 'error') {
        const payload = JSON.parse(parsed.data);
        throw new Error(payload.details || payload.error || 'Generation failed');
      }
      onToken(JSON.parse(parsed.data).token);
    }
  }
}

/** Reads a JSON error body (validation 400, rate-limit 429, 500). */
async function asError(response) {
  const body = await response.json().catch(() => ({}));
  const error = new Error(body.error || 'Request failed (' + response.status + ')');
  error.details = body.details;
  return error;
}

async function handleGenerate(event) {
  event.preventDefault();

  const button = $('generate-btn');
  const status = $('generate-status');
  const streamOut = $('stream-out');
  const styleOut = $('style-out');
  const lyricsOut = $('lyrics-out');
  const meta = $('retrieval-meta');

  button.disabled = true;
  streamOut.textContent = '';
  streamOut.classList.add('cursor');
  styleOut.textContent = '';
  lyricsOut.textContent = '';
  meta.textContent = '';
  setStatus(status, 'Generating…', 'busy');

  try {
    const response = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(Object.assign(collectForm(event.target), { stream: true })),
    });

    // Validation and rate-limit responses come back as JSON, not a stream.
    if (!response.ok || !(response.headers.get('content-type') || '').includes('text/event-stream')) {
      throw await asError(response);
    }

    await readEventStream(response, {
      onToken: (token) => {
        streamOut.textContent += token;
        streamOut.scrollTop = streamOut.scrollHeight;
      },
      onComplete: (result) => {
        styleOut.textContent = result.style_prompt || '';
        lyricsOut.textContent = result.structured_lyrics || '';
        loadMelody(result);
        meta.textContent =
          'Retrieved ' + result.retrieved_chunks + ' chunk(s) from ' +
          result.retrieved_documents + ' document(s).';
        setStatus(status, 'Done.', 'ok');
      },
    });
  } catch (err) {
    setStatus(status, err.message, 'err', err.details);
  } finally {
    streamOut.classList.remove('cursor');
    button.disabled = false;
  }
}

async function handleIngest(event) {
  event.preventDefault();

  const button = $('ingest-btn');
  const status = $('ingest-status');
  const form = event.target;

  button.disabled = true;
  setStatus(status, 'Ingesting…', 'busy');

  try {
    const { transcript, document_id: documentId } = collectForm(form);
    const body = { transcript: transcript || '' };
    if (documentId) body.metadata = { document_id: documentId };

    const response = await fetch('/api/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) throw await asError(response);

    const result = await response.json();
    setStatus(
      status,
      'Ingested ' + result.chunks_ingested + ' chunk(s) as ' + result.document_id + '.',
      'ok'
    );
    form.reset();
  } catch (err) {
    setStatus(status, err.message, 'err', err.details);
  } finally {
    button.disabled = false;
  }
}

$('generate-form').addEventListener('submit', handleGenerate);
$('ingest-form').addEventListener('submit', handleIngest);

// ---------------------------------------------------------------------------
// Audio preview
// ---------------------------------------------------------------------------

let pendingMelody = null;
let spectrumFrame = null;

function setPlayerStatus(text, kind) {
  const el = $('audio-status');
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

/** Called when a generation completes; stores the motif for playback. */
function loadMelody(result) {
  pendingMelody = Array.isArray(result.melody) && result.melody.length
    ? { melody: result.melody, tempo: result.tempo_bpm }
    : null;

  const playBtn = $('play-btn');
  if (!pendingMelody) {
    playBtn.disabled = true;
    setPlayerStatus('No playable motif in this result.', 'err');
    return;
  }

  playBtn.disabled = false;
  setPlayerStatus(
    'Ready — ' + pendingMelody.melody.length + ' events at ' + pendingMelody.tempo + ' BPM.',
    'ok'
  );

  // If the engine is already running, swap the material in immediately.
  if (window.audioEngine.initialized) {
    window.audioEngine.load(pendingMelody.melody, pendingMelody.tempo);
  }
}

function drawSpectrum() {
  const canvas = $('visualizer-canvas');
  const ctx = canvas.getContext('2d');
  const values = window.audioEngine.getSpectrum();

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const barWidth = canvas.width / values.length;
  for (let i = 0; i < values.length; i++) {
    // FFT returns dB, roughly -100 (silence) to 0 (full scale).
    const magnitude = Math.max(0, Math.min(1, (values[i] + 100) / 100));
    const barHeight = magnitude * canvas.height;
    ctx.fillStyle = 'rgba(200, 164, 94, ' + (0.35 + magnitude * 0.65) + ')';
    ctx.fillRect(i * barWidth, canvas.height - barHeight, Math.max(1, barWidth - 1), barHeight);
  }

  // Driven by engine state, so the loop ends with playback rather than spinning.
  if (window.audioEngine.state === 'playing') {
    spectrumFrame = requestAnimationFrame(drawSpectrum);
  } else {
    spectrumFrame = null;
  }
}

window.audioEngine.onState = (state) => {
  const labels = { offline: 'Offline', stopped: 'Stopped', playing: 'Playing', paused: 'Paused' };
  const kinds = { playing: 'ok', paused: 'busy', stopped: '', offline: '' };
  setPlayerStatus(labels[state] || state, kinds[state]);

  $('pause-btn').disabled = state !== 'playing';
  $('stop-btn').disabled = state === 'stopped' || state === 'offline';

  if (state === 'playing' && spectrumFrame === null) drawSpectrum();
};

$('play-btn').addEventListener('click', async () => {
  if (!pendingMelody) return;
  try {
    setPlayerStatus('Starting audio…', 'busy');
    // Must happen inside the click handler: AudioContext needs a user gesture.
    await window.audioEngine.init();
    window.audioEngine.load(pendingMelody.melody, pendingMelody.tempo);
    window.audioEngine.play();
  } catch (err) {
    setPlayerStatus('Audio failed to start: ' + err.message, 'err');
  }
});

$('pause-btn').addEventListener('click', () => window.audioEngine.pause());
$('stop-btn').addEventListener('click', () => window.audioEngine.stop());

$('volume-slider').addEventListener('input', (event) => {
  const db = parseFloat(event.target.value);
  $('volume-value').textContent = db + ' dB';
  window.audioEngine.setVolume(db);
});
