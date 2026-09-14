process.env.OPENAI_API_KEY = 'test-key';
process.env.ASTRA_DB_API_ENDPOINT = 'https://example.apps.astra.datastax.com';
process.env.ASTRA_DB_APPLICATION_TOKEN = 'AstraCS:test-token';

const request = require('supertest');

const mockFindSimilar = jest.fn();
const mockFindSimilarProfilesByTags = jest.fn();
const mockUpdateProfileTags = jest.fn();
const mockChatCreate = jest.fn();

jest.mock('../../lib/vaultRepository', () => ({
  VaultRepository: jest.fn().mockImplementation(() => ({
    ping: jest.fn().mockResolvedValue({}),
    insertChunks: jest.fn().mockResolvedValue({}),
    findSimilar: mockFindSimilar,
    findSimilarProfilesByTags: mockFindSimilarProfilesByTags,
    findProfiles: jest.fn().mockResolvedValue([]),
    countProfiles: jest.fn().mockResolvedValue(0),
    deleteProfile: jest.fn(),
    updateProfileTags: mockUpdateProfileTags,
  })),
}));

jest.mock('openai', () => {
  const MockOpenAI = jest.fn().mockImplementation(() => ({
    models: { retrieve: jest.fn().mockResolvedValue({}) },
    embeddings: { create: jest.fn().mockResolvedValue({ data: [{ embedding: [0.1] }] }) },
    chat: { completions: { create: mockChatCreate } },
    audio: { transcriptions: { create: jest.fn() } },
  }));
  MockOpenAI.toFile = jest.fn();
  return MockOpenAI;
});

const { app } = require('../../server');

const profile = (id, similarity) => ({
  _id: 'astra-' + id,
  text: 'profile ' + id,
  $similarity: similarity,
  metadata: { kind: 'style_profile', document_id: id, chunk_index: 0, total_chunks: 1 },
});

// Ingested chunks carry no `metadata.kind` at all — it is defaulted at read
// time. Modelled faithfully here, because that is exactly why tag filtering
// cannot be expressed as one filtered query.
const chunk = (id, similarity) => ({
  _id: 'astra-' + id,
  transcript: 'chunk ' + id,
  $similarity: similarity,
  metadata: { document_id: id, chunk_index: 0, total_chunks: 1 },
});

const generateBody = (extra = {}) => ({ genre: 'lo-fi', theme: 'rain', ...extra });

beforeEach(() => {
  mockFindSimilar.mockReset().mockResolvedValue([]);
  mockFindSimilarProfilesByTags.mockReset().mockResolvedValue([]);
  mockUpdateProfileTags.mockReset().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
  mockChatCreate.mockReset().mockResolvedValue({
    choices: [{ message: { content: JSON.stringify({
      style_prompt: 'lo-fi, 96 bpm',
      structured_lyrics: '[Verse 1]\nWords',
      tempo_bpm: 96,
      melody: [],
    }) } }],
  });
});

describe('PATCH /api/style-memory/:id/tags', () => {
  it('stores tags against the profile', async () => {
    const res = await request(app)
      .patch('/api/style-memory/prof-1/tags')
      .send({ tags: ['Aggressive', 'R&B Hook'] });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, id: 'prof-1', tags: ['aggressive', 'r&b hook'] });
    expect(mockUpdateProfileTags).toHaveBeenCalledWith('prof-1', ['aggressive', 'r&b hook']);
  });

  it('canonicalizes before storing, so a filter matches however a tag was typed', async () => {
    await request(app)
      .patch('/api/style-memory/prof-1/tags')
      .send({ tags: ['  Melodic  ', 'melodic', 'MELODIC'] });

    expect(mockUpdateProfileTags).toHaveBeenCalledWith('prof-1', ['melodic']);
  });

  it('clears tags when given an empty list', async () => {
    const res = await request(app).patch('/api/style-memory/prof-1/tags').send({ tags: [] });

    expect(res.statusCode).toBe(200);
    expect(mockUpdateProfileTags).toHaveBeenCalledWith('prof-1', []);
  });

  it('404s when no profile has that id', async () => {
    mockUpdateProfileTags.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });

    const res = await request(app).patch('/api/style-memory/missing/tags').send({ tags: ['a'] });

    expect(res.statusCode).toBe(404);
  });

  it('succeeds when the tags are unchanged (matched but not modified)', async () => {
    mockUpdateProfileTags.mockResolvedValue({ matchedCount: 1, modifiedCount: 0 });

    const res = await request(app).patch('/api/style-memory/prof-1/tags').send({ tags: ['a'] });

    expect(res.statusCode).toBe(200);
  });

  it('rejects a non-array body rather than storing it', async () => {
    const res = await request(app).patch('/api/style-memory/prof-1/tags').send({ tags: 'aggressive' });

    expect(res.statusCode).toBe(400);
    expect(mockUpdateProfileTags).not.toHaveBeenCalled();
  });

  it('rejects an oversized tag list instead of silently truncating it', async () => {
    const res = await request(app)
      .patch('/api/style-memory/prof-1/tags')
      .send({ tags: Array.from({ length: 13 }, (_, i) => 'tag' + i) });

    expect(res.statusCode).toBe(400);
    expect(mockUpdateProfileTags).not.toHaveBeenCalled();
  });
});

