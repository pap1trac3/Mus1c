// server.js validates required env vars and constructs the OpenAI/Astra
// clients at import time, so these must be set before the first require.
process.env.OPENAI_API_KEY = 'test-key';
process.env.ASTRA_DB_API_ENDPOINT = 'https://example.apps.astra.datastax.com';
process.env.ASTRA_DB_APPLICATION_TOKEN = 'AstraCS:test-token';

const http = require('http');
const request = require('supertest');

const mockChatCreate = jest.fn();

jest.mock('../../lib/vaultRepository', () => ({
  VaultRepository: jest.fn().mockImplementation(() => ({
    insertChunks: jest.fn().mockResolvedValue({ insertedCount: 1 }),
    findSimilar: jest.fn().mockResolvedValue([
      {
        transcript: 'Vault lyric line 1',
        metadata: { document_id: 'doc_1', chunk_index: 0 },
      },
    ]),
  })),
}));

jest.mock('openai', () =>
  jest.fn().mockImplementation(() => ({
    embeddings: {
      create: jest.fn().mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
    },
    chat: { completions: { create: mockChatCreate } },
  }))
);

const { app } = require('../../server');

const OUTPUT = {
  style_prompt: 'Opera, D-minor, 120 bpm',
  structured_lyrics: '[Verse 1]\nClassical notes...',
};

// The JSON payload split across deltas, as the real API would deliver it.
const TOKENS = JSON.stringify(OUTPUT).match(/.{1,12}/g);

/** Mimics the SDK's Stream: async-iterable plus an abort controller. */
function mockStream(tokens, { delayMs = 0, throwAfter = null } = {}) {
  const controller = { abort: jest.fn() };
  return {
    controller,
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < tokens.length; i++) {
        if (throwAfter !== null && i === throwAfter) {
          throw new Error('upstream exploded');
        }
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        yield { choices: [{ delta: { content: tokens[i] } }] };
      }
    },
  };
}

/** Parses an SSE body into { tokens, complete, error, done }. */
function parseSse(body) {
  const result = { tokens: [], complete: null, error: null, done: false };

  for (const frame of body.split('\n\n')) {
    if (!frame.trim()) continue;

    let eventName = 'message';
    let data = '';
    for (const line of frame.split('\n')) {
      if (line.startsWith('event: ')) eventName = line.slice(7);
      else if (line.startsWith('data: ')) data = line.slice(6);
    }

    if (data === '[DONE]') {
      result.done = true;
    } else if (eventName === 'complete') {
      result.complete = JSON.parse(data);
    } else if (eventName === 'error') {
      result.error = JSON.parse(data);
    } else if (data) {
      result.tokens.push(JSON.parse(data).token);
    }
  }

  return result;
}

beforeEach(() => {
  mockChatCreate.mockReset();
});

describe('POST /api/generate - SSE streaming', () => {
  it('streams token frames, a complete event, and [DONE] when stream:true', async () => {
    mockChatCreate.mockImplementation((params) => {
      expect(params.stream).toBe(true);
      return Promise.resolve(mockStream(TOKENS));
    });

    const res = await request(app)
      .post('/api/generate')
      .send({ genre: 'Opera', theme: 'Thunderstorm', stream: true });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.headers['cache-control']).toMatch(/no-cache/);

    const sse = parseSse(res.text);
    expect(sse.tokens).toEqual(TOKENS);
    expect(sse.tokens.join('')).toBe(JSON.stringify(OUTPUT));
    expect(sse.done).toBe(true);

    // Final event mirrors the non-streaming response body exactly.
    expect(sse.complete).toEqual({
      style_prompt: OUTPUT.style_prompt,
      structured_lyrics: OUTPUT.structured_lyrics,
      retrieved_chunks: 1,
      retrieved_documents: 1,
      degraded: false,
    });
  });

  it('streams when the Accept header lists event-stream among other types', async () => {
    mockChatCreate.mockResolvedValue(mockStream(TOKENS));

    const res = await request(app)
      .post('/api/generate')
      .set('Accept', 'text/event-stream, */*')
      .send({ genre: 'Opera', theme: 'Thunderstorm' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(parseSse(res.text).done).toBe(true);
  });

  it('still returns buffered JSON when streaming is not requested', async () => {
    mockChatCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify(OUTPUT) } }],
    });

    const res = await request(app)
      .post('/api/generate')
      .send({ genre: 'Opera', theme: 'Thunderstorm' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({
      style_prompt: OUTPUT.style_prompt,
      structured_lyrics: OUTPUT.structured_lyrics,
      retrieved_chunks: 1,
      retrieved_documents: 1,
      degraded: false,
    });
    expect(mockChatCreate.mock.calls[0][0].stream).toBeUndefined();
  });

  it('returns a normal JSON 400 for invalid input even with stream:true', async () => {
    const res = await request(app).post('/api/generate').send({ stream: true });

    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.error).toMatch(/genre.*or.*theme.*required/i);
    expect(mockChatCreate).not.toHaveBeenCalled();
  });

  it('emits an error event instead of a JSON 500 when the stream fails mid-flight', async () => {
    mockChatCreate.mockResolvedValue(mockStream(TOKENS, { throwAfter: 2 }));

    const res = await request(app)
      .post('/api/generate')
      .send({ genre: 'Opera', theme: 'Thunderstorm', stream: true });

    // Status is already committed as 200 by the time the failure happens.
    expect(res.statusCode).toBe(200);

    const sse = parseSse(res.text);
    expect(sse.tokens).toEqual(TOKENS.slice(0, 2));
    expect(sse.error).toEqual({
      error: 'Failed to generate Mozart AI output',
      details: 'upstream exploded',
    });
    expect(sse.done).toBe(false);
  });

  it('aborts the upstream request when the client disconnects', async () => {
    const stream = mockStream(TOKENS, { delayMs: 30 });
    // Resolve as soon as the route aborts, rather than sleeping a fixed time.
    const aborted = new Promise((resolve) => stream.controller.abort.mockImplementation(resolve));
    mockChatCreate.mockResolvedValue(stream);

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const { port } = server.address();

    const req = http.request(
      { port, path: '/api/generate', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      (res) => {
        // Drop the connection as soon as the first token lands.
        res.once('data', () => req.destroy());
        res.on('error', () => {});
      }
    );
    req.on('error', () => {});
    req.end(JSON.stringify({ genre: 'Opera', theme: 'Thunderstorm', stream: true }));

    await aborted;
    expect(stream.controller.abort).toHaveBeenCalled();

    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
});
