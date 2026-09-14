const {
  formatClock,
  csvField,
  buildMarkerCsv,
  beatMarkerRow,
  recordingSheetRows,
  annotateRow,
  describeSheetProsody,
  buildRecordingSheetText,
} = require('../../public/exports');
const { buildBarGrid, analyzeProsody } = require('../../lib/prosody');

const SHEET = [
  '[Verse 1]',
  'Walking through the burning light',
  'Counting every fallen star',
  '',
  '[Chorus]',
  'Hold me in the dark',
].join('\n');

const result = (overrides = {}) => ({
  structured_lyrics: SHEET,
  style_prompt: 'lo-fi, 96 bpm',
  prosody: analyzeProsody(SHEET),
  bar_grid: buildBarGrid(SHEET, { bpm: 120 }),
  ...overrides,
});

describe('formatClock', () => {
  it('reads the way a DAW displays a marker time', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(9.6)).toBe('0:09');
    expect(formatClock(125)).toBe('2:05');
  });
});

describe('csvField', () => {
  it('quotes only when it has to', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('has, comma')).toBe('"has, comma"');
    expect(csvField('say "it"')).toBe('"say ""it"""');
    expect(csvField(null)).toBe('');
  });
});

describe('buildMarkerCsv', () => {
  it('writes one row per sung line, headers excluded', () => {
    const lines = buildMarkerCsv(result()).trim().split('\n');

    expect(lines[0]).toBe('name,start_seconds,start_bar,end_bar,syllables');
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain('Walking through the burning light');
  });

  it('returns just the header when there is nothing to export', () => {
    expect(buildMarkerCsv(null)).toBe('name,start_seconds,start_bar,end_bar,syllables\n');
  });
});

describe('beatMarkerRow', () => {
  it('puts each beat under the word it lands on', () => {
    const line = 'Walking through the burning light';
    const row = beatMarkerRow(buildBarGrid(line).rows[0].beats);

    expect(row[0]).toBe('1');
    expect(row[line.indexOf('through')]).toBe('2');
    expect(row[line.indexOf('burning')]).toBe('3');
    expect(row[line.indexOf('light')]).toBe('4');
  });

  it('marks a beat that falls inside a word without claiming it starts there', () => {
    const row = beatMarkerRow(buildBarGrid('Counting every fallen star').rows[0].beats);

    // "every" carries beat 2 at its start and beat 3 inside it.
    expect(row).toBe('1        2·    ·');
  });

  it('has nothing to draw when no beats were measured', () => {
    expect(beatMarkerRow([])).toBe('');
    expect(beatMarkerRow(undefined)).toBe('');
  });
});

describe('recordingSheetRows', () => {
  it('keeps the sheet\'s own structure and pairs each sung line with its bars', () => {
    const rows = recordingSheetRows(result());

    expect(rows.map((row) => row.type)).toEqual([
      'header', 'line', 'line', 'blank', 'header', 'line',
    ]);
    expect(rows[1].row.start_bar).toBe(1);
    expect(rows[5].row.line).toBe('Hold me in the dark');
  });

  it('treats an unmeasured line as structure rather than inventing a bar for it', () => {
    const rows = recordingSheetRows({ structured_lyrics: '[Verse 1]\nA line', bar_grid: { rows: [] } });

    expect(rows.every((row) => row.type !== 'line')).toBe(true);
  });

  it('has nothing to lay out without a sheet', () => {
    expect(recordingSheetRows(null)).toEqual([{ type: 'blank', text: '' }]);
  });
});

describe('annotateRow', () => {
  it('names one bar singular and a span plural', () => {
    expect(annotateRow({ start_bar: 1, end_bar: 1, syllables: 7, start_seconds: 0 }))
      .toBe('Bar 1 · 7 syll. · 0:00');
    expect(annotateRow({ start_bar: 1, end_bar: 3, syllables: 20, start_seconds: null }))
      .toBe('Bars 1-3 · 20 syll.');
  });
});

describe('describeSheetProsody', () => {
  it('leaves out a rhyme scheme the analyser could not name', () => {
    const described = describeSheetProsody({
      syllables_per_line: { avg: 9, min: 7, max: 11 },
      rhyme_scheme: 'unknown',
      internal_rhyme_density: 0.3,
    });

    expect(described).toBe('9 syllables per line (7-11) · internal rhyme 0.3');
  });

  it('says nothing when nothing was measured', () => {
    expect(describeSheetProsody(null)).toBe('');
    expect(describeSheetProsody({ syllables_per_line: { avg: null } })).toBe('');
  });
});

describe('buildRecordingSheetText', () => {
  it('annotates every sung line in place and leaves the headers alone', () => {
    const text = buildRecordingSheetText(result());

    expect(text).toContain('[Verse 1]');
    expect(text).toContain('  Bar 1 · 7 syll. · 0:00');
    expect(text).toContain('  Walking through the burning light');
    expect(text).toContain('120 BPM · 4/4 · 3 bars');
    expect(text).toContain('Style: lo-fi, 96 bpm');
  });

  it('aligns the marker row with the lyric above it, indent included', () => {
    const lines = buildRecordingSheetText(result()).split('\n');
    const lyricAt = lines.findIndex((line) => line.includes('Walking through'));

    expect(lines[lyricAt].indexOf('burning')).toBe(lines[lyricAt + 1].indexOf('3'));
  });

  it('says what the markers mean rather than leaving digits unexplained', () => {
    expect(buildRecordingSheetText(result())).toContain('a digit is the beat that word lands on');
  });

  it('does not claim a tempo it was not given', () => {
    const text = buildRecordingSheetText(
      result({ bar_grid: buildBarGrid(SHEET), prosody: analyzeProsody(SHEET) })
    );

    expect(text).not.toContain('BPM');
    expect(text).not.toContain('0:00');
    expect(text).toContain('Walking through the burning light');
  });

  it('never runs more than one blank line together', () => {
    expect(buildRecordingSheetText(result())).not.toMatch(/\n{3}/);
  });

  it('produces a sheet even with nothing generated yet', () => {
    expect(() => buildRecordingSheetText(null)).not.toThrow();
    expect(buildRecordingSheetText(null)).toContain('MOZART — RECORDING SHEET');
  });
});
