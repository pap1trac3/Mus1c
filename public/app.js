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

// ---------------------------------------------------------------------------
// Reel lyric deconstructor
// ---------------------------------------------------------------------------

const MAX_REEL_BYTES = 25 * 1024 * 1024;

let selectedReel = null;

function describeSize(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

function selectReel(file) {
  const status = $('reel-status');

  // Checked here as well as server-side, so an oversized clip fails instantly
  // instead of after a long upload that the API would reject anyway.
  if (file.size > MAX_REEL_BYTES) {
    selectedReel = null;
    syncAnalyzeButton();
    $('file-name-display').textContent = '';
    setStatus(status, file.name + ' is ' + describeSize(file.size) + ' — the 25MB limit is set by the transcription API. Trim the clip or export audio only.', 'err');
    return;
  }

  selectedReel = file;
  $('file-name-display').textContent = file.name + ' (' + describeSize(file.size) + ')';
  syncAnalyzeButton();
  setStatus(status, '');
  readDuration(file);
}

// The clip's length, read from the decoded media element. The server uses it
// to judge how much of the vocal the transcription actually caught — 8
// characters from 45 seconds of audio means it heard the beat, not the words.
// Best-effort: a codec the browser can't decode just leaves it unknown.
let selectedReelSeconds = null;

function readDuration(file) {
  selectedReelSeconds = null;

  const url = URL.createObjectURL(file);
  const probe = document.createElement('video'); // also decodes bare audio
  probe.preload = 'metadata';

  const done = () => URL.revokeObjectURL(url);

  probe.addEventListener('loadedmetadata', () => {
    if (Number.isFinite(probe.duration) && probe.duration > 0) {
      selectedReelSeconds = probe.duration;
    }
    done();
  }, { once: true });
  probe.addEventListener('error', done, { once: true });

  probe.src = url;
}

const dropZone = $('drop-zone');
const reelInput = $('reel-file-input');

dropZone.addEventListener('click', () => reelInput.click());
dropZone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    reelInput.click();
  }
});

dropZone.addEventListener('dragover', (event) => {
  event.preventDefault();
  dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropZone.classList.remove('drag-over');
  if (event.dataTransfer.files.length) selectReel(event.dataTransfer.files[0]);
});

reelInput.addEventListener('change', (event) => {
  if (event.target.files.length) selectReel(event.target.files[0]);
});

// Either input is enough on its own: pasted lyrics stand in for the clip.
function syncAnalyzeButton() {
  const hasLyrics = $('reel-reference-lyrics').value.trim().length > 0;
  $('analyze-reel-btn').disabled = !selectedReel && !hasLyrics;
  // The transcription hints do nothing once the words are supplied directly.
  $('reel-language').disabled = hasLyrics;
  $('reel-keywords').disabled = hasLyrics;
}

$('reel-reference-lyrics').addEventListener('input', syncAnalyzeButton);

$('analyze-reel-btn').addEventListener('click', async () => {
  const status = $('reel-status');
  const button = $('analyze-reel-btn');
  const topic = $('reel-topic').value.trim();
  const referenceLyrics = $('reel-reference-lyrics').value.trim();

  // Pasted lyrics stand in for the clip, so one or the other is enough.
  if (!selectedReel && !referenceLyrics) return;
  if (!topic) {
    setStatus(status, 'Enter a topic for the new lyrics.', 'err');
    return;
  }

  const remember = $('remember-reel').checked;

  const form = new FormData();
  if (selectedReel) form.append('reel', selectedReel);
  form.append('topic', topic);
  form.append('remember', String(remember));

  if (referenceLyrics) {
    form.append('reference_lyrics', referenceLyrics);
  } else {
    // Only meaningful for the transcription path.
    form.append('language', $('reel-language').value);
    form.append('keywords', $('reel-keywords').value);
    if (selectedReelSeconds !== null) form.append('duration_seconds', String(selectedReelSeconds));
  }

  button.disabled = true;
  $('reel-results').hidden = true;
  status.className = 'status busy';
  status.innerHTML = '';
  status.appendChild(Object.assign(document.createElement('span'), { className: 'spinner' }));
  status.appendChild(
    document.createTextNode(referenceLyrics ? 'Deconstructing…' : 'Transcribing and deconstructing…')
  );

  try {
    // No Content-Type header: the browser must set the multipart boundary.
    const response = await fetch('/api/analyze-reel', { method: 'POST', body: form });
    if (!response.ok) throw await asError(response);

    const result = await response.json();
    renderReelResult(result.style_dna, result.generated_lyrics);
    rememberReelResult(result.style_dna, result.generated_lyrics);

    let analyzed;
    if (result.source === 'pasted') {
      analyzed = 'Done — read from the ' + result.transcript_chars + ' characters you pasted.';
    } else if (result.transcript_chars > 0) {
      analyzed = 'Done — transcribed ' + result.transcript_chars + ' characters.';
    } else {
      analyzed = 'Done — no vocals detected, lyrics written from the topic alone.';
    }

    // The server keeps the analysis even when it declines to remember it, so
    // say which of the two happened rather than assuming both did.
    let kept = '';
    if (result.remembered) {
      kept = ' Style kept — later generations will draw on it.';
      loadStyleMemory();
    } else if (remember && result.not_remembered_reason === 'low_transcript_quality') {
      // The server's note explains why; don't say it twice.
      kept = ' Not kept in the vault.';
    } else if (remember) {
      kept = " Couldn't save the style to the vault, so this one stays a one-off.";
    }

    const poor = result.transcript_quality === 'low' || result.transcript_quality === 'empty';
    setStatus(
      status,
      analyzed + kept + (result.quality_note ? ' ' + result.quality_note : ''),
      poor ? 'warn' : (result.remembered || !remember ? 'ok' : 'err')
    );
  } catch (err) {
    setStatus(status, err.message, 'err', err.details);
  } finally {
    syncAnalyzeButton();
  }
});

