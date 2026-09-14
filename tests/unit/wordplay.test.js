const {
  WORDPLAY_SYSTEM_PROMPT,
  buildWordplayMessages,
  parseWordplay,
  verifyRhymes,
  rhymeTarget,
} = require('../../lib/wordplay');

const proposal = (overrides = {}) =>
  JSON.stringify({
    double_entendres: [{ text: 'Counting on the fall', plays_on: 'fall' }],
    metaphor_clusters: [{ domain: 'boxing', images: ['a standing eight', 'the corner towel'] }],
    rhyme_extensions: [{ phrase: 'out of sight', note: 'opens the second verse' }],
    ...overrides,
  });

describe('buildWordplayMessages', () => {
  it('keeps every piece of caller input out of the system prompt', () => {
    const [system, user] = buildWordplayMessages({
      line: 'Walking through the burning light',
      sheet: '[Verse 1]\nWalking through the burning light',
      genre: 'drill',
      theme: 'leaving home',
    });

    expect(system.content).toBe(WORDPLAY_SYSTEM_PROMPT);
    expect(system.content).not.toContain('Walking through');
    expect(system.content).not.toContain('drill');
    expect(user.content).toContain('Walking through the burning light');
    expect(user.content).toContain('drill');
  });

  it('works on a line with no sheet around it', () => {
    const [, user] = buildWordplayMessages({ line: 'A line on its own' });

    expect(user.content).toContain('A line on its own');
    expect(user.content).not.toContain('The sheet it sits in');
  });
});

describe('parseWordplay', () => {
  it('reads the three groups the prompt asks for', () => {
    const parsed = parseWordplay(proposal());

    expect(parsed.doubleEntendres).toEqual([{ text: 'Counting on the fall', plays_on: 'fall' }]);
    expect(parsed.metaphorClusters[0].domain).toBe('boxing');
    expect(parsed.rhymeExtensions[0].phrase).toBe('out of sight');
  });

  it('drops entries missing the text that makes them useful', () => {
    const parsed = parseWordplay(proposal({
      double_entendres: [{ plays_on: 'fall' }, { text: 'Kept', plays_on: '' }],
      metaphor_clusters: [{ domain: 'boxing', images: [] }, { images: ['orphan'] }],
    }));

    expect(parsed.doubleEntendres).toEqual([{ text: 'Kept', plays_on: '' }]);
    expect(parsed.metaphorClusters).toEqual([]);
  });

  it('tolerates a missing key rather than failing the whole request', () => {
    const parsed = parseWordplay(JSON.stringify({ rhyme_extensions: [{ phrase: 'out of sight' }] }));

    expect(parsed.doubleEntendres).toEqual([]);
    expect(parsed.metaphorClusters).toEqual([]);
    expect(parsed.rhymeExtensions).toHaveLength(1);
  });

  it('rejects output that is not JSON at all', () => {
    expect(() => parseWordplay('here are some ideas!')).toThrow('valid JSON');
  });

  it('rejects output with nothing usable in it', () => {
    expect(() => parseWordplay(JSON.stringify({ double_entendres: [] }))).toThrow('no usable suggestions');
  });

  it('bounds what one call can put on the page', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ phrase: 'phrase ' + i }));
    const parsed = parseWordplay(proposal({ rhyme_extensions: many }));

    expect(parsed.rhymeExtensions.length).toBeLessThanOrEqual(10);
  });
});

describe('rhymeTarget', () => {
  it('is the last word, ignoring punctuation and performance tags', () => {
    expect(rhymeTarget('Walking through the burning light')).toBe('light');
    expect(rhymeTarget('Hold me in the dark... [whispered]')).toBe('dark');
    expect(rhymeTarget('[instrumental]')).toBe('');
  });
});

describe('verifyRhymes', () => {
  const line = 'Walking through the burning light';

  it('keeps the proposals that actually rhyme and counts the rest', () => {
    const { kept, dropped, target } = verifyRhymes(line, [
      { phrase: 'holding on tight', note: 'a' },
      { phrase: 'nothing at all', note: 'b' },
      { phrase: 'out of sight', note: 'c' },
    ]);

    expect(target).toBe('light');
    expect(kept.map((entry) => entry.phrase)).toEqual(['holding on tight', 'out of sight']);
    expect(dropped).toBe(1);
  });

  it('rejects a phrase that just repeats the word it was meant to rhyme with', () => {
    const { kept, dropped } = verifyRhymes(line, [{ phrase: 'the burning light', note: '' }]);

    expect(kept).toEqual([]);
    expect(dropped).toBe(1);
  });

  it('counts the syllables of what survives, so a multi-syllabic rhyme shows as one', () => {
    const { kept } = verifyRhymes(line, [{ phrase: 'holding on tight', note: '' }]);

    expect(kept[0].syllables).toBe(4);
  });

  it('accepts slant rhyme, which is the point rather than a failure', () => {
    // "time" and "line" share the vowel and differ only in the consonant frame.
    const { kept } = verifyRhymes('I lost track of time', [{ phrase: 'every single line', note: '' }]);

    expect(kept).toHaveLength(1);
  });

  it('drops everything when the line has no word to rhyme with', () => {
    const { kept, dropped } = verifyRhymes('[instrumental]', [{ phrase: 'out of sight', note: '' }]);

    expect(kept).toEqual([]);
    expect(dropped).toBe(1);
  });
});
