process.env.OPENAI_API_KEY = 'test-key';
process.env.ASTRA_DB_API_ENDPOINT = 'https://example.apps.astra.datastax.com';
process.env.ASTRA_DB_APPLICATION_TOKEN = 'AstraCS:test-token';

const request = require('supertest');
const { TooManyDocumentsToCountError } = require('@datastax/astra-db-ts');

const mockFindProfiles = jest.fn();
const mockCountProfiles = jest.fn();
const mockDeleteProfile = jest.fn();
const mockFindSimilar = jest.fn();
const mockChatCreate = jest.fn();

jest.mock('../../lib/vaultRepository', () => ({
  VaultRepository: jest.fn().mockImplementation(() => ({
    ping: jest.fn().mockResolvedValue({}),
    insertChunks: jest.fn().mockResolvedValue({}),
    findSimilar: mockFindSimilar,
    findProfiles: mockFindProfiles,
    countProfiles: mockCountProfiles,
    deleteProfile: mockDeleteProfile,
  })),
}));

jest.mock('openai', () => {
  const MockOpenAI = jest.fn().mockImplementation(() => ({
    models: { retrieve: jest.fn().mockResolvedValue({}) },
    embeddings: { create: jest.fn().mockResolvedValue({ data: [{ embedding: [0.1] }] }) },
    chat: { completions: { create: mockChatCreate } },
    audio: { transcriptions: { create: jest.fn() } },
  }));
  MockOpenAI.toFile = jest.fn(async (buffer, name, opts) => ({ buffer, name, opts }));
  return MockOpenAI;
});

const { app } = require('../../server');

const profileDoc = (overrides = {}) => ({
  _id: 'astra-internal-id',
  text: 'Style profile learned from a reference reel.\nFeel: Atmospheric',
  metadata: {
    kind: 'style_profile',
    document_id: 'prof-1',
    source: 'reel',
    source_name: 'clip.mp3',
    topic: 'moving on',
    feel: 'Atmospheric / late-night reflective',
    cadence: '6-8 syllables, heavy slant rhyme',
    metaphor_domains: ['Night driving', 'Weather'],
    learned_at: '2026-09-11T00:00:00.000Z',
    chunk_index: 0,
    total_chunks: 1,
    ...overrides,
  },
});

beforeEach(() => {
  mockFindProfiles.mockReset().mockResolvedValue([profileDoc()]);
  mockCountProfiles.mockReset().mockResolvedValue(1);
  mockDeleteProfile.mockReset().mockResolvedValue({ deletedCount: 1 });
  mockFindSimilar.mockReset().mockResolvedValue([]);
  mockChatCreate.mockReset().mockResolvedValue({
    choices: [{ message: { content: JSON.stringify({
      style_prompt: 'lo-fi, 96 bpm',
      structured_lyrics: '[Verse 1]\nWords',
      tempo_bpm: 96,
      melody: [],
    }) } }],
  });
});

describe('GET /api/style-memory', () => {
  it('lists what the vault has learned from reels, newest first', async () => {
    const res = await request(app).get('/api/style-memory');

    expect(res.statusCode).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.count_capped).toBe(false);
    expect(res.body.profiles).toEqual([
      {
        id: 'prof-1',
        feel: 'Atmospheric / late-night reflective',
        cadence: '6-8 syllables, heavy slant rhyme',
        metaphor_domains: ['Night driving', 'Weather'],
        literary_devices: [],
        tags: [],
        source: 'reel',
        topic: 'moving on',
        source_name: 'clip.mp3',
        learned_at: '2026-09-11T00:00:00.000Z',
      },
    ]);
  });

  it('never exposes the stored profile text or the Astra document id', async () => {
    const res = await request(app).get('/api/style-memory');

    const body = JSON.stringify(res.body);
    expect(body).not.toContain('Style profile learned from');
    expect(body).not.toContain('astra-internal-id');
  });

  it('defaults to a page of 10', async () => {
    await request(app).get('/api/style-memory');

    expect(mockFindProfiles).toHaveBeenCalledWith({ limit: 10 });
  });

  it('honours ?limit', async () => {
    await request(app).get('/api/style-memory?limit=5');

    expect(mockFindProfiles).toHaveBeenCalledWith({ limit: 5 });
  });

  it('caps the page at the Data API non-vector sort ceiling', async () => {
    await request(app).get('/api/style-memory?limit=500');

    expect(mockFindProfiles).toHaveBeenCalledWith({ limit: 20 });
  });

  it('ignores a nonsense ?limit rather than erroring', async () => {
    await request(app).get('/api/style-memory?limit=banana');

    expect(mockFindProfiles).toHaveBeenCalledWith({ limit: 10 });
  });

  it('reports "at least N" when there are more profiles than it will count', async () => {
    mockCountProfiles.mockRejectedValue(
      new TooManyDocumentsToCountError(1000, true)
    );

    const res = await request(app).get('/api/style-memory');

    expect(res.statusCode).toBe(200);
    expect(res.body.count).toBe(1000);
    expect(res.body.count_capped).toBe(true);
    expect(res.body.profiles).toHaveLength(1);
  });

  it('still serves the listing when the count call fails outright', async () => {
    mockCountProfiles.mockRejectedValue(new Error('count unavailable'));

    const res = await request(app).get('/api/style-memory');

    expect(res.statusCode).toBe(200);
    expect(res.body.count).toBe(1); // falls back to what was actually listed
    expect(res.body.count_capped).toBe(false);
  });

  it('returns an empty memory rather than an error when nothing is learned yet', async () => {
    mockFindProfiles.mockResolvedValue([]);
    mockCountProfiles.mockResolvedValue(0);

    const res = await request(app).get('/api/style-memory');

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ count: 0, count_capped: false, profiles: [] });
  });

  it('surfaces a listing failure in the standard error shape', async () => {
    mockFindProfiles.mockRejectedValue(new Error('astra is down'));

    const res = await request(app).get('/api/style-memory');

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      error: 'Failed to read style memory',
      details: 'astra is down',
    });
  }, 15000);
});