/** Paints the style badges and lyrics. Shared by a fresh result and a restore. */
function renderReelResult(styleDna, lyrics) {
  const dna = styleDna || {};
  $('badge-feel').textContent = dna.feel || 'Unknown';
  $('badge-cadence').textContent = dna.cadence || 'Unknown';

  // One pill per domain. Built with textContent, never innerHTML: these
  // strings come from the model and must not be parsed as markup.
  const container = $('reel-domains');
  const domains = Array.isArray(dna.metaphor_domains) ? dna.metaphor_domains : [];
  const pills = (domains.length ? domains : ['None identified']).map((domain) => {
    const pill = document.createElement('span');
    pill.className = 'badge badge-domain';
    pill.textContent = domain;
    return pill;
  });
  container.replaceChildren(...pills);

  $('reel-lyrics').textContent = lyrics || '';
  $('reel-results').hidden = false;
}

// localStorage is per-viewer convenience only, and every accessor is guarded:
// it throws outright in some privacy modes rather than returning null.
const REEL_CACHE_KEY = 'mozart.reel.lastResult';
const LYRIC_PREFS_KEY = 'mozart.reel.lyricPrefs';

function rememberReelResult(styleDna, lyrics) {
  try {
    localStorage.setItem(REEL_CACHE_KEY, JSON.stringify({ styleDna, lyrics }));
  } catch (err) {
    /* storage unavailable or full — the feature still works, just not across reloads */
  }
}

function restoreReelResult() {
  try {
    const cached = localStorage.getItem(REEL_CACHE_KEY);
    if (!cached) return;
    const { styleDna, lyrics } = JSON.parse(cached);
    if (lyrics) {
      renderReelResult(styleDna, lyrics);
      setStatus($('reel-status'), 'Showing your last result from this browser.');
    }
  } catch (err) {
    /* unreadable or stale shape — start clean rather than surfacing an error */
  }
}

// --- lyric formatting toggles -------------------------------------------

function applyLyricPrefs(prefs) {
  const pre = $('reel-lyrics');
  pre.classList.toggle('large-font', !!prefs.large);
  pre.classList.toggle('spacious-lines', !!prefs.spacious);
  $('font-size-toggle').setAttribute('aria-pressed', String(!!prefs.large));
  $('line-height-toggle').setAttribute('aria-pressed', String(!!prefs.spacious));
}

function readLyricPrefs() {
  try {
    return JSON.parse(localStorage.getItem(LYRIC_PREFS_KEY)) || {};
  } catch (err) {
    return {};
  }
}

function toggleLyricPref(key) {
  const prefs = readLyricPrefs();
  prefs[key] = !prefs[key];
  applyLyricPrefs(prefs);
  try {
    localStorage.setItem(LYRIC_PREFS_KEY, JSON.stringify(prefs));
  } catch (err) {
    /* preference just won't persist */
  }
}

$('font-size-toggle').addEventListener('click', () => toggleLyricPref('large'));
$('line-height-toggle').addEventListener('click', () => toggleLyricPref('spacious'));

