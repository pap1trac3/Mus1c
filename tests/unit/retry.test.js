const { withRetry, isTransient } = require('../../lib/retry');

const silent = { warn: () => {}, error: () => {}, info: () => {} };
const fast = { initialDelayMs: 1, maxDelayMs: 2, log: silent };

describe('isTransient', () => {
  it.each([408, 409, 429, 500, 502, 503, 504])('treats %s as transient', (status) => {
    expect(isTransient({ status })).toBe(true);
  });

  it.each([400, 401, 403, 404, 422])('treats %s as permanent', (status) => {
    expect(isTransient({ status })).toBe(false);
  });

  it('treats a transport error with no status as transient', () => {
    expect(isTransient(new Error('socket hang up'))).toBe(true);
  });

  it('reads the status off a nested response object', () => {
    expect(isTransient({ response: { status: 503 } })).toBe(true);
    expect(isTransient({ response: { status: 401 } })).toBe(false);
  });
});

describe('withRetry', () => {
  it('returns the value without retrying when the call succeeds', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    await expect(withRetry(fn, fast)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a transient failure and returns the eventual success', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 503 }))
      .mockResolvedValue('recovered');

    await expect(withRetry(fn, fast)).resolves.toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry a permanent failure', async () => {
    const err = Object.assign(new Error('bad key'), { status: 401 });
    const fn = jest.fn().mockRejectedValue(err);

    await expect(withRetry(fn, fast)).rejects.toThrow('bad key');
    // A 401 cannot succeed on retry — one attempt only.
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('gives up after `attempts` tries and rethrows the last error', async () => {
    const err = Object.assign(new Error('still down'), { status: 500 });
    const fn = jest.fn().mockRejectedValue(err);

    await expect(withRetry(fn, { ...fast, attempts: 3 })).rejects.toThrow('still down');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('always makes at least one attempt even if attempts is 0', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    await expect(withRetry(fn, { ...fast, attempts: 0 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('backs off within the jitter ceiling rather than a fixed delay', async () => {
    const delays = [];
    const realSetTimeout = global.setTimeout;
    jest.spyOn(global, 'setTimeout').mockImplementation((cb, ms) => {
      delays.push(ms);
      return realSetTimeout(cb, 0);
    });

    const fn = jest.fn().mockRejectedValue(Object.assign(new Error('x'), { status: 500 }));
    await expect(
      withRetry(fn, { attempts: 3, initialDelayMs: 100, factor: 2, maxDelayMs: 5000, log: silent })
    ).rejects.toThrow();

    expect(delays).toHaveLength(2);
    expect(delays[0]).toBeGreaterThanOrEqual(0);
    expect(delays[0]).toBeLessThanOrEqual(100); // full jitter across [0, 100]
    expect(delays[1]).toBeLessThanOrEqual(200); // ceiling doubles
    global.setTimeout.mockRestore();
  });
});
