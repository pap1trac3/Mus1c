const {
  countSyllables,
  countLineSyllables,
  lyricLines,
  rhymeKey,
  detectRhymeScheme,
  internalRhymeDensity,
  analyzeProsody,
  buildBarGrid,
  beatPositions,
} = require('../../lib/prosody');

describe('countSyllables()', () => {
  it('counts ordinary lyric vocabulary', () => {
    expect(countSyllables('night')).toBe(1);
    expect(countSyllables('shadow')).toBe(2);
    expect(countSyllables('remember')).toBe(3);
    expect(countSyllables('horizon')).toBe(3);
  });

  it('drops a silent trailing e', () => {
    expect(countSyllables('time')).toBe(1);
    expect(countSyllables('place')).toBe(1);
  });

  it('keeps the syllable "-le" carries', () => {
    expect(countSyllables('little')).toBe(2);
    expect(countSyllables('simple')).toBe(2);
    expect(countSyllables('trouble')).toBe(2);
  });

  it('knows when "-ed" sounds and when it does not', () => {
    expect(countSyllables('walked')).toBe(1);
    expect(countSyllables('loved')).toBe(1);
    expect(countSyllables('wanted')).toBe(2);
    expect(countSyllables('crooked')).toBe(2);
  });

  it('knows when "-es" sounds and when it does not', () => {
    expect(countSyllables('places')).toBe(2);
    expect(countSyllables('wishes')).toBe(2);
    expect(countSyllables('boxes')).toBe(2);
  });

  it('treats "-ing" as its own syllable even after a vowel', () => {
    expect(countSyllables('falling')).toBe(2);
    expect(countSyllables('going')).toBe(2);
    expect(countSyllables('lying')).toBe(2);
  });

  it('splits vowel pairs that are really two sounds', () => {
    expect(countSyllables('radio')).toBe(3);
    expect(countSyllables('curious')).toBe(3);
  });

  it('handles the syllabic consonant in "-thm" and "-sm"', () => {
    expect(countSyllables('rhythm')).toBe(2);
    expect(countSyllables('prism')).toBe(2);
  });

  it('ignores apostrophes rather than treating them as breaks', () => {
    expect(countSyllables("don't")).toBe(1);
    expect(countSyllables("runnin'")).toBe(2);
  });

  it('returns 0 for anything with no letters, so punctuation cannot inflate a line', () => {
    expect(countSyllables('...')).toBe(0);
    expect(countSyllables('')).toBe(0);
    expect(countSyllables(null)).toBe(0);
  });
});

describe('countLineSyllables()', () => {
  it('totals a whole line', () => {
    expect(countLineSyllables('Late night driving through the city lights')).toBe(9);
    expect(countLineSyllables('I remember everything you said to me')).toBe(12);
  });

  it('does not count bracketed performance tags, which are not sung', () => {
    expect(countLineSyllables('[whispered] Nothing lasts forever')).toBe(6);
    expect(countLineSyllables('Nothing lasts forever')).toBe(6);
  });

  it('counts hyphenated melisma as separate syllables, as the sheet marks them', () => {
    expect(countLineSyllables('for-ev-er')).toBe(3);
  });
});

describe('lyricLines()', () => {
  it('keeps sung lines and drops headers and blanks', () => {
    const sheet = '[Verse 1]\nFirst line here\n\nSecond line here\n\n[Chorus]\nThird line here';

    expect(lyricLines(sheet)).toEqual(['First line here', 'Second line here', 'Third line here']);
  });

  it('drops a line that is only a performance tag', () => {
    expect(lyricLines('[ad-lib]\nReal words')).toEqual(['Real words']);
  });
});

describe('rhymeKey()', () => {
  it('matches words that rhyme', () => {
    expect(rhymeKey('night')).toBe(rhymeKey('light'));
    expect(rhymeKey('rain')).toBe(rhymeKey('pain'));
  });

  it('matches across spellings of the same sound', () => {
    expect(rhymeKey('seen')).toBe(rhymeKey('scene'));
  });

  it('separates words that do not rhyme', () => {
    expect(rhymeKey('night')).not.toBe(rhymeKey('shadow'));
  });
});

describe('detectRhymeScheme()', () => {
  it('names a couplet scheme', () => {
    const { pattern } = detectRhymeScheme(['burning light', 'through the night', 'falling rain', 'so much pain']);

    expect(pattern).toBe('AABB');
  });

  it('names an alternating scheme', () => {
    const { pattern } = detectRhymeScheme(['burning light', 'falling rain', 'through the night', 'so much pain']);

    expect(pattern).toBe('ABAB');
  });

  it('names the shape regardless of which letters fall first', () => {
    const { pattern } = detectRhymeScheme(['falling rain', 'so much pain', 'burning light', 'through the night']);

    expect(pattern).toBe('AABB');
  });

  it('reports mixed rather than averaging groups that disagree', () => {
    const { pattern } = detectRhymeScheme([
      'burning light', 'through the night', 'falling rain', 'so much pain',
      'burning light', 'falling rain', 'through the night', 'so much pain',
    ]);

    expect(pattern).toBe('mixed');
  });

  it('says unknown rather than guessing from too little text', () => {
    expect(detectRhymeScheme(['one line']).pattern).toBe('unknown');
    expect(detectRhymeScheme(['one line', 'two lines']).pattern).toBe('unknown');
  });
});

