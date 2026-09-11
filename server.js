require('dotenv').config({ quiet: true });

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const OpenAI = require('openai');
const { DataAPIClient } = require('@datastax/astra-db-ts');
const { VaultRepository } = require('./lib/vaultRepository');
const { AppError, attempt, asyncHandler } = require('./lib/errors');
const { ingestSchema, generateSchema, validateBody } = require('./lib/validation');
const { apiLimiter, strictLimiter } = require('./lib/rateLimiters');
const { logger, httpLogger } = require('./lib/logger');
const { createReadinessChecker } = require('./lib/readiness');
const { withRetry } = require('./lib/retry');
const { createHeartbeat } = require('./lib/sse');
const { sanitizeMelody, clampTempo, MAX_EVENTS } = require('./lib/melody');
const {
  reelUpload,
  analysisSystemPrompt,
  parseAnalysis,
  MAX_UPLOAD_BYTES,
  TRANSCRIBE_MODEL,
} = require('./lib/reel');
const { toFile } = require('openai');

const COLLECTION_NAME = 'lyric_vault';
const EMBEDDING_MODEL = 'text-embedding-3-small';

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

const REQUIRED_ENV_VARS = ['OPENAI_API_KEY', 'ASTRA_DB_API_ENDPOINT', 'ASTRA_DB_APPLICATION_TOKEN'];

