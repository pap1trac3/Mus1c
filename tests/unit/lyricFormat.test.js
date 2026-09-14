const { normalizeLyricSheet, LONG_LINE } = require('../../lib/lyricFormat');

describe('normalizeLyricSheet()', () => {
  it('leaves a well-formed sheet exactly as it is', () => {
    const good = '[Verse 1]\nFaded ink upon the pages,\nIn the shadows of my thoughts.\n\n[Chorus]\nThis twilight is a canvas.';
    expect(normalizeLyricSheet(good)).toBe(good);
  });

  it('breaks a verse the model packed onto one line', () => {
    // Observed live: 163 characters of verse on a single line.
    const packed =
      '[Verse 1]\nSketching dreams on the back of a napkin, whispers echo in an empty room. ' +
      'Each stroke is a line that no one will read. Hold it tight, hold it tight.';

    expect(normalizeLyricSheet(packed)).toBe(
      '[Verse 1]\n' +
      'Sketching dreams on the back of a napkin, whispers echo in an empty room.\n' +
      'Each stroke is a line that no one will read.\n' +
      'Hold it tight, hold it tight.'
    );
  });

  it('pulls a section header onto its own line when the model inlines it', () => {
    const inlined = '[Verse 1] First line here [Chorus] Second line here';
    expect(normalizeLyricSheet(inlined)).toBe('[Verse 1]\nFirst line here\n\n[Chorus]\nSecond line here');
  });

  it('puts a blank line before each section, never after it', () => {
    const out = normalizeLyricSheet('[Verse 1]\n\n\nLine one\n\n\n[Chorus]\n\nLine two');
    expect(out).toBe('[Verse 1]\nLine one\n\n[Chorus]\nLine two');
  });

  it('does not break out inline performance tags', () => {
    // [whispered] is a delivery cue inside a line, not a section.
    const inline = '[Verse 1]\n[whispered] a short line here\nanother line';
    expect(normalizeLyricSheet(inline)).toBe(inline);
  });

  it('leaves a long line alone when it has no sentence break to split on', () => {
    const oneBreath = '[Verse 1]\n' + 'a'.repeat(LONG_LINE + 40);
    expect(normalizeLyricSheet(oneBreath)).toBe(oneBreath);
  });

  it('keeps a short line with a full stop intact', () => {
    // Under the threshold, a period is punctuation, not a packed verse.
    const short = '[Verse 1]\nStop. Go.\nAnother line';
    expect(normalizeLyricSheet(short)).toBe(short);
  });

  it('splits on the ellipsis micro-pauses the prompts ask for', () => {
    const packed = '[Verse 1]\n' + 'Holding on to what I know...' + ' '.repeat(1) +
      'Letting go of what I owe...' + ' Never looking back at all of it now anyway.';
    const out = normalizeLyricSheet(packed);
    expect(out.split('\n').length).toBeGreaterThan(2);
    expect(out.split('\n').every((l) => l.length <= LONG_LINE + 40)).toBe(true);
  });

  it('returns an empty string for empty or non-string input', () => {
    for (const value of ['', '   ', null, undefined, 42, {}]) {
      expect(normalizeLyricSheet(value)).toBe('');
    }
  });

  it('never leaves a trailing blank line', () => {
    expect(normalizeLyricSheet('[Verse 1]\nLine\n\n\n')).toBe('[Verse 1]\nLine');
  });
});

describe('splitSections()', () => {
  const { splitSections, findSection, replaceSection } = require('../../lib/lyricFormat');

  const SHEET = '[Verse 1]\nline one\nline two\n\n[Chorus]\nhook line\n\n[Verse 2]\nlast line';

  it('splits a sheet into its sections', () => {
    expect(splitSections(SHEET).map((s) => s.name)).toEqual(['Verse 1', 'Chorus', 'Verse 2']);
  });

  it('reassembles into the original sheet, so a rewrite can be put back', () => {
    expect(splitSections(SHEET).map((s) => s.text).join('\n\n')).toBe(SHEET);
  });

  it('keeps lines written before any header rather than dropping them', () => {
    const sections = splitSections('an orphan line\n\n[Chorus]\nhook');

    expect(sections[0].header).toBeNull();
    expect(sections[0].lines).toEqual(['an orphan line']);
  });

  it('does not treat an inline performance tag as a section header', () => {
    const sections = splitSections('[Verse 1]\n[whispered] a quiet line');

    expect(sections).toHaveLength(1);
    expect(sections[0].lines).toEqual(['[whispered] a quiet line']);
  });

  it('returns nothing for empty input', () => {
    expect(splitSections('')).toEqual([]);
    expect(splitSections(null)).toEqual([]);
  });
});

describe('findSection() and replaceSection()', () => {
  const { splitSections, findSection, replaceSection } = require('../../lib/lyricFormat');
  const sections = splitSections('[Verse 1]\nline one\n\n[Chorus]\nhook line');

  it('finds a section by its exact name, case-insensitively', () => {
    expect(findSection(sections, 'chorus')).toBe(1);
  });

  it('falls back to a prefix match when numbering is omitted', () => {
    expect(findSection(sections, 'verse')).toBe(0);
  });

  it('reports -1 rather than guessing when nothing matches', () => {
    expect(findSection(sections, 'bridge')).toBe(-1);
    expect(findSection(sections, '')).toBe(-1);
  });

  it('replaces one section and leaves every other byte-identical', () => {
    const updated = replaceSection(sections, 1, '[Chorus]\nnew hook');

    expect(updated).toBe('[Verse 1]\nline one\n\n[Chorus]\nnew hook');
  });
});
