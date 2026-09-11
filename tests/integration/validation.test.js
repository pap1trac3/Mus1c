process.env.OPENAI_API_KEY = 'test-key';
process.env.ASTRA_DB_API_ENDPOINT = 'https://example.apps.astra.datastax.com';
process.env.ASTRA_DB_APPLICATION_TOKEN = 'AstraCS:test-token';

const request = require('supertest');

const mockInsertChunks = jest.fn().mockResolvedValue({ insertedCount: 1 });
const mockFindSimilar = jest.fn().mockResolvedValue([
  { transcript: 'Vault lyric line 1', metadata: { document_id: 'doc_1', chunk_index: 0 } },
]);

jest.mock('../../lib/vaultRepository', () => ({
  VaultRepository: jest.fn().mockImplementation(() => ({
    insertChunks: mockInsertChunks,
    findSimilar: mockFindSimilar,
  })),
}));

jest.mock('openai', () =>
  jest.fn().mockImplementation(() => ({
    embeddings: { create: jest.fn().mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] }) },
    chat: {
      completions: {
        create: jest.fn().mockResolvedValue({
          choices: [
            {
              message: {
                content: JSON.stringify({ style_prompt: 'sp', structured_lyrics: 'sl' }),
              },
            },
          ],
        }),
      },
    },
  }))
);

const { app } = require('../../server');

describe('Zod request validation', () => {
  beforeEach(() => {
    mockInsertChunks.mockClear();
    mockFindSimilar.mockClear();
  });

  describe('/api/ingest', () => {
    it('keeps the legacy error message and adds per-field details', async () => {
      const res = await request(app).post('/api/ingest').send({});

      expect(res.statusCode).toBe(400);
      expect(res.body.error).toMatch(/transcript is required/i);
      expect(res.body.details).toEqual([
        { field: 'transcript', message: 'transcript is required and must be a non-empty string' },
      ]);
    });

    it('rejects a whitespace-only transcript', async () => {
      const res = await request(app).post('/api/ingest').send({ transcript: '   ' });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toMatch(/transcript is required/i);
    });

    it('preserves arbitrary metadata keys alongside document_id', async () => {
      const res = await request(app)
        .post('/api/ingest')
        .send({
          transcript: 'a line of lyrics',
          metadata: { document_id: 'doc_x', source: 'youtube', title: 'Aria' },
        });

      expect(res.statusCode).toBe(201);
      const [documents] = mockInsertChunks.mock.calls[0];
      expect(documents[0].metadata).toMatchObject({
        document_id: 'doc_x',
        source: 'youtube',
        title: 'Aria',
        chunk_index: 0,
      });
    });
  });

  describe('/api/generate', () => {
    it('keeps the legacy message when neither genre nor theme is given', async () => {
      const res = await request(app).post('/api/generate').send({});

      expect(res.statusCode).toBe(400);
      expect(res.body.error).toMatch(/genre.*or.*theme.*required/i);
      expect(res.body.details[0].message).toMatch(/genre.*or.*theme/i);
    });

    it.each([
      ['bpm below range', { genre: 'opera', bpm: 10 }],
      ['bpm above range', { genre: 'opera', bpm: 400 }],
      ['retrieval_limit above range', { genre: 'opera', retrieval_limit: 50 }],
      ['retrieval_limit below range', { genre: 'opera', retrieval_limit: 0 }],
    ])('rejects %s', async (_label, body) => {
      const res = await request(app).post('/api/generate').send(body);

      expect(res.statusCode).toBe(400);
      expect(res.body.details.length).toBeGreaterThan(0);
    });

    it('coerces numeric strings and ignores blank optional fields', async () => {
      const res = await request(app)
        .post('/api/generate')
        .send({ genre: 'opera', bpm: '120', retrieval_limit: '5', key: '', acoustics: '' });

      expect(res.statusCode).toBe(200);
      // retrieval_limit "5" must reach the repository as the number 5.
      expect(mockFindSimilar.mock.calls[0][1]).toEqual({ limit: 5 });
    });

    it('defaults the retrieval limit to 8 when omitted', async () => {
      const res = await request(app).post('/api/generate').send({ theme: 'rain' });

      expect(res.statusCode).toBe(200);
      expect(mockFindSimilar.mock.calls[0][1]).toEqual({ limit: 8 });
    });
  });
});

describe('Rate limiting', () => {
  // Limiters skip when NODE_ENV === 'test'; flip it per request to exercise them.
  afterEach(() => {
    process.env.NODE_ENV = 'test';
  });

  it('is skipped under NODE_ENV=test so suites are not throttled', async () => {
    for (let i = 0; i < 25; i++) {
      const res = await request(app).post('/api/generate').send({ genre: 'opera' });
      expect(res.statusCode).toBe(200);
    }
  });

  it('returns a JSON 429 once the strict limit is exceeded', async () => {
    process.env.NODE_ENV = 'production';

    let lastStatus = 200;
    let lastBody = null;
    for (let i = 0; i < 22 && lastStatus !== 429; i++) {
      const res = await request(app).post('/api/generate').send({ genre: 'opera' });
      lastStatus = res.statusCode;
      lastBody = res.body;
    }

    expect(lastStatus).toBe(429);
    expect(lastBody).toEqual({ error: 'Too many generation requests, please try again later.' });
  });
});
