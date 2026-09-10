// server.js validates required env vars and constructs the OpenAI/Astra
// clients at import time, so these must be set before the first require.
process.env.OPENAI_API_KEY = 'test-key';
process.env.ASTRA_DB_API_ENDPOINT = 'https://example.apps.astra.datastax.com';
process.env.ASTRA_DB_APPLICATION_TOKEN = 'AstraCS:test-token';

const request = require('supertest');

// lib/vaultRepository.js exports the named class `{ VaultRepository }`, and
// server.js does `new VaultRepository(lyricVault)` — the mock factory must
// mirror that exact shape or the destructure in server.js resolves to
// undefined and `new VaultRepository(...)` throws.
jest.mock('../../lib/vaultRepository', () => ({
  VaultRepository: jest.fn().mockImplementation(() => ({
    insertChunks: jest.fn().mockResolvedValue({ insertedCount: 2 }),
    findSimilar: jest.fn().mockResolvedValue([
      {
        transcript: 'Vault lyric line 1',
        metadata: { document_id: 'doc_1', chunk_index: 0 },
      },
    ]),
  })),
}));

// server.js imports the module itself as the constructor
// (`const OpenAI = require('openai'); new OpenAI(...)`), not a named
// `{ OpenAI }` export — the mock must be directly callable with `new`.
jest.mock('openai', () =>
  jest.fn().mockImplementation(() => ({
    embeddings: {
      create: jest.fn().mockResolvedValue({
        data: [{ embedding: [0.1, 0.2, 0.3] }],
      }),
    },
    chat: {
      completions: {
        create: jest.fn().mockResolvedValue({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  style_prompt: 'Opera, D-minor, 120 bpm',
                  structured_lyrics: '[Verse 1]\nClassical notes...',
                }),
              },
            },
          ],
        }),
      },
    },
  }))
);

// Import Express app after mocks are in place
const { app } = require('../../server');

describe('Integration Tests - Express Routes', () => {
  describe('GET /health', () => {
    it('should return 200 OK and health status', async () => {
      const res = await request(app).get('/health');
      expect(res.statusCode).toEqual(200);
      expect(res.body).toHaveProperty('status', 'ok');
      expect(res.body).toHaveProperty('service');
    });
  });

  describe('GET /unknown-route (404 Fallback)', () => {
    it('should return 404 JSON for non-existent routes', async () => {
      const res = await request(app).get('/api/not-a-real-endpoint');
      expect(res.statusCode).toEqual(404);
      expect(res.body).toEqual({ error: 'Not found' });
    });
  });

  describe('POST /api/ingest', () => {
    it('should return 400 if transcript is missing', async () => {
      const res = await request(app).post('/api/ingest').send({});

      expect(res.statusCode).toEqual(400);
      expect(res.body.error).toMatch(/transcript is required/i);
    });

    it('should process transcript, generate embeddings, and return 201', async () => {
      const res = await request(app)
        .post('/api/ingest')
        .send({
          transcript: 'This is a test transcript for vector insertion.',
          metadata: { document_id: 'test_doc_100' },
        });

      expect(res.statusCode).toEqual(201);
      expect(res.body.success).toBe(true);
      expect(res.body.document_id).toBe('test_doc_100');
      expect(res.body.chunks_ingested).toBeGreaterThan(0);
    });
  });

  describe('POST /api/generate', () => {
    it('should return 400 if neither genre nor theme is supplied', async () => {
      const res = await request(app).post('/api/generate').send({});

      expect(res.statusCode).toEqual(400);
      expect(res.body.error).toMatch(/genre.*or.*theme.*required/i);
    });

    it('should query vector vault and return structured Mozart output', async () => {
      const res = await request(app).post('/api/generate').send({
        genre: 'Opera',
        theme: 'Thunderstorm',
      });

      expect(res.statusCode).toEqual(200);
      expect(res.body).toHaveProperty('style_prompt', 'Opera, D-minor, 120 bpm');
      expect(res.body).toHaveProperty('structured_lyrics');
      expect(res.body).toHaveProperty('retrieved_chunks', 1);
      expect(res.body).toHaveProperty('retrieved_documents', 1);
    });
  });
});