describe('internalRhymeDensity()', () => {
  it('scores a line whose rhyme lands inside it', () => {
    expect(internalRhymeDensity(['the rain came down the same old way'])).toBe(1);
  });

  it('scores nothing when rhyme only lands at line ends', () => {
    expect(internalRhymeDensity(['walking through the door', 'counting up the score'])).toBe(0);
  });

  it('does not count a repeated word as a rhyme with itself', () => {
    expect(internalRhymeDensity(['never never never let go'])).toBe(0);
  });

  it('reports a ratio of lines, not a raw count', () => {
    expect(internalRhymeDensity(['the rain came down the same old way', 'nothing here at all'])).toBe(0.5);
  });
});

describe('analyzeProsody()', () => {
  it('reports the mechanics of a sheet', () => {
    const sheet = [
      '[Verse 1]',
      'Walking through the burning light',
      'Counting every fallen star',
      'Nothing left to hold me tight',
      'Wondering just where you are',
    ].join('\n');

    const result = analyzeProsody(sheet);

    expect(result.line_count).toBe(4);
    expect(result.syllables_per_line.avg).toBeGreaterThan(5);
    expect(result.syllables_per_line.min).toBeLessThanOrEqual(result.syllables_per_line.avg);
    expect(result.syllables_per_line.max).toBeGreaterThanOrEqual(result.syllables_per_line.avg);
    expect(result.rhyme_scheme).toBe('ABAB');
  });

  it('reports nulls, not zeros, when there is nothing to measure', () => {
    const result = analyzeProsody('[Verse 1]\n\n');

    expect(result.line_count).toBe(0);
    expect(result.syllables_per_line).toEqual({ avg: null, min: null, max: null });
    expect(result.rhyme_scheme).toBe('unknown');
  });

  it('survives input that is not a string', () => {
    expect(analyzeProsody(undefined).line_count).toBe(0);
    expect(analyzeProsody(null).line_count).toBe(0);
  });
});

describe('buildBarGrid()', () => {
  const sheet = '[Verse 1]\nShort line\nA considerably longer line with many more syllables in it';

  it('places every sung line on a bar, headers excluded', () => {
    const grid = buildBarGrid(sheet, { bpm: 90 });

    expect(grid.rows).toHaveLength(2);
    expect(grid.rows[0].start_bar).toBe(1);
  });

  it('gives a dense line more bars than a sparse one', () => {
    const grid = buildBarGrid(sheet, { bpm: 90 });

    expect(grid.rows[1].bars).toBeGreaterThan(grid.rows[0].bars);
  });

  it('runs bars consecutively with no gaps or overlaps', () => {
    const grid = buildBarGrid(sheet, { bpm: 90 });

    expect(grid.rows[1].start_bar).toBe(grid.rows[0].end_bar + 1);
    expect(grid.total_bars).toBe(grid.rows[grid.rows.length - 1].end_bar);
  });

  it('gives every line at least one bar, however short', () => {
    const grid = buildBarGrid('Hey');

    expect(grid.rows[0].bars).toBe(1);
  });

  it('converts bars to seconds at the given tempo', () => {
    const grid = buildBarGrid(sheet, { bpm: 120 });

    // 4 beats at 120bpm is 2 seconds per bar; the first line starts at zero.
    expect(grid.rows[0].start_seconds).toBe(0);
    expect(grid.rows[1].start_seconds).toBe((grid.rows[1].start_bar - 1) * 2);
  });

  it('omits timings rather than inventing a tempo when none is given', () => {
    const grid = buildBarGrid(sheet);

    expect(grid.bpm).toBeNull();
    expect(grid.rows[0].start_seconds).toBeNull();
  });

  it('ignores a nonsense tempo rather than producing negative timings', () => {
    expect(buildBarGrid(sheet, { bpm: -20 }).bpm).toBeNull();
    expect(buildBarGrid(sheet, { bpm: NaN }).bpm).toBeNull();
  });
});

