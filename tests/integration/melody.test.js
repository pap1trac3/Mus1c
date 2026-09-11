process.env.OPENAI_API_KEY = 'test-key';
process.env.ASTRA_DB_API_ENDPOINT = 'https://example.apps.astra.datastax.com';
process.env.ASTRA_DB_APPLICATION_TOKEN = 'AstraCS:test-token';

const request = require('supertest');
const mockChatCreate = jest.fn();

jest.mock('../../lib/vaultRepository', () => ({
  VaultRepository: jest.fn().mockImplementation(() => ({
    ping: jest.fn().mockResolvedValue({}),
    insertChunks: jest.fn().mockResolvedValue({}),
    findSimilar: jest.fn().mockResolvedValue([]),
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

const reply = (obj) => ({ choices: [{ message: { content: JSON.stringify(obj) } }] });

describe('melody in the generation contract', () => {
  it('returns a sanitized melody and tempo', async () => {
    mockChatCreate.mockResolvedValue(
      reply({
        style_prompt: 'sp',
        structured_lyrics: 'sl',
        tempo_bpm: 96,
        melody: [
          { note: 'D4', duration: '8n', time: '0:0:0' },
          { note: ['D4', 'F4', 'A4'], duration: '2n', time: '0:2:0' },
        ],
      })
    );

    const res = await request(app).post('/api/generate').send({ genre: 'opera' });

    expect(res.statusCode).toBe(200);
    expect(res.body.tempo_bpm).toBe(96);
    expect(res.body.melody).toEqual([
      { note: 'D4', duration: '8n', time: '0:0:0' },
      { note: ['D4', 'F4', 'A4'], duration: '2n', time: '0:2:0' },
    ]);
  });

  it('strips malformed events rather than passing them to the client scheduler', async () => {
    mockChatCreate.mockResolvedValue(
      reply({
        style_prompt: 'sp',
        structured_lyrics: 'sl',
        tempo_bpm: 120,
        melody: [
          { note: 'D4', duration: '8n', time: '0:0:0' },
          { note: 'totally bogus', duration: '8n', time: '0:1:0' },
          { note: 'E4', duration: 'whenever', time: '0:2:0' },
        ],
      })
    );

    const res = await request(app).post('/api/generate').send({ genre: 'opera' });
    expect(res.body.melody).toEqual([{ note: 'D4', duration: '8n', time: '0:0:0' }]);
  });

  it('falls back to an empty melody and default tempo when the model omits them', async () => {
    mockChatCreate.mockResolvedValue(reply({ style_prompt: 'sp', structured_lyrics: 'sl' }));

    const res = await request(app).post('/api/generate').send({ genre: 'opera' });
    expect(res.body.melody).toEqual([]);
    expect(res.body.tempo_bpm).toBe(120);
  });

  it('clamps an out-of-range tempo from the model', async () => {
    mockChatCreate.mockResolvedValue(
      reply({ style_prompt: 'sp', structured_lyrics: 'sl', tempo_bpm: 100000, melody: [] })
    );

    const res = await request(app).post('/api/generate').send({ genre: 'opera' });
    expect(res.body.tempo_bpm).toBe(300);
  });

  it('includes melody and tempo in the SSE complete event', async () => {
    const payload = {
      style_prompt: 'sp',
      structured_lyrics: 'sl',
      tempo_bpm: 90,
      melody: [{ note: 'C4', duration: '4n', time: '0:0:0' }],
    };
    mockChatCreate.mockResolvedValue({
      controller: { abort: jest.fn() },
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { content: JSON.stringify(payload) } }] };
      },
    });

    const res = await request(app)
      .post('/api/generate')
      .send({ genre: 'opera', stream: true });

    const frame = res.text.split('\n\n').find((f) => f.startsWith('event: complete'));
    const complete = JSON.parse(frame.split('data: ')[1]);
    expect(complete.tempo_bpm).toBe(90);
    expect(complete.melody).toEqual(payload.melody);
  });
});
