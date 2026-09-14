const { draftStore, diffLines, summarizeDiff, DRAFTS_KEY, MAX_DRAFTS } = require('../../public/drafts');

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

const draft = (id, lyrics) => ({ id, structured_lyrics: lyrics, saved_at: '2026-09-14T00:00:00.000Z' });

afterEach(() => {
  delete global.localStorage;
});

describe('draftStore', () => {
  it('saves and lists newest first', () => {
    installStorage();

    draftStore.save(draft('1', 'first'));
    draftStore.save(draft('2', 'second'));

    expect(draftStore.list().map((d) => d.id)).toEqual(['2', '1']);
  });

  it('does not store the same sheet twice in a row', () => {
    installStorage();

    draftStore.save(draft('1', 'same text'));
    draftStore.save(draft('2', 'same text'));

    expect(draftStore.list()).toHaveLength(1);
  });

  it('stores a sheet again once something else came between', () => {
    installStorage();

    draftStore.save(draft('1', 'a'));
    draftStore.save(draft('2', 'b'));
    draftStore.save(draft('3', 'a'));

    expect(draftStore.list()).toHaveLength(3);
  });

  it('drops the oldest drafts past the cap', () => {
    installStorage();

    for (let i = 0; i < MAX_DRAFTS + 5; i++) draftStore.save(draft(String(i), 'sheet ' + i));

    const drafts = draftStore.list();
    expect(drafts).toHaveLength(MAX_DRAFTS);
    expect(drafts[0].id).toBe(String(MAX_DRAFTS + 4));
  });

  it('removes one draft by id', () => {
    installStorage();

    draftStore.save(draft('1', 'a'));
    draftStore.save(draft('2', 'b'));

    expect(draftStore.remove('1').map((d) => d.id)).toEqual(['2']);
  });

  it('clears everything', () => {
    installStorage();

    draftStore.save(draft('1', 'a'));

    expect(draftStore.clear()).toEqual([]);
    expect(draftStore.list()).toEqual([]);
  });

  it('reads as empty rather than throwing when storage is blocked', () => {
    installStorage({ throwOnRead: true });

    expect(draftStore.list()).toEqual([]);
  });

  it('reads as empty rather than throwing on a corrupted value', () => {
    const data = installStorage();
    data.set(DRAFTS_KEY, 'not json');

    expect(draftStore.list()).toEqual([]);
  });

  it('reads as empty when the stored value is the wrong shape', () => {
    const data = installStorage();
    data.set(DRAFTS_KEY, '{"not":"an array"}');

    expect(draftStore.list()).toEqual([]);
  });

  it('sheds the oldest drafts rather than silently failing on quota', () => {
    // Room for roughly two drafts' worth of JSON.
    installStorage({ quotaAfterBytes: 200 });

    for (let i = 0; i < 10; i++) draftStore.save(draft(String(i), 'x'.repeat(40) + i));

    const drafts = draftStore.list();
    expect(drafts.length).toBeGreaterThan(0);
    expect(drafts.length).toBeLessThan(10);
    // The newest survives; the oldest are what got shed.
    expect(drafts[0].id).toBe('9');
  });

  it('gives up cleanly when storage refuses everything', () => {
    installStorage({ quotaAfterBytes: 0 });

    expect(draftStore.write([draft('1', 'a')])).toBe(false);
    expect(draftStore.list()).toEqual([]);
  });
});

describe('diffLines()', () => {
  it('marks an edited line as one removal and one addition', () => {
    const rows = diffLines('keep\nold line', 'keep\nnew line');

    expect(rows).toEqual([
      { type: 'same', text: 'keep' },
      { type: 'removed', text: 'old line' },
      { type: 'added', text: 'new line' },
    ]);
  });

  it('does not report every following line as changed after an insertion', () => {
    const rows = diffLines('a\nb\nc', 'a\nNEW\nb\nc');

    expect(summarizeDiff(rows)).toEqual({ added: 1, removed: 0, unchanged: 3 });
  });

  it('reports nothing changed for identical sheets', () => {
    expect(summarizeDiff(diffLines('a\nb', 'a\nb'))).toEqual({ added: 0, removed: 0, unchanged: 2 });
  });

  it('handles an empty side', () => {
    expect(summarizeDiff(diffLines('', 'a\nb')).added).toBe(2);
    expect(summarizeDiff(diffLines('a\nb', '')).removed).toBe(2);
  });

  it('survives input that is not a string', () => {
    expect(() => diffLines(null, undefined)).not.toThrow();
  });
});