describe('mapRhymes()', () => {
  const { mapRhymes, internalRhymeWords } = require('../../lib/prosody');

  const SHEET = [
    '[Verse 1]',
    'Walking through the burning light',
    'Counting every fallen star',
    'Nothing left to hold me tight',
    'Wondering just where you are',
  ].join('\n');

  it('labels lines that rhyme with each other', () => {
    const map = mapRhymes(SHEET);

    expect(map.lines.map((line) => line.group)).toEqual(['A', 'B', 'A', 'B']);
  });

  it('indexes against the raw sheet, headers included', () => {
    const map = mapRhymes(SHEET);

    // The header is line 0; the first sung line is line 1.
    expect(map.lines[0].index).toBe(1);
    expect(SHEET.split('\n')[map.lines[0].index]).toBe('Walking through the burning light');
  });

  it('reports the end word each group was decided on', () => {
    const map = mapRhymes(SHEET);

    expect(map.lines.map((line) => line.end_word)).toEqual(['light', 'star', 'tight', 'are']);
  });

  it('leaves a line that rhymes with nothing unlabelled', () => {
    const map = mapRhymes('First and only line\nSomething entirely different');

    expect(map.lines.every((line) => line.group === null)).toBe(true);
    expect(map.groups).toEqual([]);
  });

  it('matches slant rhyme, not just perfect rhyme', () => {
    const map = mapRhymes('holding on\nolder song');

    expect(map.lines[0].group).toBe(map.lines[1].group);
    expect(map.lines[0].group).not.toBeNull();
  });

  it('skips headers and blank lines entirely', () => {
    const map = mapRhymes('[Verse 1]\n\nonly line here');

    expect(map.lines).toHaveLength(1);
  });

  it('survives input that is not a string', () => {
    expect(mapRhymes(null).lines).toEqual([]);
    expect(mapRhymes(undefined).groups).toEqual([]);
  });
});

describe('internalRhymeWords()', () => {
  const { internalRhymeWords } = require('../../lib/prosody');

  it('returns both halves of an internal rhyme, not just the second', () => {
    const words = internalRhymeWords('the rain came down the same old way');

    expect(words).toContain('came');
    expect(words).toContain('same');
  });

  it('does not treat a repeated word as rhyming with itself', () => {
    expect(internalRhymeWords('never never never let go')).toEqual([]);
  });

  it('returns nothing when rhyme lands only at the line end', () => {
    expect(internalRhymeWords('walking to the door')).toEqual([]);
  });
});

describe('slantKey()', () => {
  const { slantKey, rhymeKey } = require('../../lib/prosody');

  it('matches a nasal slant rhyme the strict key misses', () => {
    expect(rhymeKey('time')).not.toBe(rhymeKey('mine'));
    expect(slantKey('time')).toBe(slantKey('mine'));
  });

  it('matches across a voiced/unvoiced consonant pair', () => {
    expect(slantKey('cat')).toBe(slantKey('cad'));
  });

  it('still requires the vowel to match — otherwise it is alliteration', () => {
    expect(slantKey('light')).not.toBe(slantKey('start'));
    expect(slantKey('rain')).not.toBe(slantKey('shadow'));
  });

  it('treats "ng" as one sound, so "on" and "song" rhyme', () => {
    expect(slantKey('on')).toBe(slantKey('song'));
  });

  it('keeps perfect rhymes matching', () => {
    expect(slantKey('light')).toBe(slantKey('night'));
    expect(slantKey('seen')).toBe(slantKey('scene'));
  });

  it('returns empty for a word with no letters', () => {
    expect(slantKey('...')).toBe('');
    expect(slantKey(null)).toBe('');
  });
});

describe('beatPositions()', () => {
  it('lands a beat every two syllables at the grid\'s own density', () => {
    // Walk-ing (2) through (1) the (1) burn-ing (2) light (1) — a beat every
    // second syllable puts one on each of the four words that start on one.
    expect(beatPositions('Walking through the burning light')).toEqual([
      { word: 'Walking', column: 0, bar: 1, beat: 1, on_word_start: true },
      { word: 'through', column: 8, bar: 1, beat: 2, on_word_start: true },
      { word: 'burning', column: 20, bar: 1, beat: 3, on_word_start: true },
      { word: 'light', column: 28, bar: 1, beat: 4, on_word_start: true },
    ]);
  });

  it('says when a beat falls inside a word rather than nudging it to the nearest', () => {
    const beats = beatPositions('Counting every fallen star');

    expect(beats.map((b) => [b.beat, b.word, b.on_word_start])).toEqual([
      [1, 'Counting', true],
      [2, 'every', true],
      [3, 'every', false],
      [4, 'fallen', false],
    ]);
  });

  it('keeps columns aligned to the printed line, tags and all', () => {
    const line = '[whispered] Hold me in the dark';
    const [first] = beatPositions(line);

    expect(first.word).toBe('Hold');
    expect(line.slice(first.column, first.column + 4)).toBe('Hold');
  });

  it('rolls over into the next bar once four beats are used', () => {
    // Sixteen syllables is eight beats: two full 4/4 bars.
    const beats = beatPositions('never ever never ever never ever never ever');

    expect(beats).toHaveLength(8);
    expect(beats[4]).toMatchObject({ bar: 2, beat: 1 });
    expect(beats[7]).toMatchObject({ bar: 2, beat: 4 });
  });

  it('has nothing to place on a line with no words', () => {
    expect(beatPositions('')).toEqual([]);
    expect(beatPositions('[instrumental]')).toEqual([]);
    expect(beatPositions(null)).toEqual([]);
  });

  it('rides along on every bar grid row, so the browser never recounts', () => {
    const grid = buildBarGrid('[Verse 1]\nWalking through the burning light', { bpm: 120 });

    expect(grid.rows[0].beats).toHaveLength(4);
    expect(grid.rows[0].beats[0].word).toBe('Walking');
  });
});