function validateEnv() {
  const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error(`Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }
}

validateEnv();

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const dataApiClient = new DataAPIClient(process.env.ASTRA_DB_APPLICATION_TOKEN);
const db = dataApiClient.db(
  process.env.ASTRA_DB_API_ENDPOINT,
  process.env.ASTRA_DB_KEYSPACE ? { keyspace: process.env.ASTRA_DB_KEYSPACE } : undefined
);
const lyricVault = db.collection(COLLECTION_NAME);
const vaultRepo = new VaultRepository(lyricVault);
const checkReadiness = createReadinessChecker({ vaultRepo, openai });

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/**
 * Sliding-window chunker for long transcripts.
 */
function chunkText(text, chunkSize = 1000, overlap = 200) {
  if (typeof text !== 'string' || text.trim().length === 0) return [];

  const step = overlap < chunkSize ? chunkSize - overlap : chunkSize;
  const chunks = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    const chunk = text.slice(start, end).trim();
    if (chunk.length > 0) chunks.push(chunk);
    if (end === text.length) break;
    start += step;
  }

  return chunks;
}

/**
 * Generates a 1536-dim embedding via text-embedding-3-small.
 */
async function createEmbedding(input) {
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input,
  });
  return response.data[0].embedding;
}

/**
 * Groups retrieved chunks by their source document, dedupes, and orders
 * each group sequentially by chunk_index so the compiled context reads
 * as a coherent transcript rather than a jumble of fragments.
 */
function groupRetrievedChunks(documents) {
  const groups = new Map();
  const order = [];

  for (const doc of documents) {
    const metadata = doc.metadata || {};
    const groupKey = metadata.document_id || metadata.source || doc._id;

    if (!groups.has(groupKey)) {
      groups.set(groupKey, []);
      order.push(groupKey);
    }
    groups.get(groupKey).push(doc);
  }

  return order.map((groupKey) => {
    const docs = groups.get(groupKey).sort((a, b) => {
      const aIndex = a.metadata?.chunk_index ?? 0;
      const bIndex = b.metadata?.chunk_index ?? 0;
      return aIndex - bIndex;
    });

    return {
      document_id: groupKey,
      text: docs.map((d) => d.transcript).join(' '),
    };
  });
}

/**
 * Streaming is opt-in via `stream: true` or an Accept header requesting SSE.
 * Matched as a substring because clients commonly send a list of accepted
 * types rather than the bare type.
 */
function wantsEventStream(req) {
  if (req.body?.stream === true) return true;
  return (req.headers.accept || '').includes('text/event-stream');
}

/**
 * Builds the chat messages for a generation request. Shared by the buffered
 * and streaming paths so the two can never drift apart.
 */
function buildMozartMessages(params) {
  const { genre, bpm, key, vocal_timbre, acoustics, theme, context } = params;

  const systemPrompt = `You are Mozart AI, an expert AI music producer and vocal arranger. You generate prompts for AI music generation platforms (such as Suno or Udio) from a set of musical parameters and reference lyric context.

You must return ONLY a JSON object with exactly four keys:
- "style_prompt": a concise, comma-separated string of production/style tags (genre, tempo, instrumentation, vocal timbre, acoustics, mood) suitable for pasting directly into an AI music generator's style field.
- "structured_lyrics": a full lyric sheet formatted for AI vocal synthesis, using:
  - Bracketed section headers, e.g. [Intro], [Verse 1], [Pre-Chorus], [Chorus], [Bridge], [Outro]
  - Bracketed performance/production tags inline where useful, e.g. [soft female vocal], [building energy], [whispered], [ad-lib]
  - Hyphenated melisma for held/stretched syllables, e.g. "be-au-ti-ful", "for-ev-er"
  - Micro-pauses represented with ellipses "..." to indicate short breath or rhythmic pauses
  - Natural, singable phrasing consistent with the requested genre and theme
- "tempo_bpm": the tempo of the piece as a number between 30 and 300.
- "melody": a short playable motif from the piece, as an array of at most ${MAX_EVENTS} note events. Each event is an object:
  - "note": scientific pitch notation (e.g. "D4", "F#3", "Bb5"), or an array of such strings for a chord
  - "duration": one of "1n", "2n", "4n", "8n", "16n", "32n", optionally dotted ("4n.") or triplet ("8t")
  - "time": transport position as "bar:beat:sixteenth" (e.g. "0:0:0", "1:2:2")
  Keep it to 2-8 bars in the stated key, musically consistent with the style and lyrics.

Do not include any commentary, markdown formatting, or text outside the JSON object.`;

  const userPrompt = `Generate a Mozart AI music & vocal prompt using the following parameters:

Genre: ${genre || 'unspecified'}
BPM: ${bpm || 'unspecified'}
Key: ${key || 'unspecified'}
Vocal Timbre: ${vocal_timbre || 'unspecified'}
Acoustics: ${acoustics || 'unspecified'}
Theme: ${theme || 'unspecified'}

Reference context retrieved from the lyric vault (use for inspiration, phrasing, and thematic continuity — do not copy verbatim):
${context && context.trim().length > 0 ? context : 'No reference context available.'}

Return the JSON object now.`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
}

/** Normalizes a raw model response into the documented output shape. */
function parseMozartOutput(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw || '{}');
  } catch (err) {
    throw new Error('Failed to parse Mozart AI generation output as JSON');
  }

  return {
    style_prompt: parsed.style_prompt || '',
    structured_lyrics: parsed.structured_lyrics || '',
    tempo_bpm: clampTempo(parsed.tempo_bpm),
    melody: sanitizeMelody(parsed.melody),
  };
}

/**
 * Sends the compiled prompt & retrieved context to OpenAI Chat Completions,
 * returning structured JSON: { style_prompt, structured_lyrics }.
 */
async function generateMozartOutput(params) {
  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_GENERATION_MODEL || 'gpt-4o-mini',
    messages: buildMozartMessages(params),
    response_format: { type: 'json_object' },
    temperature: 0.85,
  });

  return {
    ...parseMozartOutput(completion.choices[0]?.message?.content),
    usage: completion.usage || null,
  };
}

/**
 * Streaming counterpart of generateMozartOutput: invokes `onToken` for each
 * delta as it arrives and returns the same parsed shape once complete.
 * The returned stream's controller is handed to `onStart` so the caller can
 * abort the upstream request when the client disconnects.
 */
async function generateMozartOutputStream(params, onToken, onStart) {
  const stream = await openai.chat.completions.create({
    model: process.env.OPENAI_GENERATION_MODEL || 'gpt-4o-mini',
    messages: buildMozartMessages(params),
    response_format: { type: 'json_object' },
    temperature: 0.85,
    stream: true,
    // Emits a final usage-bearing chunk, so streamed requests report real
    // token counts instead of a count of SSE deltas.
    stream_options: { include_usage: true },
  });

  if (onStart) onStart(stream);

  let raw = '';
  let chunks = 0;
  let usage = null;

  for await (const chunk of stream) {
    if (chunk.usage) usage = chunk.usage; // final chunk carries usage, no choices
    const token = chunk.choices?.[0]?.delta?.content || '';
    if (token) {
      raw += token;
      chunks += 1;
      onToken(token);
    }
  }

  return { ...parseMozartOutput(raw), usage, chunks };
}

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------

const app = express();

app.use(httpLogger);
// Tone.js compiles its AudioWorklet from a blob: URL, which the default
// script-src 'self' blocks outright. blob: is narrow — same-origin script can
// only create blobs from content it already has — unlike allowlisting a
// third-party CDN origin, which is why Tone is vendored rather than linked.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        'script-src': ["'self'", 'blob:'],
        'worker-src': ["'self'", 'blob:'],
      },
    },
  })
);
app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:5173' }));
app.use(express.json({ limit: '1mb' }));

// __dirname, not a bare 'public', so the server works regardless of cwd.
app.use(express.static(path.join(__dirname, 'public')));

// Broad ceiling on API traffic; /health stays unlimited so container
// healthchecks never consume the budget.
app.use('/api', apiLimiter);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Liveness: is this process up? Deliberately does not touch upstreams —
// container healthchecks poll it on a short interval, and a transient Astra
// or OpenAI blip should not get a healthy process killed and restarted.
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'mozart-ai-music-generator',
    timestamp: new Date().toISOString(),
    uptime_s: Math.round(process.uptime()),
  });
});

// Readiness: can this process actually serve traffic? Probes upstreams for
// real and returns 503 when one is down, so a load balancer can drain it.
app.get('/ready', asyncHandler(async (req, res) => {
  const result = await checkReadiness({ force: req.query.force === 'true' });
  res.status(result.ready ? 200 : 503).json({
    ...result,
    service: 'mozart-ai-music-generator',
    timestamp: new Date().toISOString(),
  });
}));

app.post('/api/ingest', strictLimiter, validateBody(ingestSchema), asyncHandler(async (req, res) => {
  const { transcript, metadata = {} } = req.body;

  const documentId = metadata.document_id || crypto.randomUUID();
  const chunks = chunkText(transcript);

  if (chunks.length === 0) {
    return res.status(400).json({ error: 'transcript did not produce any chunks' });
  }

  await attempt('Failed to ingest transcript', async () => {
    // Chunks are embedded in parallel (Promise.all preserves input order,
    // so embeddings[i] still corresponds to chunks[i]) instead of one
    // sequential OpenAI round-trip per chunk.
    const embeddings = await Promise.all(chunks.map((chunk) => createEmbedding(chunk)));

    const documents = chunks.map((chunk, i) => ({
      $vector: embeddings[i],
      transcript: chunk,
      metadata: {
        ...metadata,
        document_id: documentId,
        chunk_index: i,
        total_chunks: chunks.length,
      },
    }));

    await vaultRepo.insertChunks(documents);
  });

  res.status(201).json({
    success: true,
    document_id: documentId,
    chunks_ingested: chunks.length,
  });
}));

app.post('/api/generate', strictLimiter, validateBody(generateSchema), asyncHandler(async (req, res) => {
  const { genre, bpm, key, vocal_timbre, acoustics, theme, retrieval_limit } = req.body;

  const limit = Number.isInteger(retrieval_limit) && retrieval_limit > 0 ? retrieval_limit : 8;
  const startedAt = Date.now();
  const streaming = wantsEventStream(req);

  req.log.info({ genre, theme, limit, streaming }, 'generation requested');

  // Retrieval is best-effort: context improves the result but isn't required
  // to produce one, so an upstream failure degrades to an unguided generation
  // rather than failing the request. The embedding call is left to the OpenAI
  // SDK's own retry; only the Astra call is wrapped, as it has none.
  let retrieved = [];
  let sections = [];
  let context = '';
  let degraded = false;

  try {
    const queryText = [genre, theme, vocal_timbre, acoustics]
      .filter((part) => typeof part === 'string' && part.trim().length > 0)
      .join(', ');

    const queryEmbedding = await createEmbedding(queryText);
    retrieved = await withRetry(() => vaultRepo.findSimilar(queryEmbedding, { limit }), {
      log: req.log,
      label: 'vault retrieval',
    });

    sections = groupRetrievedChunks(retrieved);
    context = sections
      .map((section) => `[Source: ${section.document_id}]\n${section.text}`)
      .join('\n\n');
  } catch (err) {
    degraded = true;
    req.log.warn({ err: err.message }, 'retrieval failed; generating without vault context');
  }

  const retrievalMs = Date.now() - startedAt;
  req.log.info(
    { retrieval_ms: retrievalMs, retrieved_chunks: retrieved.length, retrieved_documents: sections.length },
    'vault retrieval complete'
  );

  const generationParams = { genre, bpm, key, vocal_timbre, acoustics, theme, context };

  if (!streaming) {
    const generationStartedAt = Date.now();
    const output = await attempt('Failed to generate Mozart AI output', () =>
      generateMozartOutput(generationParams)
    );

    req.log.info(
      {
        streaming: false,
        retrieval_ms: retrievalMs,
        generation_ms: Date.now() - generationStartedAt,
        total_ms: Date.now() - startedAt,
        usage: output.usage,
        degraded,
      },
      'generation complete'
    );

    return res.json({
      style_prompt: output.style_prompt,
      structured_lyrics: output.structured_lyrics,
      tempo_bpm: output.tempo_bpm,
      melody: output.melody,
      retrieved_chunks: retrieved.length,
      retrieved_documents: sections.length,
      degraded,
    });
  }

  // --- SSE path -----------------------------------------------------------
  // Past this point the status line is already committed, so failures are
  // reported as an `error` event rather than through the JSON error handler.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // don't let nginx buffer the stream
  });
  res.flushHeaders();

  // Keeps the connection alive through long gaps between tokens; cleared on
  // completion, failure, or disconnect. Tunable because proxy idle timeouts
  // vary widely (Cloudflare ~100s, some load balancers 30s).
  const stopHeartbeat = createHeartbeat(res, {
    intervalMs: Number(process.env.SSE_HEARTBEAT_MS) || undefined,
  });

  let upstream = null;
  let clientGone = false;
  // Must be res, not req: for a POST, req 'close' fires as soon as the body
  // has been consumed, which is immediately — res 'close' before
  // writableEnded is the actual client-disconnect signal.
  res.on('close', () => {
    if (res.writableEnded) return;
    clientGone = true;
    // Stop consuming (and paying for) tokens the client will never receive.
    if (upstream) upstream.controller.abort();
  });

  const generationStartedAt = Date.now();
  let ttftMs = null;

  try {
    const output = await generateMozartOutputStream(
      generationParams,
      (token) => {
        if (ttftMs === null) {
          // Measured from request start, so it includes retrieval — that is
          // what the user actually waits through before seeing anything.
          ttftMs = Date.now() - startedAt;
          req.log.info({ ttft_ms: ttftMs, retrieval_ms: retrievalMs }, 'first token streamed');
        }
        if (!clientGone) res.write(`data: ${JSON.stringify({ token })}\n\n`);
      },
      (stream) => {
        upstream = stream;
        if (clientGone) stream.controller.abort();
      }
    );

    if (clientGone) {
      stopHeartbeat();
      req.log.warn(
        { ttft_ms: ttftMs, total_ms: Date.now() - startedAt },
        'client disconnected before completion'
      );
      return;
    }

    req.log.info(
      {
        streaming: true,
        retrieval_ms: retrievalMs,
        ttft_ms: ttftMs,
        generation_ms: Date.now() - generationStartedAt,
        total_ms: Date.now() - startedAt,
        stream_chunks: output.chunks,
        usage: output.usage,
        degraded,
      },
      'generation complete'
    );

    // Final event mirrors the non-streaming response body, so clients never
    // have to reassemble and parse the token stream themselves.
    stopHeartbeat();
    res.write(
      `event: complete\ndata: ${JSON.stringify({
        style_prompt: output.style_prompt,
        structured_lyrics: output.structured_lyrics,
        tempo_bpm: output.tempo_bpm,
        melody: output.melody,
        retrieved_chunks: retrieved.length,
        retrieved_documents: sections.length,
        degraded,
      })}\n\n`
    );
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    stopHeartbeat();
    if (clientGone) return;
    req.log.error({ err, ttft_ms: ttftMs, total_ms: Date.now() - startedAt }, 'generation stream failed');
    res.write(
      `event: error\ndata: ${JSON.stringify({
        error: 'Failed to generate Mozart AI output',
        details: err.message,
      })}\n\n`
    );
    res.end();
  }
}));

/**
 * Transcribes an uploaded clip, derives abstract style features from it, and
 * writes original lyrics on the caller's topic.
 *
 * The transcript is deliberately never persisted or returned: it is a verbatim
 * copy of someone else's work, and only the derived style is needed downstream.
 */
app.post('/api/analyze-reel', strictLimiter, (req, res, next) => {
  reelUpload(req, res, (err) => {
    if (!err) return next();

    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: `Clip is too large. The transcription API accepts up to ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB — trim the clip or export audio only.`,
      });
    }
    if (err.code === 'UNSUPPORTED_MEDIA') {
      return res.status(415).json({ error: 'Unsupported file type. Use mp3, mp4, m4a, wav, or webm.' });
    }
    return res.status(400).json({ error: 'Upload failed', details: err.message });
  });
}, asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No reel file provided.' });
  }

  const topic = typeof req.body.topic === 'string' ? req.body.topic.trim().slice(0, 300) : '';
  if (!topic) {
    return res.status(400).json({ error: 'A topic for the new lyrics is required.' });
  }

  const startedAt = Date.now();
  req.log.info(
    { bytes: req.file.size, mimetype: req.file.mimetype, topic_length: topic.length },
    'reel analysis requested'
  );

  const transcript = await attempt('Failed to transcribe the clip', async () => {
    const upload = await toFile(req.file.buffer, req.file.originalname || 'reel.mp4', {
      type: req.file.mimetype,
    });
    const result = await openai.audio.transcriptions.create({
      file: upload,
      model: TRANSCRIBE_MODEL,
    });
    return (result.text || '').trim();
  });

  const transcribedMs = Date.now() - startedAt;
  // Length only — the transcript itself stays out of the logs.
  req.log.info({ transcribe_ms: transcribedMs, transcript_chars: transcript.length }, 'clip transcribed');

  const analysis = await attempt('Failed to analyze the clip', async () => {
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_GENERATION_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: analysisSystemPrompt },
        {
          role: 'user',
          content: `Topic for the new lyrics: ${topic}\n\nTranscript of the clip:\n${transcript || '(no speech detected)'}`,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.85,
    });
    return parseAnalysis(completion.choices[0]?.message?.content);
  });

  req.log.info(
    { transcribe_ms: transcribedMs, total_ms: Date.now() - startedAt },
    'reel analysis complete'
  );

  res.json({
    style_dna: analysis.style_dna,
    generated_lyrics: analysis.generated_lyrics,
    transcript_chars: transcript.length,
  });
}));

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Centralized error handling: reproduces each route's original response
// shape from a single place instead of duplicating try/catch/log/respond
// in every handler. AppError carries the route-specific public message;
// anything else (a genuinely unexpected failure) falls back to the same
// generic response the old catch-all middleware returned.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof AppError) {
    (req.log || logger).error({ err: err.cause }, err.publicMessage);
    return res.status(500).json({ error: err.publicMessage, details: err.cause?.message });
  }
  (req.log || logger).error({ err }, 'unhandled error');
  res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  app.listen(PORT, () => {
    logger.info({ port: PORT }, 'Mozart AI Music Generator listening');
  });
}

module.exports = { app, chunkText, createEmbedding, generateMozartOutput, groupRetrievedChunks };
