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
  lastResult = null;
  renderRhymeLegend(null);
  syncRhymeToggle();
  syncSchemeCapture();
  renderBarGrid(null);
  syncSectionPicker('');
  setStatus($('rewrite-status'), '');
  $('export-txt-btn').disabled = true;
  $('export-csv-btn').disabled = true;
  setStatus(status, 'Generating…', 'busy');

  try {
    const response = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(Object.assign(collectForm(event.target), {
        // collectForm yields strings; the API takes tags as an array.
        tags: parseTagInput($('generate-tags').value),
        cadence_profile_id: $('cadence-profile').value,
        imagery_profile_id: $('imagery-profile').value,
        scheme: currentScheme(),
        stream: true,
      })),
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
        lastResult = result;
        renderLyrics(result);
        renderRhymeLegend(result);
        syncRhymeToggle();
        syncSchemeCapture();
        renderBarGrid(result);
        syncSectionPicker(result.structured_lyrics);
        rememberDraft(result);
        $('export-txt-btn').disabled = false;
        $('export-csv-btn').disabled = false;
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
// Bar grid and export
// ---------------------------------------------------------------------------

/** The last generation, kept so the export buttons have something to write. */
let lastResult = null;

function describeMechanics(prosody) {
  if (!prosody || !prosody.line_count) return '';

  const perLine = prosody.syllables_per_line || {};
  const parts = [prosody.line_count + ' sung line' + (prosody.line_count === 1 ? '' : 's')];

  if (typeof perLine.avg === 'number') {
    parts.push(perLine.avg + ' syllables per line (' + perLine.min + '–' + perLine.max + ')');
  }
  if (prosody.rhyme_scheme && prosody.rhyme_scheme !== 'unknown') {
    parts.push('rhyme ' + prosody.rhyme_scheme);
  }
  parts.push('internal rhyme ' + Math.round((prosody.internal_rhyme_density || 0) * 100) + '%');

  return parts.join(' · ');
}

/** Renders the bar grid. Every lyric line is model output, so it is written
 *  with textContent and never parsed as markup. */
function renderBarGrid(result) {
  const wrap = $('bar-grid-wrap');
  const body = $('bar-grid-body');
  const rows = (result && result.bar_grid && result.bar_grid.rows) || [];

  $('mechanics-meta').textContent = describeMechanics(result && result.prosody);

  if (rows.length === 0) {
    body.replaceChildren();
    wrap.hidden = true;
    return;
  }

  body.replaceChildren(...rows.map((row) => {
    const tr = document.createElement('tr');
    tr.dataset.startBar = String(row.start_bar);
    tr.dataset.endBar = String(row.end_bar);

    const bars = document.createElement('td');
    bars.className = 'num';
    bars.textContent = row.start_bar === row.end_bar
      ? String(row.start_bar)
      : row.start_bar + '–' + row.end_bar;

    const at = document.createElement('td');
    at.className = 'num';
    at.textContent = typeof row.start_seconds === 'number' ? formatClock(row.start_seconds) : '—';

    const syllables = document.createElement('td');
    syllables.className = 'num';
    syllables.textContent = String(row.syllables);

    const line = document.createElement('td');
    line.className = 'line';
    line.textContent = row.line;

    tr.append(bars, at, syllables, line);
    return tr;
  }));

  wrap.hidden = false;
}

/** Seconds as m:ss, so a marker time reads the way a DAW displays it. */
function formatClock(seconds) {
  const whole = Math.floor(seconds);
  const mins = Math.floor(whole / 60);
  const secs = whole % 60;
  return mins + ':' + String(secs).padStart(2, '0');
}

/** Quotes one CSV field: doubles inner quotes and wraps when it has to. */
function csvField(value) {
  const text = String(value == null ? '' : value);
  return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

/**
 * Bar markers as CSV. Generic on purpose — DAWs disagree on marker import
 * formats, so this is name/position/bar columns a user can map, not a claim
 * that any particular DAW imports it untouched.
 */
function buildMarkerCsv(result) {
  const grid = (result && result.bar_grid) || { rows: [] };
  const header = ['name', 'start_seconds', 'start_bar', 'end_bar', 'syllables'];
  const rows = grid.rows.map((row) =>
    [row.line, row.start_seconds == null ? '' : row.start_seconds, row.start_bar, row.end_bar, row.syllables]
      .map(csvField)
      .join(',')
  );
  return [header.join(','), ...rows].join('\n') + '\n';
}

/** Lyric sheet with bar annotations, for pasting into a session or notes app. */
function buildLyricSheetText(result) {
  const grid = (result && result.bar_grid) || { rows: [], bpm: null, total_bars: 0 };
  const lines = [];

  if (result && result.style_prompt) lines.push('STYLE: ' + result.style_prompt, '');
  if (grid.bpm) lines.push('TEMPO: ' + grid.bpm + ' BPM · ' + grid.total_bars + ' bars', '');

  // The sheet itself, unaltered — section headers and all — then the grid,
  // so the lyrics stay copy-pasteable without the annotations in the way.
  lines.push(result && result.structured_lyrics ? result.structured_lyrics : '', '', 'BAR GRID', '');
  for (const row of grid.rows) {
    const bars = row.start_bar === row.end_bar ? 'Bar ' + row.start_bar : 'Bars ' + row.start_bar + '-' + row.end_bar;
    lines.push('[' + bars + '] (' + row.syllables + ' syll.) ' + row.line);
  }

  return lines.join('\n');
}

/**
 * Hands the browser a file. Served from Express rather than a sandboxed frame,
 * so a blob download works; the object URL is revoked once the click is taken.
 */
function downloadFile(filename, mime, contents) {
  const url = URL.createObjectURL(new Blob([contents], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function stampedName(extension) {
  return 'mozart-lyrics-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + extension;
}

$('export-txt-btn').addEventListener('click', () => {
  if (lastResult) downloadFile(stampedName('.txt'), 'text/plain;charset=utf-8', buildLyricSheetText(lastResult));
});

$('export-csv-btn').addEventListener('click', () => {
  if (lastResult) downloadFile(stampedName('.csv'), 'text/csv;charset=utf-8', buildMarkerCsv(lastResult));
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
      analyzed = 'Done — transcribed ' + result.transcript_chars + ' characters' + describeSource(result) + '.';
    } else {
      analyzed = 'Done — no vocals detected' + describeSource(result) + ', lyrics written from the topic alone.';
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

/**
 * Says whether the vocal was isolated before transcription. Without this, a
 * poor transcript is unreadable as a diagnosis: you cannot tell whether the
 * model heard a clean stem and still struggled, or was handed the whole mix.
 * Silent when no separator is configured — that is the default, and naming
 * an absent feature on every run would be noise.
 */
function describeSource(result) {
  if (result.vocals_isolated) return ' from the isolated vocal';
  switch (result.separation_skipped) {
    case 'timeout':
      return ' from the full mix (isolating the vocal took too long)';
    case 'unreachable':
    case 'empty_stem':
      return ' from the full mix (vocal isolation unavailable)';
    default:
      // 'not_configured', or an http_<status> the server already logged.
      return result.separation_skipped && result.separation_skipped !== 'not_configured'
        ? ' from the full mix (vocal isolation failed)'
        : '';
  }
}

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

/** "aggressive, R&B hook" -> ["aggressive", "r&b hook"]. Lowercased to match
 *  the server's canonical form, so a filter matches however the tag was typed. */
function parseTagInput(raw) {
  return String(raw || '')
    .split(',')
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean)
    .filter((tag, i, all) => all.indexOf(tag) === i);
}

/**
 * Per-profile tag editor. Saves on `change` — which fires on blur and on
 * Enter, but not on every keystroke, so typing a list is one request rather
 * than one per character.
 */
function buildTagEditor(profile) {
  const wrap = document.createElement('div');
  wrap.className = 'memory-tags';

  const inputId = 'memory-tags-' + profile.id;
  const label = document.createElement('label');
  label.setAttribute('for', inputId);
  label.textContent = 'Tags';

  const input = document.createElement('input');
  input.id = inputId;
  input.type = 'text';
  input.autocomplete = 'off';
  input.placeholder = 'aggressive, r&b hook';
  // Model- and user-supplied text: assigned as a value, never parsed as markup.
  input.value = (Array.isArray(profile.tags) ? profile.tags : []).join(', ');

  const state = document.createElement('span');
  state.className = 'memory-tag-state';
  state.setAttribute('role', 'status');
  state.setAttribute('aria-live', 'polite');

  // What the server last confirmed. A failed save leaves the typed text in
  // place to be retried, but this is what an unchanged field is compared to,
  // so a blur with nothing edited never fires a request.
  let saved = input.value;

  input.addEventListener('change', async () => {
    if (input.value === saved) return;

    const tags = parseTagInput(input.value);
    input.disabled = true;
    state.className = 'memory-tag-state';
    state.textContent = 'Saving…';

    try {
      const response = await fetch(
        '/api/style-memory/' + encodeURIComponent(profile.id) + '/tags',
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tags }),
        }
      );
      if (!response.ok) throw await asError(response);

      const result = await response.json();
      // Render what was stored, not what was typed: the server lowercases,
      // dedupes and caps, so the field should show the tags a filter will match.
      input.value = (result.tags || []).join(', ');
      saved = input.value;
      state.textContent = 'Saved';
    } catch (err) {
      state.className = 'memory-tag-state err';
      state.textContent = err.message;
    } finally {
      input.disabled = false;
    }
  });

  wrap.append(label, input, state);
  return wrap;
}

/** One card per learned profile. Every value is model- or user-supplied, so
 *  it is written with textContent and never parsed as markup. */
function renderStyleMemory(data) {
  const profiles = Array.isArray(data.profiles) ? data.profiles : [];
  syncProfileSelectors(profiles);
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

    item.appendChild(buildTagEditor(profile));

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

/**
 * Keeps the blend selectors in step with the vault, preserving the current
 * choice across a refresh so a reload does not silently un-blend a request.
 */
function syncProfileSelectors(profiles) {
  for (const id of ['cadence-profile', 'imagery-profile']) {
    const select = $(id);
    const previous = select.value;

    const options = [Object.assign(document.createElement('option'), {
      value: '',
      textContent: 'Whatever retrieval finds',
    })];

    for (const profile of profiles) {
      const option = document.createElement('option');
      option.value = profile.id;
      // Model- and user-supplied: set as text, never parsed as markup.
      option.textContent = (profile.source_name || 'profile') + ' — ' + (profile.feel || 'Unknown');
      options.push(option);
    }

    select.replaceChildren(...options);
    // Only restore a choice that still exists; a deleted profile clears.
    if (previous && profiles.some((profile) => profile.id === previous)) select.value = previous;
  }
}

$('refresh-memory-btn').addEventListener('click', loadStyleMemory);

loadStyleMemory();

// ---------------------------------------------------------------------------
// Train the vault from pasted text — no audio, nothing transcribed
// ---------------------------------------------------------------------------

// Bound with addEventListener rather than inline onclick: helmet sets
// script-src 'self', which blocks inline handlers outright.
function switchTrainMode(mode) {
  const isText = mode === 'text';
  $('panel-text').hidden = !isText;
  $('panel-reel').hidden = isText;
  $('mode-text').setAttribute('aria-selected', String(isText));
  $('mode-reel').setAttribute('aria-selected', String(!isText));
}

$('mode-reel').addEventListener('click', () => switchTrainMode('reel'));
$('mode-text').addEventListener('click', () => switchTrainMode('text'));

/** One pill per entry, built with textContent — these are model outputs. */
function paintPills(container, values, className) {
  const list = Array.isArray(values) ? values.filter(Boolean) : [];
  container.replaceChildren(...(list.length ? list : ['None identified']).map((value) => {
    const pill = document.createElement('span');
    pill.className = 'badge ' + className;
    pill.textContent = value;
    return pill;
  }));
}

// ---------------------------------------------------------------------------
// Rhyme overlay
// ---------------------------------------------------------------------------

let rhymeOverlayOn = false;

/**
 * Renders the sheet with rhyme groups marked.
 *
 * Built as DOM nodes, never as an HTML string: every word here is model
 * output, and an overlay is exactly the place where it would be tempting to
 * interpolate it into markup.
 */
function renderLyrics(result) {
  const out = $('lyrics-out');
  const sheet = (result && result.structured_lyrics) || '';
  const map = result && result.rhyme_map;

  if (!rhymeOverlayOn || !map || !map.lines || map.lines.length === 0) {
    out.textContent = sheet;
    return;
  }

  const byIndex = new Map(map.lines.map((line) => [line.index, line]));

  out.replaceChildren(...sheet.split('\n').flatMap((line, index, all) => {
    const nodes = markLine(line, byIndex.get(index));
    // Keep the sheet's own line breaks; a <pre> honours them literally.
    if (index < all.length - 1) nodes.push(document.createTextNode('\n'));
    return nodes;
  }));
}

/** One line, with its end rhyme and any internal rhymes wrapped. */
function markLine(line, info) {
  if (!info) return [document.createTextNode(line)];

  // Word boundaries, so "light" does not match inside "lighthouse".
  const targets = new Map();
  for (const word of info.internal || []) targets.set(word.toLowerCase(), 'internal-rhyme');

  const nodes = [];
  const pattern = /[A-Za-z']+/g;
  let cursor = 0;
  let match;
  let lastWordAt = -1;

  // The end rhyme is the final word, so find where that actually starts.
  while ((match = pattern.exec(line)) !== null) lastWordAt = match.index;
  pattern.lastIndex = 0;

  while ((match = pattern.exec(line)) !== null) {
    const word = match[0];
    const isEnd = info.group && match.index === lastWordAt;
    const internalClass = targets.get(word.toLowerCase());
    if (!isEnd && !internalClass) continue;

    if (match.index > cursor) nodes.push(document.createTextNode(line.slice(cursor, match.index)));

    const span = document.createElement('span');
    span.className = isEnd ? 'rhyme rhyme-' + info.group : internalClass;
    if (isEnd) span.title = 'Rhyme group ' + info.group;
    else span.title = 'Internal rhyme';
    span.textContent = word;
    nodes.push(span);

    cursor = match.index + word.length;
  }

  if (cursor < line.length) nodes.push(document.createTextNode(line.slice(cursor)));
  return nodes.length ? nodes : [document.createTextNode(line)];
}

function renderRhymeLegend(result) {
  const legend = $('rhyme-legend');
  const groups = (result && result.rhyme_map && result.rhyme_map.groups) || [];

  if (!rhymeOverlayOn || groups.length === 0) {
    legend.replaceChildren();
    legend.hidden = true;
    return;
  }

  const swatches = groups.map((group) => {
    const wrap = document.createElement('span');
    wrap.className = 'swatch';
    const chip = document.createElement('span');
    chip.className = 'chip rhyme-' + group;
    const label = document.createElement('span');
    label.textContent = group;
    wrap.append(chip, label);
    return wrap;
  });

  const note = document.createElement('span');
  note.className = 'swatch';
  note.textContent = '· wavy underline = internal rhyme';

  legend.replaceChildren(...swatches, note);
  legend.hidden = false;
}

function syncRhymeToggle() {
  const button = $('rhyme-toggle');
  const available = Boolean(lastResult && lastResult.rhyme_map);
  button.disabled = !available;
  button.setAttribute('aria-pressed', String(rhymeOverlayOn && available));
}

$('rhyme-toggle').addEventListener('click', () => {
  rhymeOverlayOn = !rhymeOverlayOn;
  renderLyrics(lastResult);
  renderRhymeLegend(lastResult);
  syncRhymeToggle();
});

// ---------------------------------------------------------------------------
// Draft history
// ---------------------------------------------------------------------------

/** Which stored draft the diff view is comparing against, if any. */
let comparedDraftId = null;

function draftLabel(draft) {
  if (draft.section) return 'Rewrote ' + draft.section;
  return draft.style_prompt ? draft.style_prompt.split(',')[0].trim() : 'Generation';
}

function describeDraftWhen(iso) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return at.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Renders the history. Every stored value is model output, so textContent. */
function renderDrafts() {
  const list = $('draft-list');
  const drafts = window.draftStore.list();

  if (drafts.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'memory-empty';
    empty.textContent = 'Nothing generated in this browser yet.';
    list.replaceChildren(empty);
    return;
  }

  list.replaceChildren(...drafts.map((draft) => {
    const item = document.createElement('li');
    item.className = 'draft-item';
    if (lastResult && draft.structured_lyrics === lastResult.structured_lyrics) {
      item.classList.add('current');
    }

    const top = document.createElement('div');
    top.className = 'draft-top';

    const label = document.createElement('span');
    label.className = 'draft-label';
    label.textContent = draftLabel(draft);

    const when = document.createElement('span');
    when.className = 'draft-when';
    when.textContent = describeDraftWhen(draft.saved_at);

    top.append(label, when);
    item.appendChild(top);

    const detail = document.createElement('div');
    detail.className = 'draft-detail';
    const firstLine = (draft.structured_lyrics || '')
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line && !(line.startsWith('[') && line.endsWith(']')));
    detail.textContent = firstLine || '(no lyric lines)';
    item.appendChild(detail);

    const actions = document.createElement('div');
    actions.className = 'draft-actions';

    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'btn-icon';
    restore.textContent = 'Restore';
    restore.addEventListener('click', () => restoreDraft(draft));

    const compare = document.createElement('button');
    compare.type = 'button';
    compare.className = 'btn-icon';
    compare.textContent = comparedDraftId === draft.id ? 'Hide changes' : 'Compare';
    compare.addEventListener('click', () => toggleDraftDiff(draft));

    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'btn-icon';
    drop.textContent = 'Delete';
    drop.addEventListener('click', () => {
      window.draftStore.remove(draft.id);
      if (comparedDraftId === draft.id) hideDraftDiff();
      renderDrafts();
    });

    actions.append(restore, compare, drop);
    item.appendChild(actions);
    return item;
  }));
}

/** Puts a stored draft back on screen, exports and bar grid included. */
function restoreDraft(draft) {
  lastResult = Object.assign({}, lastResult, {
    style_prompt: draft.style_prompt || '',
    structured_lyrics: draft.structured_lyrics || '',
    prosody: draft.prosody || null,
    bar_grid: draft.bar_grid || null,
    rhyme_map: draft.rhyme_map || null,
  });

  $('style-out').textContent = lastResult.style_prompt;
  renderLyrics(lastResult);
  renderRhymeLegend(lastResult);
  syncRhymeToggle();
  syncSchemeCapture();
  renderBarGrid(lastResult);
  syncSectionPicker(lastResult.structured_lyrics);
  $('export-txt-btn').disabled = false;
  $('export-csv-btn').disabled = false;
  hideDraftDiff();
  renderDrafts();
  setStatus($('draft-status'), 'Restored the draft from ' + describeDraftWhen(draft.saved_at) + '.', 'ok');
}

function hideDraftDiff() {
  comparedDraftId = null;
  $('draft-diff-wrap').hidden = true;
  $('draft-diff').replaceChildren();
}

function toggleDraftDiff(draft) {
  if (comparedDraftId === draft.id) {
    hideDraftDiff();
    renderDrafts();
    return;
  }

  const current = (lastResult && lastResult.structured_lyrics) || '';
  const rows = window.diffLines(draft.structured_lyrics || '', current);
  const summary = window.summarizeDiff(rows);

  $('draft-diff-summary').textContent =
    summary.added + ' added · ' + summary.removed + ' removed · ' + summary.unchanged + ' unchanged';

  $('draft-diff').replaceChildren(...rows.map((row) => {
    const line = document.createElement('div');
    line.className = row.type === 'added' ? 'add' : row.type === 'removed' ? 'del' : 'ctx';
    const marker = row.type === 'added' ? '+ ' : row.type === 'removed' ? '- ' : '  ';
    line.textContent = marker + row.text;
    return line;
  }));

  comparedDraftId = draft.id;
  $('draft-diff-wrap').hidden = false;
  renderDrafts();
}

/** Saves whatever is currently on screen, if it is worth keeping. */
function rememberDraft(result, section) {
  if (!result || !result.structured_lyrics) return;

  window.draftStore.save({
    id: (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)),
    saved_at: new Date().toISOString(),
    section: section || null,
    style_prompt: result.style_prompt || '',
    structured_lyrics: result.structured_lyrics,
    prosody: result.prosody || null,
    bar_grid: result.bar_grid || null,
    rhyme_map: result.rhyme_map || null,
  });
  renderDrafts();
}

$('clear-drafts-btn').addEventListener('click', () => {
  window.draftStore.clear();
  hideDraftDiff();
  renderDrafts();
  setStatus($('draft-status'), 'History cleared.', 'ok');
});

renderDrafts();

// ---------------------------------------------------------------------------
// Rewriting one section of the current sheet
// ---------------------------------------------------------------------------

/** Section headers of the sheet on screen, so the picker offers what exists. */
function sheetSectionNames(sheet) {
  const names = [];
  for (const raw of String(sheet || '').split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[') && line.endsWith(']')) {
      const name = line.slice(1, -1).trim();
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

function syncSectionPicker(sheet) {
  const select = $('rewrite-section');
  const names = sheetSectionNames(sheet);

  if (names.length === 0) {
    select.replaceChildren(Object.assign(document.createElement('option'), {
      value: '',
      textContent: 'Generate something first',
    }));
    select.disabled = true;
    $('rewrite-btn').disabled = true;
    return;
  }

  const previous = select.value;
  select.replaceChildren(...names.map((name) => {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    return option;
  }));
  if (names.includes(previous)) select.value = previous;

  select.disabled = false;
  $('rewrite-btn').disabled = false;
}

// ---------------------------------------------------------------------------
// Rhyme scheme presets
//
// What the writer pins here outranks both a named blend profile and whatever
// retrieval measured — see describeTargetMechanics in server.js. A blank field
// is not pinned at all, so the reference style still supplies it.
// ---------------------------------------------------------------------------

const SCHEME_FIELDS = ['scheme-pattern', 'scheme-avg', 'scheme-min', 'scheme-max', 'scheme-density'];

/** The panel read raw, for normalizing or saving. */
function schemeFieldValues() {
  return {
    rhyme_scheme: $('scheme-pattern').value,
    syllables_avg: $('scheme-avg').value,
    syllables_min: $('scheme-min').value,
    syllables_max: $('scheme-max').value,
    internal_rhyme_density: $('scheme-density').value,
  };
}

/**
 * The panel as the API's `scheme` payload, or undefined when nothing is pinned
 * — undefined so JSON.stringify drops the key rather than sending an empty
 * object the server would have to read as "pin nothing".
 */
function currentScheme() {
  return normalizeScheme(schemeFieldValues()) || undefined;
}

function fillSchemeFields(scheme) {
  const values = scheme || {};
  const number = (value) => (typeof value === 'number' ? String(value) : '');

  $('scheme-pattern').value = values.rhyme_scheme || '';
  $('scheme-avg').value = number(values.syllables_avg);
  $('scheme-min').value = number(values.syllables_min);
  $('scheme-max').value = number(values.syllables_max);

  // The select offers two positions because the generator only ever asks
  // "dense or sparse?" of this number, so snapping to the nearer one shows the
  // writer exactly the instruction their preset produces.
  const density = values.internal_rhyme_density;
  $('scheme-density').value = typeof density === 'number' ? (density >= 0.5 ? '0.8' : '0.1') : '';
}

function renderSchemePresets(selectedId) {
  const select = $('scheme-preset');
  const presets = schemeStore.all();

  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = 'Custom — not saved';

  select.replaceChildren(
    blank,
    ...presets.map((preset) => {
      const option = document.createElement('option');
      option.value = preset.id;
      // textContent throughout: a preset name is whatever the writer typed.
      option.textContent = preset.name + ' — ' + describeScheme(preset.scheme);
      return option;
    })
  );

  const selected = presets.find((preset) => preset.id === selectedId);
  select.value = selected ? selected.id : '';
  $('scheme-delete-btn').disabled = !selected || Boolean(selected.builtin);
}

function syncSchemeStatus() {
  const scheme = currentScheme();
  setStatus(
    $('scheme-status'),
    scheme
      ? 'Pinned: ' + describeScheme(scheme) + '. Applies to the next generation and to rewrites.'
      : 'Nothing pinned — the reference style sets the mechanics.'
  );
}

/** Capturing needs a measured sheet to copy from. */
function syncSchemeCapture() {
  const measured = lastResult && lastResult.prosody;
  $('scheme-capture-btn').disabled = typeof measured?.syllables_per_line?.avg !== 'number';
}

/** Editing any field means the panel is no longer the preset that filled it. */
function markSchemeCustom() {
  $('scheme-preset').value = '';
  $('scheme-delete-btn').disabled = true;
  syncSchemeStatus();
}

for (const id of SCHEME_FIELDS) {
  // Both events: `input` does not fire on a <select> in every browser.
  $(id).addEventListener('input', markSchemeCustom);
  $(id).addEventListener('change', markSchemeCustom);
}

$('scheme-preset').addEventListener('change', () => {
  const preset = schemeStore.find($('scheme-preset').value);
  if (preset) {
    fillSchemeFields(preset.scheme);
    // A built-in cannot be overwritten, so its name is not offered as one.
    $('scheme-name').value = preset.builtin ? '' : preset.name;
  }
  $('scheme-delete-btn').disabled = !preset || Boolean(preset.builtin);
  syncSchemeStatus();
});

$('scheme-save-btn').addEventListener('click', () => {
  const name = $('scheme-name').value.trim();
  if (!name) {
    setStatus($('scheme-status'), 'Name the template before saving it.', 'err');
    return;
  }

  const saved = schemeStore.save(name, schemeFieldValues());
  if (!saved) {
    setStatus($('scheme-status'), 'Pin at least one field before saving a template.', 'err');
    return;
  }

  renderSchemePresets(saved[0].id);
  setStatus($('scheme-status'), 'Saved "' + saved[0].name + '".', 'ok');
});

$('scheme-delete-btn').addEventListener('click', () => {
  const preset = schemeStore.find($('scheme-preset').value);
  if (!preset || preset.builtin) return;

  schemeStore.remove(preset.id);
  // The fields stay as they are: deleting a template should not quietly change
  // what the next generation is pinned to.
  renderSchemePresets('');
  setStatus($('scheme-status'), 'Deleted "' + preset.name + '". The pinned fields are unchanged.', 'ok');
});

$('scheme-clear-btn').addEventListener('click', () => {
  fillSchemeFields(null);
  $('scheme-name').value = '';
  renderSchemePresets('');
  syncSchemeStatus();
});

$('scheme-capture-btn').addEventListener('click', () => {
  const measured = lastResult && lastResult.prosody;
  if (typeof measured?.syllables_per_line?.avg !== 'number') return;

  const scheme = measured.rhyme_scheme;
  fillSchemeFields({
    // "mixed" and "unknown" are what the analyser says when it could not name a
    // shape; neither is an instruction the generator can follow.
    rhyme_scheme: scheme && scheme !== 'mixed' && scheme !== 'unknown' ? scheme : '',
    syllables_avg: Math.round(measured.syllables_per_line.avg),
    syllables_min: measured.syllables_per_line.min,
    syllables_max: measured.syllables_per_line.max,
    internal_rhyme_density: measured.internal_rhyme_density,
  });

  renderSchemePresets('');
  syncSchemeStatus();
});

renderSchemePresets('');
syncSchemeStatus();
syncSchemeCapture();

$('rewrite-btn').addEventListener('click', async () => {
  const status = $('rewrite-status');
  const button = $('rewrite-btn');
  const section = $('rewrite-section').value;

  if (!lastResult || !section) return;

  button.disabled = true;
  setStatus(status, 'Rewriting ' + section + '…', 'busy');

  try {
    const response = await fetch('/api/generate/section', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lyrics: lastResult.structured_lyrics || '',
        section,
        direction: $('rewrite-direction').value.trim(),
        genre: $('genre').value.trim(),
        theme: $('theme').value.trim(),
        bpm: $('bpm').value.trim(),
        cadence_profile_id: $('cadence-profile').value,
        imagery_profile_id: $('imagery-profile').value,
        tone: $('tone-mode').value,
        scheme: currentScheme(),
      }),
    });
    if (!response.ok) throw await asError(response);

    const result = await response.json();

    // Fold the rewrite into the result on screen so the bar grid, the exports
    // and a second rewrite all act on the updated sheet rather than the old one.
    lastResult = Object.assign({}, lastResult, {
      structured_lyrics: result.structured_lyrics,
      prosody: result.prosody,
      bar_grid: result.bar_grid,
      rhyme_map: result.rhyme_map,
    });

    renderLyrics(lastResult);
    renderRhymeLegend(lastResult);
    syncRhymeToggle();
    syncSchemeCapture();
    renderBarGrid(lastResult);
    syncSectionPicker(result.structured_lyrics);
    rememberDraft(lastResult, result.section);
    setStatus(status, 'Rewrote ' + result.section + '.', 'ok');
  } catch (err) {
    setStatus(status, err.message, 'err', err.details);
  } finally {
    button.disabled = !lastResult;
  }
});

// ---------------------------------------------------------------------------
// Duplicate detection after training
// ---------------------------------------------------------------------------

/** Renders the nearest existing profiles with their raw similarity scores. */
function renderDuplicates(matches) {
  const report = $('duplicate-report');
  const list = $('duplicate-list');
  const rows = Array.isArray(matches) ? matches : [];

  if (rows.length === 0) {
    list.replaceChildren();
    report.hidden = true;
    return;
  }

  list.replaceChildren(...rows.map((match) => {
    const item = document.createElement('li');
    item.className = 'dupe-item';

    const top = document.createElement('div');
    top.className = 'dupe-top';

    const name = document.createElement('span');
    name.className = 'dupe-name';
    name.textContent = match.source_name || 'profile';

    const score = document.createElement('span');
    score.className = 'dupe-score';
    score.textContent = typeof match.similarity === 'number'
      ? Math.round(match.similarity * 100) + '%'
      : '—';

    top.append(name, score);
    item.appendChild(top);

    if (typeof match.similarity === 'number') {
      const meter = document.createElement('div');
      meter.className = 'dupe-meter';
      const fill = document.createElement('span');
      // Clamped: a similarity outside 0-1 would otherwise render off the bar.
      fill.style.width = Math.max(0, Math.min(100, Math.round(match.similarity * 100))) + '%';
      meter.appendChild(fill);
      item.appendChild(meter);
    }

    const detail = document.createElement('div');
    detail.className = 'dupe-detail';
    detail.textContent = (match.feel || 'Unknown') + ' · ' + (match.cadence || 'Unknown');
    item.appendChild(detail);

    const actions = document.createElement('div');
    actions.className = 'dupe-actions';

    const forget = document.createElement('button');
    forget.type = 'button';
    forget.className = 'btn-icon';
    forget.textContent = 'Forget the older one';
    forget.addEventListener('click', () => forgetProfile(match.id, forget));
    actions.appendChild(forget);

    if ((match.tags || []).length) {
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'btn-icon';
      copy.textContent = 'Copy its tags to the new one';
      copy.addEventListener('click', () => copyTags(match, copy));
      actions.appendChild(copy);
    }

    item.appendChild(actions);
    return item;
  }));

  report.hidden = false;
}

/** The profile just trained, so its tags can inherit from a near-duplicate. */
let lastTrainedProfileId = null;

async function copyTags(match, button) {
  if (!lastTrainedProfileId) return;

  button.disabled = true;
  const original = button.textContent;
  button.textContent = 'Copying…';

  try {
    const response = await fetch(
      '/api/style-memory/' + encodeURIComponent(lastTrainedProfileId) + '/tags',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: match.tags || [] }),
      }
    );
    if (!response.ok) throw await asError(response);

    button.textContent = 'Tags copied';
    loadStyleMemory();
  } catch (err) {
    button.disabled = false;
    button.textContent = original;
    setStatus($('trainer-status'), err.message, 'err', err.details);
  }
}