describe('DELETE /api/style-memory/:id', () => {
  it('forgets one profile', async () => {
    const res = await request(app).delete('/api/style-memory/prof-1');

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, id: 'prof-1', deleted: 1 });
    expect(mockDeleteProfile).toHaveBeenCalledWith('prof-1');
  });

  it('404s on an id that matched nothing', async () => {
    mockDeleteProfile.mockResolvedValue({ deletedCount: 0 });

    const res = await request(app).delete('/api/style-memory/nope');

    expect(res.statusCode).toBe(404);
    expect(res.body.error).toMatch(/no learned style profile/i);
  });

  it('surfaces a delete failure in the standard error shape', async () => {
    mockDeleteProfile.mockRejectedValue(new Error('astra is down'));

    const res = await request(app).delete('/api/style-memory/prof-1');

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('Failed to forget that style profile');
  });
});

describe('learned profiles reaching the generation prompt', () => {
  it('labels a profile distinctly from an ingested lyric excerpt', async () => {
    mockFindSimilar.mockResolvedValue([
      profileDoc(),
      { metadata: { document_id: 'docA', chunk_index: 0 }, transcript: 'An ingested lyric line' },
    ]);

    const res = await request(app).post('/api/generate').send({ genre: 'lo-fi' });

    expect(res.statusCode).toBe(200);
    const [{ messages }] = mockChatCreate.mock.calls[0];
    expect(messages[1].content).toContain('[Learned style profile: prof-1]');
    expect(messages[1].content).toContain('Feel: Atmospheric');
    expect(messages[1].content).toContain('[Source: docA]');
    expect(messages[1].content).toContain('An ingested lyric line');
  });

  it('tells the model what a learned style profile is and how to use it', async () => {
    mockFindSimilar.mockResolvedValue([profileDoc()]);

    await request(app).post('/api/generate').send({ genre: 'lo-fi' });

    const [{ messages }] = mockChatCreate.mock.calls[0];
    expect(messages[1].content).toMatch(/Learned style profile.*house style/s);
    expect(messages[1].content).toMatch(/match their feel, cadence and metaphor domains/i);
  });

  it('tells the generator to break lyric lines rather than collapse a verse', async () => {
    await request(app).post('/api/generate').send({ genre: 'lo-fi' });

    const [{ messages }] = mockChatCreate.mock.calls[0];
    const system = messages[0].content;

    expect(system).toMatch(/ONE LYRIC LINE PER LINE/);
    expect(system).toMatch(/unusable as a lyric sheet/i);
    expect(system).toMatch(/section headers on their own line/i);
  });

  it('counts a learned profile as a retrieved document', async () => {
    mockFindSimilar.mockResolvedValue([profileDoc()]);

    const res = await request(app).post('/api/generate').send({ genre: 'lo-fi' });

    expect(res.body.retrieved_chunks).toBe(1);
    expect(res.body.retrieved_documents).toBe(1);
    expect(res.body.degraded).toBe(false);
  });
});
