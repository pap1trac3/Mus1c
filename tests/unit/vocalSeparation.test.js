const { isolateVocals, separationEnabled, MIN_STEM_BYTES } = require('../../lib/vocalSeparation');

const clip = () => ({
  buffer: Buffer.from('original mixed audio bytes'),
  filename: 'reel.mp4',
  mimetype: 'video/mp4',
});

const silentLog = { info: jest.fn(), warn: jest.fn() };

afterEach(() => {
  delete process.env.SEPARATOR_URL;
  jest.restoreAllMocks();
});

describe('separationEnabled()', () => {
  it('is off unless a separator URL is configured', () => {
    expect(separationEnabled()).toBe(false);
    process.env.SEPARATOR_URL = 'http://separator:8000';
    expect(separationEnabled()).toBe(true);
  });

  it('treats a blank URL as unconfigured', () => {
    process.env.SEPARATOR_URL = '   ';
    expect(separationEnabled()).toBe(false);
  });
});

describe('isolateVocals()', () => {
  it('returns the original audio untouched when no separator is configured', async () => {
    const out = await isolateVocals({ ...clip(), log: silentLog });

    expect(out.separated).toBe(false);
    expect(out.reason).toBe('not_configured');
    expect(out.buffer.toString()).toBe('original mixed audio bytes');
    expect(out.filename).toBe('reel.mp4');
  });

  it('returns the isolated stem as a WAV when separation succeeds', async () => {
    process.env.SEPARATOR_URL = 'http://separator:8000/';
    const stem = Buffer.alloc(MIN_STEM_BYTES + 10, 1);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => stem,
      headers: { get: () => 'htdemucs' },
    });

    const out = await isolateVocals({ ...clip(), log: silentLog });

    expect(out.separated).toBe(true);
    expect(out.filename).toBe('vocals.wav');
    expect(out.mimetype).toBe('audio/wav');
    expect(out.buffer.length).toBe(stem.length);
    // Trailing slash on the configured URL must not double up.
    expect(global.fetch.mock.calls[0][0]).toBe('http://separator:8000/separate');
  });

  it('falls back to the original mix when the separator errors', async () => {
    process.env.SEPARATOR_URL = 'http://separator:8000';
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => 'separation failed',
    });

    const out = await isolateVocals({ ...clip(), log: silentLog });

    // An accuracy improvement must never cost the caller their result.
    expect(out.separated).toBe(false);
    expect(out.reason).toBe('http_502');
    expect(out.buffer.toString()).toBe('original mixed audio bytes');
  });

  it('falls back when the separator is unreachable', async () => {
    process.env.SEPARATOR_URL = 'http://separator:8000';
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const out = await isolateVocals({ ...clip(), log: silentLog });

    expect(out.separated).toBe(false);
    expect(out.reason).toBe('unreachable');
    expect(out.buffer.toString()).toBe('original mixed audio bytes');
  });

  it('falls back on timeout rather than hanging the request', async () => {
    process.env.SEPARATOR_URL = 'http://separator:8000';
    global.fetch = jest.fn().mockRejectedValue(
      Object.assign(new Error('aborted'), { name: 'AbortError' })
    );

    const out = await isolateVocals({ ...clip(), log: silentLog });

    expect(out.separated).toBe(false);
    expect(out.reason).toBe('timeout');
  });

  it('rejects a stem too small to be a real vocal', async () => {
    process.env.SEPARATOR_URL = 'http://separator:8000';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Buffer.alloc(32),
      headers: { get: () => 'htdemucs' },
    });

    const out = await isolateVocals({ ...clip(), log: silentLog });

    // A near-empty WAV is a decode failure, not silence worth transcribing.
    expect(out.separated).toBe(false);
    expect(out.reason).toBe('empty_stem');
    expect(out.buffer.toString()).toBe('original mixed audio bytes');
  });

  it('sends the clip as multipart under the field the service expects', async () => {
    process.env.SEPARATOR_URL = 'http://separator:8000';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Buffer.alloc(MIN_STEM_BYTES + 1, 2),
      headers: { get: () => 'htdemucs' },
    });

    await isolateVocals({ ...clip(), log: silentLog });

    const [, init] = global.fetch.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.body.get('clip')).toBeTruthy();
    expect(init.signal).toBeDefined();
  });
});
