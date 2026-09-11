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
