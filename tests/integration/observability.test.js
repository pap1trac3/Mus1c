process.env.OPENAI_API_KEY = 'test-key';
process.env.ASTRA_DB_API_ENDPOINT = 'https://example.apps.astra.datastax.com';
process.env.ASTRA_DB_APPLICATION_TOKEN = 'AstraCS:test-token';

const request = require('supertest');

const mockPing = jest.fn().mockResolvedValue({ name: 'lyric_vault' });
const mockModelsRetrieve = jest.fn().mockResolvedValue({ id: 'text-embedding-3-small' });

jest.mock('../../lib/vaultRepository', () => ({
  VaultRepository: jest.fn().mockImplementation(() => ({
    ping: mockPing,
    insertChunks: jest.fn().mockResolvedValue({ insertedCount: 1 }),
    findSimilar: jest.fn().mockResolvedValue([
      { transcript: 'Vault lyric line', metadata: { document_id: 'doc_1', chunk_index: 0 } },
    ]),
  })),
}));

jest.mock('openai', () =>
  jest.fn().mockImplementation(() => ({
    models: { retrieve: mockModelsRetrieve },
    embeddings: { create: jest.fn().mockResolvedValue({ data: [{ embedding: [0.1] }] }) },
    chat: {
      completions: {
        create: jest.fn().mockResolvedValue({
          choices: [{ message: { content: JSON.stringify({ style_prompt: 'sp', structured_lyrics: 'sl' }) } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      },
    },
  }))
);

const { app } = require('../../server');

beforeEach(() => {
  mockPing.mockClear().mockResolvedValue({ name: 'lyric_vault' });
  mockModelsRetrieve.mockClear().mockResolvedValue({ id: 'text-embedding-3-small' });
});

describe('GET /health (liveness)', () => {
  it('keeps its existing contract and never touches upstreams', async () => {
    const res = await request(app).get('/health');

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', service: 'mozart-ai-music-generator' });
    expect(typeof res.body.uptime_s).toBe('number');
    // A liveness probe must not be able to fail because a dependency is down.
    expect(mockPing).not.toHaveBeenCalled();
    expect(mockModelsRetrieve).not.toHaveBeenCalled();
  });
});

describe('GET /ready (readiness)', () => {
  it('actually probes both dependencies and reports 200 when healthy', async () => {
    const res = await request(app).get('/ready?force=true');

    expect(res.statusCode).toBe(200);
    expect(res.body.ready).toBe(true);
    expect(res.body.status).toBe('ready');
    expect(mockPing).toHaveBeenCalled();
    expect(mockModelsRetrieve).toHaveBeenCalledWith('text-embedding-3-small');
    expect(res.body.dependencies.vector_vault.status).toBe('healthy');
    expect(res.body.dependencies.openai_api.status).toBe('healthy');
    expect(typeof res.body.dependencies.vector_vault.latency_ms).toBe('number');
  });

  it('returns 503 with the failure reason when the vault is unreachable', async () => {
    mockPing.mockRejectedValue(new Error('astra unreachable'));

    const res = await request(app).get('/ready?force=true');

    expect(res.statusCode).toBe(503);
    expect(res.body.ready).toBe(false);
    expect(res.body.status).toBe('degraded');
    expect(res.body.dependencies.vector_vault).toMatchObject({
      status: 'unhealthy',
      error: 'astra unreachable',
    });
    // One dependency failing must not mask the other's real state.
    expect(res.body.dependencies.openai_api.status).toBe('healthy');
  });

  it('returns 503 when the OpenAI key is rejected', async () => {
    mockModelsRetrieve.mockRejectedValue(new Error('401 Incorrect API key provided'));

    const res = await request(app).get('/ready?force=true');

    expect(res.statusCode).toBe(503);
    expect(res.body.dependencies.openai_api).toMatchObject({ status: 'unhealthy' });
    expect(res.body.dependencies.openai_api.error).toMatch(/401/);
  });

  it('caches results so repeated probes do not hammer upstreams', async () => {
    await request(app).get('/ready?force=true');
    const callsAfterForce = mockPing.mock.calls.length;

    const cached = await request(app).get('/ready');
    expect(cached.body.cached).toBe(true);
    expect(mockPing.mock.calls.length).toBe(callsAfterForce); // no new probe
  });
});

describe('request correlation', () => {
  it('echoes a supplied x-request-id', async () => {
    const res = await request(app).get('/health').set('x-request-id', 'trace-abc-123');
    expect(res.headers['x-request-id']).toBe('trace-abc-123');
  });

  it('generates an id when the client supplies none', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('non-streaming generation telemetry', () => {
  it('still returns the documented body and does not leak usage into it', async () => {
    const res = await request(app).post('/api/generate').send({ genre: 'opera' });

    expect(res.statusCode).toBe(200);
    // usage is logged, not added to the public response contract.
    expect(Object.keys(res.body).sort()).toEqual(
      ['retrieved_chunks', 'retrieved_documents', 'structured_lyrics', 'style_prompt'].sort()
    );
  });
});