$('copy-lyrics-btn').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const lyrics = $('reel-lyrics').textContent;
  if (!lyrics) return;

  try {
    await navigator.clipboard.writeText(lyrics);
    button.textContent = 'Copied';
    setTimeout(() => { button.textContent = 'Copy'; }, 1800);
  } catch (err) {
    // Clipboard access needs a secure context and can be denied.
    setStatus($('reel-status'), 'Copy failed — select the text manually.', 'err');
  }
});

$('download-lyrics-btn').addEventListener('click', () => {
  const lyrics = $('reel-lyrics').textContent;
  if (!lyrics) return;

  const url = URL.createObjectURL(new Blob([lyrics], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'mozart-lyrics-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.txt';
  // Firefox ignores a click on an anchor that isn't in the document.
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking synchronously can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
});

applyLyricPrefs(readLyricPrefs());
restoreReelResult();
syncAnalyzeButton();

// ---------------------------------------------------------------------------
// Style memory — what the vault has learned from reels so far
// ---------------------------------------------------------------------------

function describeWhen(iso) {
  if (!iso) return '';
  const learnedAt = new Date(iso);
  if (Number.isNaN(learnedAt.getTime())) return '';
  return learnedAt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** One card per learned profile. Every value is model- or user-supplied, so
 *  it is written with textContent and never parsed as markup. */
function renderStyleMemory(data) {
  const profiles = Array.isArray(data.profiles) ? data.profiles : [];
  const count = typeof data.count === 'number' ? data.count : profiles.length;

  $('memory-count').textContent =
    count === 0
      ? 'Nothing learned yet'
      : (data.count_capped ? count + '+' : count) + (count === 1 ? ' reel learned' : ' reels learned');

  const list = $('memory-list');

  if (profiles.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'memory-empty';
    empty.textContent = 'Analyze a reel above and its style will appear here.';
    list.replaceChildren(empty);
    return;
  }

  list.replaceChildren(...profiles.map((profile) => {
    const item = document.createElement('li');
    item.className = 'memory-item';

    const top = document.createElement('div');
    top.className = 'memory-top';

    const source = document.createElement('span');
    source.className = 'memory-source';
    source.textContent = profile.source_name || 'reel clip';
    top.appendChild(source);

    const when = describeWhen(profile.learned_at);
    if (when) {
      const stamp = document.createElement('span');
      stamp.className = 'memory-when';
      stamp.textContent = when;
      top.appendChild(stamp);
    }
    item.appendChild(top);

    const feel = document.createElement('span');
    feel.className = 'badge badge-feel';
    feel.textContent = profile.feel || 'Unknown';
    item.appendChild(feel);

    const cadence = document.createElement('div');
    cadence.className = 'memory-cadence';
    cadence.textContent = profile.cadence || 'Unknown';
    item.appendChild(cadence);

    const domains = Array.isArray(profile.metaphor_domains) ? profile.metaphor_domains : [];
    if (domains.length) {
      const pills = document.createElement('div');
      pills.className = 'domains-flex';
      pills.replaceChildren(...domains.map((domain) => {
        const pill = document.createElement('span');
        pill.className = 'badge badge-domain';
        pill.textContent = domain;
        return pill;
      }));
      item.appendChild(pills);
    }

    const actions = document.createElement('div');
    actions.className = 'memory-actions';
    const forget = document.createElement('button');
    forget.type = 'button';
    forget.className = 'btn-icon';
    forget.textContent = 'Forget';
    forget.addEventListener('click', () => forgetProfile(profile.id, forget));
    actions.appendChild(forget);
    item.appendChild(actions);

    return item;
  }));
}

async function loadStyleMemory() {
  const status = $('memory-status');

  try {
    const response = await fetch('/api/style-memory');
    if (!response.ok) throw await asError(response);

    renderStyleMemory(await response.json());
    setStatus(status, '');
  } catch (err) {
    $('memory-count').textContent = 'Style memory unavailable';
    setStatus(status, err.message, 'err', err.details);
  }
}

async function forgetProfile(id, button) {
  if (!id) return;

  button.disabled = true;
  button.textContent = 'Forgetting…';

  try {
    const response = await fetch('/api/style-memory/' + encodeURIComponent(id), { method: 'DELETE' });
    if (!response.ok) throw await asError(response);

    await loadStyleMemory();
  } catch (err) {
    button.disabled = false;
    button.textContent = 'Forget';
    setStatus($('memory-status'), err.message, 'err', err.details);
  }
}

$('refresh-memory-btn').addEventListener('click', loadStyleMemory);

loadStyleMemory();
