const {
  schemeStore,
  normalizeScheme,
  describeScheme,
  SCHEMES_KEY,
  MAX_SCHEMES,
  BUILT_IN_SCHEMES,
} = require('../../public/schemes');

/** A localStorage stand-in whose failure modes match a real browser's. */
function installStorage({ throwOnRead = false, quotaAfterBytes = Infinity } = {}) {
  const data = new Map();

  global.localStorage = {
    getItem(key) {
      if (throwOnRead) throw new Error('access denied');
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      if (String(value).length > quotaAfterBytes) {
        const err = new Error('QuotaExceededError');
        err.name = 'QuotaExceededError';
        throw err;
      }
      data.set(key, String(value));
    },
    removeItem(key) {
      data.delete(key);
    },
  };

  return data;
}

afterEach(() => {
  delete global.localStorage;
});

describe('normalizeScheme', () => {
  it('keeps only the fields the writer actually pinned', () => {
    expect(
      normalizeScheme({ rhyme_scheme: 'ABAB', syllables_avg: '', syllables_min: '', syllables_max: '' })
    ).toEqual({ rhyme_scheme: 'ABAB' });
  });

  it('reads a blank syllable box as "not pinned", never as zero', () => {
    // Number('') is 0, which would clamp to the floor and demand one-syllable lines.
    expect(normalizeScheme({ syllables_avg: '', syllables_min: '', syllables_max: '' })).toBeNull();
  });

  it('returns null when nothing is pinned', () => {
    expect(normalizeScheme({})).toBeNull();
    expect(normalizeScheme(null)).toBeNull();
    expect(normalizeScheme('AABB')).toBeNull();
  });

  it('upper-cases the scheme label so "aabb" and "AABB" are one preset', () => {
    expect(normalizeScheme({ rhyme_scheme: ' aabb ' })).toEqual({ rhyme_scheme: 'AABB' });
  });

  it('reads a backwards range the way it was plainly meant', () => {
    expect(normalizeScheme({ syllables_min: 14, syllables_max: 6 })).toEqual({
      syllables_min: 6,
      syllables_max: 14,
    });
  });

  it('clamps to the bounds the API enforces rather than sending a rejected value', () => {
    expect(normalizeScheme({ syllables_avg: 99 })).toEqual({ syllables_avg: 40 });
    expect(normalizeScheme({ syllables_avg: -3 })).toEqual({ syllables_avg: 1 });
    expect(normalizeScheme({ internal_rhyme_density: 5 })).toEqual({ internal_rhyme_density: 1 });
  });

  it('keeps a density of zero, which is a real instruction', () => {
    expect(normalizeScheme({ internal_rhyme_density: 0 })).toEqual({ internal_rhyme_density: 0 });
  });

  it('drops values that are not numbers at all', () => {
    expect(normalizeScheme({ syllables_avg: 'twelve' })).toBeNull();
  });
});

describe('describeScheme', () => {
  it('names every pinned field', () => {
    expect(
      describeScheme({ rhyme_scheme: 'AABB', syllables_avg: 12, syllables_min: 10, syllables_max: 14 })
    ).toBe('AABB · 12 syll. (10–14)');
  });

  it('says so plainly when a preset pins nothing', () => {
    expect(describeScheme(null)).toBe('pins nothing');
    expect(describeScheme({})).toBe('pins nothing');
  });

  it('reports the density as the instruction it becomes', () => {
    expect(describeScheme({ internal_rhyme_density: 0.9 })).toBe('dense internal');
    expect(describeScheme({ internal_rhyme_density: 0.1 })).toBe('sparse internal');
  });
});

describe('schemeStore', () => {
  it('offers the built-in templates before anything is saved', () => {
    installStorage();

    expect(schemeStore.list()).toEqual([]);
    expect(schemeStore.all()).toHaveLength(BUILT_IN_SCHEMES.length);
    expect(schemeStore.all().every((preset) => preset.builtin)).toBe(true);
  });

  it('saves a preset and finds it by id', () => {
    installStorage();

    const [saved] = schemeStore.save('My flow', { rhyme_scheme: 'ABAB', syllables_avg: 10 });

    expect(saved.name).toBe('My flow');
    expect(saved.scheme).toEqual({ rhyme_scheme: 'ABAB', syllables_avg: 10 });
    expect(schemeStore.find(saved.id)).toEqual(saved);
  });

  it('refuses to save a preset that pins nothing', () => {
    installStorage();

    expect(schemeStore.save('Empty', { rhyme_scheme: '', syllables_avg: '' })).toBeNull();
    expect(schemeStore.list()).toEqual([]);
  });

  it('replaces a saved preset of the same name rather than doubling it', () => {
    installStorage();

    schemeStore.save('My flow', { rhyme_scheme: 'AABB' });
    const next = schemeStore.save('my flow', { rhyme_scheme: 'ABAB' });

    expect(next).toHaveLength(1);
    expect(next[0].scheme).toEqual({ rhyme_scheme: 'ABAB' });
  });

  it('leaves the built-ins alone when a saved preset shares their name', () => {
    installStorage();

    schemeStore.save('AABB couplets', { rhyme_scheme: 'AABB', syllables_avg: 9 });

    expect(schemeStore.all()).toHaveLength(BUILT_IN_SCHEMES.length + 1);
    expect(schemeStore.find('builtin:aabb').scheme.syllables_avg).toBeUndefined();
  });

  it('removing a built-in is a no-op, not an error', () => {
    installStorage();

    schemeStore.save('My flow', { rhyme_scheme: 'ABAB' });
    schemeStore.remove('builtin:aabb');

    expect(schemeStore.find('builtin:aabb')).not.toBeNull();
    expect(schemeStore.list()).toHaveLength(1);
  });

  it('caps the stored list', () => {
    installStorage();

    for (let i = 0; i < MAX_SCHEMES + 5; i++) {
      schemeStore.save(`preset ${i}`, { syllables_avg: 8 });
    }

    expect(schemeStore.list()).toHaveLength(MAX_SCHEMES);
    expect(schemeStore.list()[0].name).toBe(`preset ${MAX_SCHEMES + 4}`);
  });

  it('survives a browser that refuses to read storage', () => {
    installStorage({ throwOnRead: true });

    expect(schemeStore.list()).toEqual([]);
    expect(schemeStore.all()).toHaveLength(BUILT_IN_SCHEMES.length);
  });

  it('sheds the oldest presets when the browser rejects the write for quota', () => {
    const data = installStorage({ quotaAfterBytes: 400 });

    for (let i = 0; i < 10; i++) schemeStore.save(`preset ${i}`, { syllables_avg: 8 });

    expect(data.get(SCHEMES_KEY).length).toBeLessThanOrEqual(400);
    expect(schemeStore.list().length).toBeGreaterThan(0);
  });

  it('does not throw when localStorage is missing entirely', () => {
    delete global.localStorage;

    expect(() => schemeStore.list()).not.toThrow();
    expect(schemeStore.list()).toEqual([]);
  });
});
