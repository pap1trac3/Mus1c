const {
  STYLE_PROFILE_KIND,
  MAX_PROFILE_LYRIC_CHARS,
  buildProfileText,
  buildProfileDocument,
  toProfileSummary,
  normalizeTags,
  MAX_TAGS,
  MAX_TAG_CHARS,
} = require('../../lib/styleMemory');

const DNA = {
  feel: 'Atmospheric / late-night reflective',
  cadence: '6-8 syllables per line, heavy internal slant rhyme',
  metaphor_domains: ['Night driving', 'Weather'],
};

describe('buildProfileText()', () => {
  it('states the style in terms the generation prompt can act on', () => {
    const text = buildProfileText({ style_dna: DNA, topic: 'moving on', lyrics: '[Verse 1]\nWords' });

    expect(text).toContain('Feel: Atmospheric / late-night reflective');
    expect(text).toContain('Cadence: 6-8 syllables per line, heavy internal slant rhyme');
    expect(text).toContain('Metaphor domains: Night driving, Weather');
    expect(text).toContain('on the topic "moving on"');
    expect(text).toContain('[Verse 1]\nWords');
  });

  it('caps the stored lyrics so one reel cannot swamp the retrieval budget', () => {
    const text = buildProfileText({
      style_dna: DNA,
      topic: 'x',
      lyrics: 'la '.repeat(2000),
    });

    // The header lines are short and fixed; the lyric body is what is bounded.
    expect(text.length).toBeLessThan(MAX_PROFILE_LYRIC_CHARS + 600);
  });

  it('still describes the style when the model wrote no lyrics', () => {
    const text = buildProfileText({ style_dna: DNA, topic: 'x', lyrics: '' });

    expect(text).toContain('Feel:');
    expect(text).not.toContain('Original lyrics');
  });

  it('falls back to Unknown rather than emitting an empty field', () => {
    const text = buildProfileText({ style_dna: {}, topic: '', lyrics: '' });

    expect(text).toContain('Feel: Unknown');
    expect(text).toContain('Cadence: Unknown');
    expect(text).toContain('Metaphor domains: none identified');
  });
});

describe('buildProfileDocument()', () => {
  const doc = () =>
    buildProfileDocument({
      vector: [0.1, 0.2],
      style_dna: DNA,
      topic: 'moving on',
      lyrics: '[Verse 1]\nWords',
      sourceName: 'clip.mp3',
    });

  it('carries the vector, the kind marker, and a generated id', () => {
    const document = doc();

    expect(document.$vector).toEqual([0.1, 0.2]);
    expect(document.metadata.kind).toBe(STYLE_PROFILE_KIND);
    expect(document.metadata.source).toBe('reel');
    expect(document.metadata.source_name).toBe('clip.mp3');
    expect(typeof document.metadata.document_id).toBe('string');
    expect(document.metadata.document_id.length).toBeGreaterThan(0);
  });

  it('gives each profile a distinct id', () => {
    expect(doc().metadata.document_id).not.toBe(doc().metadata.document_id);
  });

  it('stores its text under `text`, never under `transcript`', () => {
    const document = doc();

    // `transcript` is reserved for caller-supplied /api/ingest payloads, so
    // nothing reel-derived can ever be mistaken for a stored reel transcript.
    expect(document.transcript).toBeUndefined();
    expect(document.text).toContain('Feel: Atmospheric / late-night reflective');
  });

  it('mirrors the style into metadata so listing it needs no text parsing', () => {
    const { metadata } = doc();

    expect(metadata.feel).toBe(DNA.feel);
    expect(metadata.cadence).toBe(DNA.cadence);
    expect(metadata.metaphor_domains).toEqual(DNA.metaphor_domains);
    expect(metadata.topic).toBe('moving on');
    expect(Date.parse(metadata.learned_at)).not.toBeNaN();
  });

  it('groups like a single-chunk document', () => {
    const { metadata } = doc();

    expect(metadata.chunk_index).toBe(0);
    expect(metadata.total_chunks).toBe(1);
  });

  it('bounds an absurd source filename', () => {
    const document = buildProfileDocument({
      vector: [],
      style_dna: DNA,
      topic: 't',
      lyrics: 'l',
      sourceName: 'a'.repeat(500),
    });

    expect(document.metadata.source_name.length).toBeLessThanOrEqual(120);
  });
});

describe('toProfileSummary()', () => {
  it('returns metadata only — never the stored text blob', () => {
    const summary = toProfileSummary({
      _id: 'internal',
      text: 'the whole profile body',
      metadata: {
        document_id: 'prof-1',
        feel: DNA.feel,
        cadence: DNA.cadence,
        metaphor_domains: DNA.metaphor_domains,
        topic: 'moving on',
        source_name: 'clip.mp3',
        learned_at: '2026-09-11T00:00:00.000Z',
      },
    });

    expect(summary).toEqual({
      id: 'prof-1',
      feel: DNA.feel,
      cadence: DNA.cadence,
      metaphor_domains: DNA.metaphor_domains,
      literary_devices: [],
      tags: [],
      source: 'reel',
      topic: 'moving on',
      source_name: 'clip.mp3',
      learned_at: '2026-09-11T00:00:00.000Z',
    });
    expect(JSON.stringify(summary)).not.toContain('the whole profile body');
  });

  it('fills in defaults for a document written by an older version', () => {
    const summary = toProfileSummary({ _id: 'doc-9', metadata: {} });

    expect(summary.id).toBe('doc-9');
    expect(summary.feel).toBe('Unknown');
    expect(summary.metaphor_domains).toEqual([]);
    expect(summary.learned_at).toBeNull();
  });
});

describe('normalizeTags()', () => {
  it('trims and lowercases, so a filter matches however a tag was typed', () => {
    expect(normalizeTags(['  Aggressive ', 'R&B Hook'])).toEqual(['aggressive', 'r&b hook']);
  });

  it('dedupes case variants of the same tag', () => {
    expect(normalizeTags(['Melodic', 'melodic', 'MELODIC'])).toEqual(['melodic']);
  });

  it('drops blank entries rather than storing empty tags', () => {
    expect(normalizeTags(['fast', '', '   ', 'slow'])).toEqual(['fast', 'slow']);
  });

  it('caps how many tags one profile can carry', () => {
    const tags = normalizeTags(Array.from({ length: MAX_TAGS + 5 }, (_, i) => 'tag' + i));

    expect(tags).toHaveLength(MAX_TAGS);
  });

  it('truncates an over-long tag instead of storing it whole', () => {
    const [tag] = normalizeTags(['x'.repeat(MAX_TAG_CHARS + 50)]);

    expect(tag).toHaveLength(MAX_TAG_CHARS);
  });

  it('reads anything that is not an array as no tags', () => {
    expect(normalizeTags(undefined)).toEqual([]);
    expect(normalizeTags('aggressive')).toEqual([]);
    expect(normalizeTags(null)).toEqual([]);
  });

  it('ignores non-string entries rather than coercing them', () => {
    expect(normalizeTags([42, { tag: 'x' }, 'fast'])).toEqual(['fast']);
  });
});
