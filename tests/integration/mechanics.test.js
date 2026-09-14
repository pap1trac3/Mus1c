process.env.OPENAI_API_KEY = 'test-key';
process.env.ASTRA_DB_API_ENDPOINT = 'https://example.apps.astra.datastax.com';
process.env.ASTRA_DB_APPLICATION_TOKEN = 'AstraCS:test-token';

const request = require('supertest');

const mockFindSimilar = jest.fn();
const mockInsertChunks = jest.fn();
const mockChatCreate = jest.fn();

jest.mock('../../lib/vaultRepository', () => ({
  VaultRepository: jest.fn().mockImplementation(() => ({
    ping: jest.fn().mockResolvedValue({}),
    insertChunks: mockInsertChunks,
    findSimilar: mockFindSimilar,
    findSimilarProfilesByTags: jest.fn().mockResolvedValue([]),
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

const SHEET = [
  '[Verse 1]',
  'Walking through the burning light',
  'Counting every fallen star',
  'Nothing left to hold me tight',
  'Wondering just where you are',
].join('\n');

const generationOutput = (overrides = {}) => ({
  choices: [{ message: { content: JSON.stringify({
    style_prompt: 'lo-fi, 96 bpm',
    structured_lyrics: SHEET,
    tempo_bpm: 120,
    melody: [],
    ...overrides,
  }) } }],
});

const profileDoc = (prosody) => ({
  _id: 'astra-1',
  text: 'Style profile learned from a reference reel.',
  $similarity: 0.9,
  metadata: { kind: 'style_profile', document_id: 'prof-1', chunk_index: 0, total_chunks: 1, prosody },
});

const userPrompt = () => mockChatCreate.mock.calls[0][0].messages[1].content;

beforeEach(() => {
  mockFindSimilar.mockReset().mockResolvedValue([]);
  mockInsertChunks.mockReset().mockResolvedValue({});
  mockChatCreate.mockReset().mockResolvedValue(generationOutput());
});

describe('POST /api/generate bar grid', () => {
  it('places every sung line on a bar, headers excluded', async () => {
    const res = await request(app).post('/api/generate').send({ genre: 'lo-fi' });

    expect(res.statusCode).toBe(200);
    expect(res.body.bar_grid.rows).toHaveLength(4);
    expect(res.body.bar_grid.rows[0].line).toBe('Walking through the burning light');
  });

  it('times the grid at the tempo the model returned, not the requested bpm', async () => {
    const res = await request(app).post('/api/generate').send({ genre: 'lo-fi', bpm: 80 });

    // 120bpm from the model output: 4 beats = 2 seconds per bar.
    expect(res.body.bar_grid.bpm).toBe(120);
    expect(res.body.bar_grid.rows[1].start_seconds).toBe(2);
  });

  it('reports the measured mechanics of the sheet it actually wrote', async () => {
    const res = await request(app).post('/api/generate').send({ genre: 'lo-fi' });

    expect(res.body.prosody.line_count).toBe(4);
    expect(res.body.prosody.rhyme_scheme).toBe('ABAB');
    expect(res.body.prosody.syllables_per_line.avg).toBeGreaterThan(0);
  });

  it('returns an empty grid rather than failing when the sheet has no sung lines', async () => {
    mockChatCreate.mockResolvedValue(generationOutput({ structured_lyrics: '[Verse 1]' }));

    const res = await request(app).post('/api/generate').send({ genre: 'lo-fi' });

    expect(res.statusCode).toBe(200);
    expect(res.body.bar_grid.rows).toEqual([]);
    expect(res.body.bar_grid.total_bars).toBe(0);
  });
});

describe('measured mechanics in the generation prompt', () => {
  it('tells the model the syllable target counted from the retrieved profiles', async () => {
    mockFindSimilar.mockResolvedValue([
      profileDoc({
        line_count: 8,
        syllables_per_line: { avg: 14, min: 12, max: 16 },
        rhyme_scheme: 'AABB',
        internal_rhyme_density: 0.75,
      }),
    ]);

    await request(app).post('/api/generate').send({ genre: 'lo-fi' });

    expect(userPrompt()).toContain('Target 14 syllables per sung line, varying within 12-16');
    expect(userPrompt()).toContain('End-rhyme scheme: AABB');
  });

  it('steers toward internal rhyme only when the reference is actually dense', async () => {
    mockFindSimilar.mockResolvedValue([
      profileDoc({
        line_count: 8,
        syllables_per_line: { avg: 8, min: 6, max: 10 },
        rhyme_scheme: 'ABAB',
        internal_rhyme_density: 0.1,
      }),
    ]);

    await request(app).post('/api/generate').send({ genre: 'lo-fi' });

    expect(userPrompt()).toContain('Internal rhyme is sparse');
    expect(userPrompt()).not.toContain('Internal rhyme is dense');
  });

  it('ignores ingested lyric chunks, which are fragments rather than a chosen style', async () => {
    mockFindSimilar.mockResolvedValue([
      { _id: 'a', transcript: 'some ingested lyrics', metadata: { document_id: 'doc-1' } },
    ]);

    await request(app).post('/api/generate').send({ genre: 'lo-fi' });

    expect(userPrompt()).not.toContain('Measured mechanics');
  });

  it('says nothing about mechanics when no profile carries measurements', async () => {
    mockFindSimilar.mockResolvedValue([profileDoc(null)]);

    await request(app).post('/api/generate').send({ genre: 'lo-fi' });

    expect(userPrompt()).not.toContain('Measured mechanics');
  });

  it('averages the target across several retrieved profiles', async () => {
    mockFindSimilar.mockResolvedValue([
      profileDoc({ line_count: 4, syllables_per_line: { avg: 8, min: 7, max: 9 }, rhyme_scheme: 'AABB', internal_rhyme_density: 0 }),
      { ...profileDoc({ line_count: 4, syllables_per_line: { avg: 12, min: 11, max: 14 }, rhyme_scheme: 'AABB', internal_rhyme_density: 0 }),
        metadata: { kind: 'style_profile', document_id: 'prof-2', chunk_index: 0, total_chunks: 1,
          prosody: { line_count: 4, syllables_per_line: { avg: 12, min: 11, max: 14 }, rhyme_scheme: 'AABB', internal_rhyme_density: 0 } } },
    ]);

    await request(app).post('/api/generate').send({ genre: 'lo-fi' });

    // Mean of 8 and 12, across the widest observed range.
    expect(userPrompt()).toContain('Target 10 syllables per sung line, varying within 7-14');
  });
});

describe('prosody stored on a learned profile', () => {
  it('measures the reference text when training from pasted text', async () => {
    mockChatCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({
        feel: 'Atmospheric',
        cadence: 'sparse',
        metaphor_domains: ['Night'],
        literary_devices: [],
      }) } }],
    });

    const res = await request(app).post('/api/train-style').send({ reference_text: SHEET });

    expect(res.statusCode).toBe(201);
    const [documents] = mockInsertChunks.mock.calls[0];
    const [doc] = documents;

    expect(doc.metadata.prosody.line_count).toBe(4);
    expect(doc.metadata.prosody.rhyme_scheme).toBe('ABAB');
    expect(doc.metadata.prosody.syllables_per_line.avg).toBeGreaterThan(0);
  });

  it('still never persists the reference text itself, only its measurements', async () => {
    mockChatCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({
        feel: 'Atmospheric', cadence: 'sparse', metaphor_domains: [], literary_devices: [],
      }) } }],
    });

    await request(app)
      .post('/api/train-style')
      .send({ reference_text: 'Walking through the burning light\nCounting every fallen star' });

    const [documents] = mockInsertChunks.mock.calls[0];
    expect(JSON.stringify(documents)).not.toContain('Walking through the burning light');
  });
});
