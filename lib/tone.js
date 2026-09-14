/**
 * Tone steering: how hard the lyrics police their own language.
 *
 * These are prompt constraints, not filters. A constraint in the prompt steers
 * a model; it does not guarantee an outcome, and nothing here inspects the
 * output afterwards. That distinction is deliberate and it is why the
 * strictest mode is named "sync-friendly" rather than "sync-safe": clearing a
 * lyric for synchronisation licensing is a legal judgement about trademarks,
 * samples and quotation that no prompt can make. This narrows the odds and
 * flags what to check. It does not clear anything.
 */

const MODES = {
  // The default, and what every generation did before this existed.
  raw: {
    label: 'Unfiltered',
    instruction: '',
  },
  radio: {
    label: 'Radio edit',
    instruction: [
      'Language constraint — radio edit:',
      '- No profanity, slurs, or explicit sexual description. Not censored with symbols or bleeps: write the line so it does not need them.',
      '- Where the reference style leans on a profane stress word, replace it with a word that keeps the same stress and rhyme, not with a milder synonym that breaks the line.',
      '- Violence and drug references may stay as imagery, but not as instruction.',
    ].join('\n'),
  },
  sync: {
    label: 'Sync-friendly',
    instruction: [
      'Language constraint — sync-friendly (for pitching to film, TV and advertising):',
      '- Everything the radio edit requires, plus:',
      '- No brand names, trademarks, company names, or product names.',
      '- No named real people, living or dead.',
      '- No quoted or paraphrased lyrics from existing songs, and no well-known catchphrases.',
      '- Keep the subject matter broad enough to score a scene: avoid specific real events.',
    ].join('\n'),
  },
};

const DEFAULT_MODE = 'raw';

/** The prompt text for a mode. Unknown or absent reads as unfiltered. */
function toneInstruction(mode) {
  return (MODES[mode] || MODES[DEFAULT_MODE]).instruction;
}

/** Whether a mode narrows anything, for callers deciding what to report. */
function isSteered(mode) {
  return Boolean(toneInstruction(mode));
}

function normalizeTone(mode) {
  return Object.prototype.hasOwnProperty.call(MODES, mode) ? mode : DEFAULT_MODE;
}

module.exports = { MODES, DEFAULT_MODE, toneInstruction, isSteered, normalizeTone };
