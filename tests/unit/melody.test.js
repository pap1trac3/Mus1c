const { sanitizeMelody, clampTempo, MAX_EVENTS } = require('../../lib/melody');

const ok = (over = {}) => ({ note: 'D4', duration: '8n', time: '0:0:0', ...over });

describe('sanitizeMelody', () => {
  it('keeps a well-formed single note', () => {
    expect(sanitizeMelody([ok()])).toEqual([{ note: 'D4', duration: '8n', time: '0:0:0' }]);
  });

  it('keeps a chord and caps its size', () => {
    const [event] = sanitizeMelody([
      ok({ note: ['C4', 'E4', 'G4', 'B4', 'D5', 'F5', 'A5', 'C6'], duration: '2n' }),
    ]);
    expect(event.note).toHaveLength(6);
  });

  it.each([
    ['unknown letter', 'H4'],
    ['missing octave', 'C'],
    ['octave out of range', 'C9'],
    ['lowercase', 'c4'],
    ['not a string', 42],
  ])('drops an event with an invalid note (%s)', (_label, note) => {
    expect(sanitizeMelody([ok({ note })])).toEqual([]);
  });

  it.each([
    ['invalid token', 'quarter'],
    ['unsupported value', '3n'],
    ['empty', ''],
  ])('drops an event with an invalid duration (%s)', (_label, duration) => {
    expect(sanitizeMelody([ok({ duration })])).toEqual([]);
  });

  it.each([
    ['free text', 'later'],
    ['injection-shaped', '0:0:0; drop table'],
    ['wrong separator', '0.0.0'],
  ])('drops an event with an invalid time (%s)', (_label, time) => {
    expect(sanitizeMelody([ok({ time })])).toEqual([]);
  });

  it('keeps the valid events and discards only the malformed ones', () => {
    const result = sanitizeMelody([ok(), ok({ note: 'nope' }), ok({ time: '1:0:0' })]);
    expect(result).toEqual([
      { note: 'D4', duration: '8n', time: '0:0:0' },
      { note: 'D4', duration: '8n', time: '1:0:0' },
    ]);
  });

  it('accepts dotted and triplet durations', () => {
    expect(sanitizeMelody([ok({ duration: '4n.' }), ok({ duration: '8t' })])).toHaveLength(2);
  });

  it.each([[null], [undefined], ['string'], [{}], [42]])(
    'returns an empty array for non-array input (%p)',
    (input) => {
      expect(sanitizeMelody(input)).toEqual([]);
    }
  );

  it('ignores non-object entries', () => {
    expect(sanitizeMelody([null, 'C4', 7, ok()])).toHaveLength(1);
  });

  it('caps a runaway melody so it cannot schedule unbounded events', () => {
    const huge = Array.from({ length: 5000 }, () => ok());
    expect(sanitizeMelody(huge)).toHaveLength(MAX_EVENTS);
  });
});

describe('clampTempo', () => {
  it('passes a sensible tempo through, rounded', () => {
    expect(clampTempo(128.6)).toBe(129);
  });

  it('clamps to the same bounds the request schema enforces', () => {
    expect(clampTempo(9999)).toBe(300);
    expect(clampTempo(1)).toBe(30);
  });

  it('accepts a numeric string', () => {
    expect(clampTempo('96')).toBe(96);
  });

  // Number() coerces all of these to 0, which is finite — without an explicit
  // type check they would clamp to the 30 BPM floor instead of defaulting.
  it.each([['abc'], [null], [undefined], [NaN], [''], ['   '], [false], [[]], [{}]])(
    'falls back to the default for non-numeric input (%p)',
    (v) => {
      expect(clampTempo(v)).toBe(120);
    }
  );
});