describe('POST /api/generate with tags', () => {
  it('runs a single unfiltered search when no tags are given', async () => {
    const res = await request(app).post('/api/generate').send(generateBody());

    expect(res.statusCode).toBe(200);
    expect(mockFindSimilar).toHaveBeenCalledTimes(1);
    expect(mockFindSimilarProfilesByTags).not.toHaveBeenCalled();
  });

  it('treats an empty tag list as "the whole vault"', async () => {
    await request(app).post('/api/generate').send(generateBody({ tags: [] }));

    expect(mockFindSimilarProfilesByTags).not.toHaveBeenCalled();
  });

  it('asks for profiles carrying any of the requested tags', async () => {
    await request(app).post('/api/generate').send(generateBody({ tags: ['Aggressive'] }));

    expect(mockFindSimilarProfilesByTags).toHaveBeenCalledWith([0.1], {
      tags: ['aggressive'],
      limit: 8,
    });
  });

  it('drops untagged profiles but keeps ingested lyric chunks', async () => {
    mockFindSimilar.mockResolvedValue([profile('untagged', 0.9), chunk('lyrics-1', 0.8)]);
    mockFindSimilarProfilesByTags.mockResolvedValue([profile('tagged', 0.5)]);

    const res = await request(app).post('/api/generate').send(generateBody({ tags: ['aggressive'] }));

    expect(res.statusCode).toBe(200);
    const context = mockChatCreate.mock.calls[0][0].messages[1].content;
    expect(context).toContain('chunk lyrics-1');
    expect(context).toContain('profile tagged');
    expect(context).not.toContain('profile untagged');
  });

  it('merges the two searches back into one similarity ranking', async () => {
    mockFindSimilar.mockResolvedValue([chunk('low', 0.2)]);
    mockFindSimilarProfilesByTags.mockResolvedValue([profile('high', 0.95)]);

    await request(app).post('/api/generate').send(generateBody({ tags: ['aggressive'] }));

    const context = mockChatCreate.mock.calls[0][0].messages[1].content;
    expect(context.indexOf('profile high')).toBeLessThan(context.indexOf('chunk low'));
  });

  it('never returns more than the retrieval limit across both searches', async () => {
    mockFindSimilar.mockResolvedValue([chunk('c1', 0.9), chunk('c2', 0.8)]);
    mockFindSimilarProfilesByTags.mockResolvedValue([profile('p1', 0.7), profile('p2', 0.6)]);

    const res = await request(app)
      .post('/api/generate')
      .send(generateBody({ tags: ['aggressive'], retrieval_limit: 3 }));

    expect(res.body.retrieved_chunks).toBe(3);
  });

  it('degrades to an unguided generation when the tagged search fails', async () => {
    mockFindSimilarProfilesByTags.mockRejectedValue(new Error('Astra unavailable'));

    const res = await request(app).post('/api/generate').send(generateBody({ tags: ['aggressive'] }));

    expect(res.statusCode).toBe(200);
    expect(res.body.degraded).toBe(true);
  });

  it('rejects a malformed tag list rather than generating on it', async () => {
    const res = await request(app).post('/api/generate').send(generateBody({ tags: [42] }));

    expect(res.statusCode).toBe(400);
    expect(mockChatCreate).not.toHaveBeenCalled();
  });
});
