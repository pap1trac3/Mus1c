require('dotenv').config({ quiet: true });

const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const OpenAI = require('openai');
const { DataAPIClient } = require('@datastax/astra-db-ts');
const { VaultRepository } = require('./lib/vaultRepository');
const { AppError, attempt, asyncHandler } = require('./lib/errors');

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

You must return ONLY a JSON object with exactly two keys:
- "style_prompt": a concise, comma-separated string of production/style tags (genre, tempo, instrumentation, vocal timbre, acoustics, mood) suitable for pasting directly into an AI music generator's style field.
- "structured_lyrics": a full lyric sheet formatted for AI vocal synthesis, using:
  - Bracketed section headers, e.g. [Intro], [Verse 1], [Pre-Chorus], [Chorus], [Bridge], [Outro]
  - Bracketed performance/production tags inline where useful, e.g. [soft female vocal], [building energy], [whispered], [ad-lib]
  - Hyphenated melisma for held/stretched syllables, e.g. "be-au-ti-ful", "for-ev-er"
  - Micro-pauses represented with ellipses "..." to indicate short breath or rhythmic pauses
  - Natural, singable phrasing consistent with the requested genre and theme

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

  return parseMozartOutput(completion.choices[0]?.message?.content);
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
  });

  if (onStart) onStart(stream);

  let raw = '';
  for await (const chunk of stream) {
    const token = chunk.choices[0]?.delta?.content || '';
    if (token) {
      raw += token;
      onToken(token);
    }
  }

  return parseMozartOutput(raw);
}

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------

const app = express();

app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:5173' }));
app.use(express.json({ limit: '1mb' }));

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'mozart-ai-music-generator',
    timestamp: new Date().toISOString(),
  });
});

app.post('/api/ingest', asyncHandler(async (req, res) => {
  const { transcript, metadata = {} } = req.body || {};

  if (typeof transcript !== 'string' || transcript.trim().length === 0) {
    return res.status(400).json({ error: 'transcript is required and must be a non-empty string' });
  }

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

app.post('/api/generate', asyncHandler(async (req, res) => {
  const {
    genre,
    bpm,
    key,
    vocal_timbre,
    acoustics,
    theme,
    retrieval_limit,
  } = req.body || {};

  if (!genre && !theme) {
    return res.status(400).json({ error: 'At least one of "genre" or "theme" is required' });
  }

  const limit = Number.isInteger(retrieval_limit) && retrieval_limit > 0 ? retrieval_limit : 8;

  // Retrieval runs before any response is committed, so a failure here still
  // returns the standard JSON error shape via the centralized handler.
  const { retrieved, sections, context } = await attempt('Failed to generate Mozart AI output', async () => {
    const queryText = [genre, theme, vocal_timbre, acoustics]
      .filter((part) => typeof part === 'string' && part.trim().length > 0)
      .join(', ');

    const queryEmbedding = await createEmbedding(queryText);
    const retrieved = await vaultRepo.findSimilar(queryEmbedding, { limit });

    const sections = groupRetrievedChunks(retrieved);
    const context = sections
      .map((section) => `[Source: ${section.document_id}]\n${section.text}`)
      .join('\n\n');

    return { retrieved, sections, context };
  });

  const generationParams = { genre, bpm, key, vocal_timbre, acoustics, theme, context };

  if (!wantsEventStream(req)) {
    const output = await attempt('Failed to generate Mozart AI output', () =>
      generateMozartOutput(generationParams)
    );

    return res.json({
      style_prompt: output.style_prompt,
      structured_lyrics: output.structured_lyrics,
      retrieved_chunks: retrieved.length,
      retrieved_documents: sections.length,
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

  try {
    const output = await generateMozartOutputStream(
      generationParams,
      (token) => {
        if (!clientGone) res.write(`data: ${JSON.stringify({ token })}\n\n`);
      },
      (stream) => {
        upstream = stream;
        if (clientGone) stream.controller.abort();
      }
    );

    if (clientGone) return;

    // Final event mirrors the non-streaming response body, so clients never
    // have to reassemble and parse the token stream themselves.
    res.write(
      `event: complete\ndata: ${JSON.stringify({
        style_prompt: output.style_prompt,
        structured_lyrics: output.structured_lyrics,
        retrieved_chunks: retrieved.length,
        retrieved_documents: sections.length,
      })}\n\n`
    );
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    if (clientGone) return;
    console.error('Failed to generate Mozart AI output (stream):', err);
    res.write(
      `event: error\ndata: ${JSON.stringify({
        error: 'Failed to generate Mozart AI output',
        details: err.message,
      })}\n\n`
    );
    res.end();
  }
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
    console.error(`${err.publicMessage}:`, err.cause);
    return res.status(500).json({ error: err.publicMessage, details: err.cause?.message });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Mozart AI Music Generator listening on port ${PORT}`);
  });
}

module.exports = { app, chunkText, createEmbedding, generateMozartOutput, groupRetrievedChunks };