function syncTrainButton() {
  $('train-style-btn').disabled = $('trainer-text').value.trim().length === 0;
}

$('trainer-text').addEventListener('input', syncTrainButton);

$('train-style-btn').addEventListener('click', async () => {
  const status = $('trainer-status');
  const button = $('train-style-btn');
  const referenceText = $('trainer-text').value.trim();
  const title = $('trainer-title').value.trim();

  if (!referenceText) return;

  button.disabled = true;
  status.className = 'status busy';
  status.innerHTML = '';
  status.appendChild(Object.assign(document.createElement('span'), { className: 'spinner' }));
  status.appendChild(document.createTextNode('Reading the style…'));

  try {
    const response = await fetch('/api/train-style', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reference_text: referenceText, title }),
    });
    if (!response.ok) throw await asError(response);

    const result = await response.json();
    const dna = result.style_dna || {};

    $('trainer-feel').textContent = dna.feel || 'Unknown';
    $('trainer-cadence').textContent = dna.cadence || 'Unknown';
    paintPills($('trainer-domains'), dna.metaphor_domains, 'badge-domain');
    paintPills($('trainer-devices'), dna.literary_devices, 'badge-cadence');
    $('trainer-summary').textContent = result.summary || '';
    lastTrainedProfileId = result.profile_id || null;
    renderDuplicates(result.similar_profiles);
    $('trainer-results').hidden = false;

    setStatus(
      status,
      'Style saved — read from ' + result.reference_chars +
        ' characters. Later generations will draw on it.',
      'ok'
    );
    loadStyleMemory();
  } catch (err) {
    // A status message, not alert(): the rest of the page reports this way.
    setStatus(status, err.message, 'err', err.details);
  } finally {
    syncTrainButton();
  }
});

syncTrainButton();
