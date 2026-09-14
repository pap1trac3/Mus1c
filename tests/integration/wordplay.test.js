process.env.OPENAI_API_KEY = 'test-key';
process.env.ASTRA_DB_API_ENDPOINT = 'https://example.apps.astra.datastax.com';
process.env.ASTRA_DB_APPLICATION_TOKEN = 'AstraCS:test-token';

const request = require('supertest');

const mockChatCreate = jest.fn();

jest.mock('../../lib/vaultRepository', () => ({
  VaultRepository: jest.fn().mockImplementation(() => ({
    ping: jest.fn().mockResolvedValue({}),
    insertChunks: jest.fn(),
    findSimilar: jest.fn().mockResolvedValue([]),
    findSimilarProfilesByTags: jest.fn().mockResolvedValue([]),
    findSimilarProfiles: jest.fn().mockResolvedValue([]),
    findProfilesByIds: jest.fn().mockResolvedValue([]),
    findProfiles: jest.fn().mockResolvedValue([]),
    countProfiles: jest.fn().mockResolvedValue(0),
    deleteProfile: jest.fn(),
    updateProfileTags: jest.fn(),
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

const LINE = 'Walking through the burning light';

const wordplayOutput = (overrides = {}) => ({
  choices: [{ message: { content: JSON.stringify({
    double_entendres: [{ text: 'Walking through the burning light', plays_on: 'burning' }],
    metaphor_clusters: [{ domain: 'boxing', images: ['a standing eight', 'the corner towel'] }],
    rhyme_extensions: [
      { phrase: 'holding on tight', note: 'opens the next verse' },
      { phrase: 'nothing at all', note: 'does not rhyme' },
    ],
    ...overrides,
  }) } }],
});

const systemPrompt = () => mockChatCreate.mock.calls[0][0].messages[0].content;
const userPrompt = () => mockChatCreate.mock.calls[0][0].messages[1].content;

beforeEach(() => {
  mockChatCreate.mockReset().mockResolvedValue(wordplayOutput());
});

describe('POST /api/wordplay', () => {
  it('returns the three groups of suggestions for the highlighted line', async () => {
    const res = await request(app).post('/api/wordplay').send({ line: LINE });

    expect(res.statusCode).toBe(200);
    expect(res.body.line).toBe(LINE);
    expect(res.body.rhyme_target).toBe('light');
    expect(res.body.double_entendres[0].plays_on).toBe('burning');
    expect(res.body.metaphor_clusters[0].images).toHaveLength(2);
  });

  it('drops the proposals that do not actually rhyme, and says how many', async () => {
    const res = await request(app).post('/api/wordplay').send({ line: LINE });

    expect(res.body.rhyme_extensions.map((entry) => entry.phrase)).toEqual(['holding on tight']);
    expect(res.body.rhymes_dropped).toBe(1);
  });

  it('counts the syllables of each surviving phrase', async () => {
    const res = await request(app).post('/api/wordplay').send({ line: LINE });

    expect(res.body.rhyme_extensions[0].syllables).toBe(4);
  });

  it('keeps the caller\'s line and sheet out of the system prompt', async () => {
    await request(app)
      .post('/api/wordplay')
      .send({ line: LINE, sheet: '[Verse 1]\n' + LINE, genre: 'drill' });

    expect(systemPrompt()).not.toContain('Walking through');
    expect(systemPrompt()).not.toContain('drill');
    expect(userPrompt()).toContain('Walking through');
  });

  it('carries the tone constraint into the suggestions', async () => {
    await request(app).post('/api/wordplay').send({ line: LINE, tone: 'radio' });

    expect(userPrompt()).toContain('Language constraint — radio edit');
  });

  it('rejects a request with no line to work on', async () => {
    const res = await request(app).post('/api/wordplay').send({});

    expect(res.statusCode).toBe(400);
    expect(mockChatCreate).not.toHaveBeenCalled();
  });

  it('rejects a whole verse pasted in place of a line', async () => {
    const res = await request(app).post('/api/wordplay').send({ line: 'x'.repeat(301) });

    expect(res.statusCode).toBe(400);
    expect(mockChatCreate).not.toHaveBeenCalled();
  });

  it('reports a model that returned nothing usable rather than an empty success', async () => {
    mockChatCreate.mockResolvedValue({ choices: [{ message: { content: '{}' } }] });

    const res = await request(app).post('/api/wordplay').send({ line: LINE });

    // The same 500 every other model-output failure returns.
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('Failed to generate wordplay');
  });

  it('never persists or echoes back the sheet it was given for context', async () => {
    const res = await request(app)
      .post('/api/wordplay')
      .send({ line: LINE, sheet: '[Verse 1]\nA private unreleased verse' });

    expect(JSON.stringify(res.body)).not.toContain('A private unreleased verse');
  });
});
