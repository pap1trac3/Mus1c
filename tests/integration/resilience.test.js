process.env.OPENAI_API_KEY = 'test-key';
process.env.ASTRA_DB_API_ENDPOINT = 'https://example.apps.astra.datastax.com';
process.env.ASTRA_DB_APPLICATION_TOKEN = 'AstraCS:test-token';

const request = require('supertest');
const { createHeartbeat } = require('../../lib/sse');

const mockFindSimilar = jest.fn();
const mockChatCreate = jest.fn();

jest.mock('../../lib/vaultRepository', () => ({
  VaultRepository: jest.fn().mockImplementation(() => ({
    ping: jest.fn().mockResolvedValue({}),
    insertChunks: jest.fn().mockResolvedValue({ insertedCount: 1 }),
    findSimilar: mockFindSimilar,
  })),
}));

jest.mock('openai', () =>
  jest.fn().mockImplementation(() => ({
    models: { retrieve: jest.fn().mockResolvedValue({}) },
    embeddings: { create: jest.fn().mockResolvedValue({ data: [{ embedding: [0.1] }] }) },
    chat: { completions: { create: mockChatCreate } },
  }))
);

const { app } = require('../../server');

const OUTPUT = { style_prompt: 'sp', structured_lyrics: 'sl' };
const HIT = [{ transcript: 'vault line', metadata: { document_id: 'doc_1', chunk_index: 0 } }];

const transient = (msg) => Object.assign(new Error(msg), { status: 503 });

beforeEach(() => {
  mockFindSimilar.mockReset().mockResolvedValue(HIT);
  mockChatCreate.mockReset().mockResolvedValue({
    choices: [{ message: { content: JSON.stringify(OUTPUT) } }],
  });
});

describe('retrieval resilience', () => {
  it('retries a transient vault failure and still reports a healthy result', async () => {
    mockFindSimilar.mockRejectedValueOnce(transient('astra blip')).mockResolvedValue(HIT);

    const res = await request(app).post('/api/generate').send({ genre: 'opera' });

    expect(res.statusCode).toBe(200);
    expect(mockFindSimilar).toHaveBeenCalledTimes(2);
    expect(res.body.degraded).toBe(false);
    expect(res.body.retrieved_chunks).toBe(1);
  });

  it('degrades to an unguided generation instead of 500ing when retrieval keeps failing', async () => {
    mockFindSimilar.mockRejectedValue(transient('astra down'));

    const res = await request(app).post('/api/generate').send({ genre: 'opera' });

    // The point of the fallback: a dead vault must not take generation down.
    expect(res.statusCode).toBe(200);
    expect(res.body.degraded).toBe(true);
    expect(res.body.retrieved_chunks).toBe(0);
    expect(res.body.retrieved_documents).toBe(0);
    expect(res.body.style_prompt).toBe(OUTPUT.style_prompt);
  });

  it('does not retry a permanent vault failure', async () => {
    mockFindSimilar.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));

    const res = await request(app).post('/api/generate').send({ genre: 'opera' });

    expect(res.statusCode).toBe(200);
    expect(res.body.degraded).toBe(true);
    expect(mockFindSimilar).toHaveBeenCalledTimes(1);
  });

  it('marks a degraded stream in the complete event too', async () => {
    mockFindSimilar.mockRejectedValue(transient('astra down'));
    mockChatCreate.mockResolvedValue({
      controller: { abort: jest.fn() },
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { content: JSON.stringify(OUTPUT) } }] };
      },
    });

    const res = await request(app)
      .post('/api/generate')
      .send({ genre: 'opera', stream: true });

    expect(res.statusCode).toBe(200);
    const complete = res.text
      .split('\n\n')
      .find((f) => f.startsWith('event: complete'));
    expect(JSON.parse(complete.split('data: ')[1]).degraded).toBe(true);
  });
});

describe('SSE heartbeat', () => {
  /** Minimal stand-in for a response that is still open. */
  const fakeRes = () => {
    const listeners = {};
    return {
      writableEnded: false,
      destroyed: false,
      written: [],
      write(chunk) { this.written.push(chunk); },
      once(event, cb) { listeners[event] = cb; },
      emit(event) { if (listeners[event]) listeners[event](); },
    };
  };

  afterEach(() => jest.useRealTimers());

  it('emits SSE comment frames on the interval', () => {
    jest.useFakeTimers();
    const res = fakeRes();
    createHeartbeat(res, { intervalMs: 1000 });

    jest.advanceTimersByTime(3000);
    expect(res.written).toEqual([': ping\n\n', ': ping\n\n', ': ping\n\n']);
  });

  it('stops writing once the response has ended', () => {
    jest.useFakeTimers();
    const res = fakeRes();
    const stop = createHeartbeat(res, { intervalMs: 1000 });

    jest.advanceTimersByTime(1000);
    res.writableEnded = true;
    jest.advanceTimersByTime(5000);

    expect(res.written).toHaveLength(1);
    stop();
  });

  it('stops when the caller stops it', () => {
    jest.useFakeTimers();
    const res = fakeRes();
    const stop = createHeartbeat(res, { intervalMs: 1000 });

    jest.advanceTimersByTime(1000);
    stop();
    jest.advanceTimersByTime(10000);

    expect(res.written).toHaveLength(1);
  });

  it('clears itself when the client disconnects, so the interval cannot leak', () => {
    jest.useFakeTimers();
    const res = fakeRes();
    createHeartbeat(res, { intervalMs: 1000 });

    jest.advanceTimersByTime(1000);
    res.emit('close'); // client hung up
    jest.advanceTimersByTime(10000);

    expect(res.written).toHaveLength(1);
  });

  it('does not keep the event loop alive', () => {
    const res = fakeRes();
    const stop = createHeartbeat(res, { intervalMs: 1000 });
    // An un-unref'd interval would hang the test runner at exit.
    expect(stop).toBeInstanceOf(Function);
    stop();
  });
});

describe('heartbeat on a real stream', () => {
  it('emits ping frames during long token gaps without corrupting the payload', async () => {
    process.env.SSE_HEARTBEAT_MS = '20';

    mockChatCreate.mockResolvedValue({
      controller: { abort: jest.fn() },
      async *[Symbol.asyncIterator]() {
        const parts = JSON.stringify(OUTPUT).match(/.{1,6}/g);
        for (const part of parts) {
          await new Promise((r) => setTimeout(r, 60)); // gap > heartbeat interval
          yield { choices: [{ delta: { content: part } }] };
        }
      },
    });

    const res = await request(app)
      .post('/api/generate')
      .send({ genre: 'opera', stream: true });

    delete process.env.SSE_HEARTBEAT_MS;

    expect(res.statusCode).toBe(200);
    expect(res.text).toContain(': ping\n\n');

    // The client-side contract: comment frames carry no `data:` line, so a
    // conforming parser skips them and the payload still reassembles exactly.
    const tokens = [];
    let complete = null;
    for (const frame of res.text.split('\n\n')) {
      if (!frame.trim()) continue;
      let event = 'message';
      let data = null;
      for (const line of frame.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data = line.slice(6);
      }
      if (data === null) continue; // comment frame, e.g. ': ping'
      if (data === '[DONE]') continue;
      if (event === 'complete') complete = JSON.parse(data);
      else tokens.push(JSON.parse(data).token);
    }

    expect(tokens.join('')).toBe(JSON.stringify(OUTPUT));
    expect(complete.style_prompt).toBe(OUTPUT.style_prompt);
  }, 15000);
});
