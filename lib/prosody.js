/**
 * Poetic mechanics: syllable counts, rhyme scheme, and bar placement.
 *
 * Deliberately deterministic rather than model-derived. Two reasons:
 *
 * 1. Language models are unreliable syllable counters — they routinely miss on
 *    the exact words that matter here ("fire", "every", "rhythm"). A metric the
 *    generator is then told to obey has to be right, or it teaches the wrong
 *    constraint.
 * 2. The bar grid has to score lyrics the model has *already* written, so the
 *    counts must be computable after the fact regardless. Once that exists,
 *    asking the model for the same numbers is redundant and worse.
 *
 * English syllable counting has no exact rule without a pronunciation
 * dictionary, so this is a heuristic. It is tuned to be right on ordinary
 * lyric vocabulary and to fail by at most one on the rest — which is the
 * accuracy a bar grid needs, since a line is placed by its total, not by any
 * single word.
 */

// Bracketed performance tags ([whispered], [Verse 1]) are not sung, so they
// are stripped before anything is counted.
const BRACKETED = /\[[^\]]*\]/g;

/** Hyphenated melisma ("be-au-ti-ful") is the prompt's way of marking held
 *  syllables — each piece is its own syllable, so split rather than join. */
const WORD_SPLIT = /[^a-z']+/i;

// Irregulars no vowel-group rule gets right. Short on purpose: every entry is
// a word that ordinary lyric writing actually uses, not a dictionary dump.
const EXCEPTIONS = new Map(Object.entries({
  fire: 2, hire: 2, wire: 2, tire: 2, dire: 2, hour: 2, our: 1, poem: 2, quiet: 2,
  science: 2, idea: 3, area: 3, being: 2, doing: 2, going: 2, seeing: 2, lying: 2,
  dying: 2, trying: 2, crying: 2, flying: 2, people: 2, every: 3, everything: 4,
  rhythm: 2, prism: 2, chasm: 2, business: 2, evening: 2, heaven: 2, seven: 2,
  given: 2, even: 2, oven: 2, queue: 1, beautiful: 3, favourite: 3, favorite: 3,
  chocolate: 3, comfortable: 4, different: 3, interest: 3, family: 3, camera: 3,
  memory: 3, history: 3, fourteen: 2, create: 2, created: 3, creating: 3,
  // Adjectival "-ed", where the ending sounds after a consonant no rule catches.
  crooked: 2, wicked: 2, naked: 2, blessed: 2, ragged: 2, jagged: 2, sacred: 2,
}));

// A trailing "e" is silent after a consonant ("time", "place"), except where
// "-le" carries its own syllable ("little") — there the e is the vowel.
const SILENT_E = /[^aeiou]e$/;
const LE_SYLLABLE = /[^aeioul]le$/;

// "-es"/"-ed" are silent after most consonants ("walked", "loved") but sound
// after sibilants and stops ("wishes", "boxes", "wanted"). h is in the keep
// set because "-shes" and "-ches" are syllables.
const ES_ED_SOUNDED = /(?:[cgszxjh]es|[dt]ed)$/;
const ES_ED_SILENT = /(?:es|ed)$/;

// Vowel runs count once ("beat"), except the pairs that genuinely split.
const VOWEL_GROUP = /[aeiouy]+/g;
const SPLIT_PAIRS = /ia|io|iu|eo|ua|uo|oa|yi|ae|ii|eu(?!r)/;

// "-ing" is its own syllable even when it fuses onto a preceding vowel run.
const ING = /[aeiouy]ing$/;

// "-ism"/"-asm"/"-thm" end on a syllabic consonant no vowel rule will find.
const SYLLABIC_CONSONANT = /(?:sm|thm)$/;

/**
 * Syllables in one word. Returns 0 for anything with no letters, so
 * punctuation and stray symbols do not inflate a line's count.
 */
function countSyllables(word) {
  const clean = String(word || '')
    .toLowerCase()
    .replace(/[^a-z']/g, '')
    .replace(/'/g, '');

  if (!clean) return 0;

  const known = EXCEPTIONS.get(clean);
  if (known !== undefined) return known;

  if (clean.length <= 2) return 1;

  let working = clean;
  let extra = 0;

  if (ING.test(working)) {
    // Count the stem, then add the "-ing" back as its own syllable.
    working = working.slice(0, -3);
    extra += 1;
  }

  if (SYLLABIC_CONSONANT.test(working)) extra += 1;

  if (LE_SYLLABLE.test(working)) {
    // Leave it: the "e" is this syllable's vowel and the group scan wants it.
  } else if (ES_ED_SOUNDED.test(working)) {
    // Leave it: the ending sounds, so its vowel group should be counted.
  } else if (ES_ED_SILENT.test(working)) {
    working = working.slice(0, -2);
  } else if (SILENT_E.test(working)) {
    working = working.slice(0, -1);
  }

  const groups = working.match(VOWEL_GROUP);
  if (!groups) return Math.max(1, extra);

  let count = groups.length + extra;

  // A two-vowel run is usually one sound ("beat"), but some pairs break into
  // two ("radio", "curious"). Add one back for each pair that does.
  for (const group of groups) {
    if (group.length >= 2 && SPLIT_PAIRS.test(group)) count += 1;
  }

  return Math.max(1, count);
}

/** Words of a line, with bracketed tags removed and melisma hyphens split. */
function lineWords(line) {
  return String(line || '')
    .replace(BRACKETED, ' ')
    .split(WORD_SPLIT)
    .filter(Boolean);
}

/** Syllables in a whole line. Bracketed tags contribute nothing. */
function countLineSyllables(line) {
  return lineWords(line).reduce((total, word) => total + countSyllables(word), 0);
}

/** True for "[Verse 1]" and friends — structure, not a sung line. */
function isSectionHeader(line) {
  const trimmed = String(line || '').trim();
  return trimmed.startsWith('[') && trimmed.endsWith(']');
}

/** The sung lines of a sheet, in order, with headers and blanks dropped. */
function lyricLines(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !isSectionHeader(line) && lineWords(line).length > 0);
}

/**
 * A word's rhyme tail: everything from its last stressed vowel group on.
 *
 * Approximated as "from the final vowel group", which is what end rhyme turns
 * on for the overwhelming majority of lyric line endings. This is the STRICT
 * key: it matches across spellings of the same sound ("seen"/"scene") but
 * requires the consonant tail to be identical, so "time" and "mine" do not
 * match here. For the looser match a writer actually hears, see slantKey.
 */
function rhymeKey(word) {
  const clean = String(word || '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');

  if (!clean) return '';

  // Drop a silent trailing e first, or it becomes the final vowel group and
  // every such word keys as "e": "score", "are" and "scene" would all rhyme
  // with each other and with nothing they actually rhyme with. Kept when the
  // stem has no vowel left ("me", "be"), where the e is the whole vowel.
  let stem = clean;
  if (SILENT_E.test(stem) && /[aeiouy]/.test(stem.slice(0, -1))) {
    stem = stem.slice(0, -1);
  }

  const groups = [...stem.matchAll(VOWEL_GROUP)];
  if (groups.length === 0) return stem;

  const last = groups[groups.length - 1];
  // Collapse the vowel run so "seen" and "scene" land on the same key.
  const vowel = last[0].replace(/(.)\1+/g, '$1');
  const tail = stem.slice(last.index + last[0].length);

  return vowel + tail;
}

// Consonants that substitute for each other in a slant rhyme, grouped by how
// they are articulated. A writer hears "time"/"mine" as a rhyme because m and
// n are both nasals; they hear "light"/"life" as a weaker one because t and f
// are not. Letters outside this map (w, y, h) are dropped: they do not close
// a syllable in a way that blocks a rhyme.
const CONSONANT_CLASS = {
  m: 'N', n: 'N', g: 'K', k: 'K', c: 'K', q: 'K',
  p: 'P', b: 'P', t: 'T', d: 'T',
  f: 'F', v: 'F', s: 'S', z: 'S', x: 'S', j: 'J',
  l: 'L', r: 'R',
};

/**
 * The looser rhyme key: same vowel, consonant tail reduced to its family.
 *
 * This is what makes slant rhyme detectable. "time"/"mine" share i+nasal;
 * "on"/"song" share o+nasal; "light"/"star" share nothing, because the vowel
 * has to match either way. Vowel identity is never relaxed — a rhyme whose
 * vowel differs is not a rhyme, it is alliteration.
 */
function slantKey(word) {
  const strict = rhymeKey(word);
  if (!strict) return '';

  const vowel = (strict.match(/^[aeiouy]+/) || [''])[0];
  if (!vowel) return strict;

  const tail = strict.slice(vowel.length);
  // "ng" and "th" are single sounds spelled with two letters.
  const classes = tail
    .replace(/ng/g, 'n')
    .replace(/th/g, 'T')
    .replace(/sh|ch/g, 'J')
    .split('')
    .map((letter) => CONSONANT_CLASS[letter] || (letter === letter.toUpperCase() ? letter : ''))
    .join('');

  return vowel + classes;
}

/** The rhyme key of a line, taken from its final word. */
function lineRhymeKey(line) {
  const words = lineWords(line);
  return words.length ? slantKey(words[words.length - 1]) : '';
}

/**
 * Labels each line A, B, C… by which lines it rhymes with, then names the
 * pattern if the whole passage repeats one of the common four-line shapes.
 *
 * Reported per four-line group because that is the unit a writer works in;
 * a sheet whose groups disagree is reported as "mixed" rather than averaged
 * into a shape none of it actually uses.
 */
function detectRhymeScheme(lines) {
  const keys = lines.map(lineRhymeKey);
  if (keys.length < 2) return { pattern: 'unknown', labels: [] };

  const labels = [];
  const assigned = new Map();
  for (const key of keys) {
    if (!key) {
      labels.push('-');
      continue;
    }
    if (!assigned.has(key)) {
      assigned.set(key, String.fromCharCode(65 + (assigned.size % 26)));
    }
    labels.push(assigned.get(key));
  }

  // Name the shape only when every full group of four agrees on it.
  const groups = [];
  for (let i = 0; i + 4 <= labels.length; i += 4) {
    groups.push(normalizeGroup(labels.slice(i, i + 4)));
  }

  if (groups.length === 0) return { pattern: 'unknown', labels };

  const [first] = groups;
  const uniform = groups.every((group) => group === first);
  return { pattern: uniform ? first : 'mixed', labels };
}

/** Relabels one group from A so "CCDD" and "AABB" read as the same shape. */
function normalizeGroup(group) {
  const map = new Map();
  return group
    .map((label) => {
      if (label === '-') return '-';
      if (!map.has(label)) map.set(label, String.fromCharCode(65 + map.size));
      return map.get(label);
    })
    .join('');
}

/**
 * How often rhyme lands inside a line rather than only at its end, as a ratio
 * of lines carrying at least one internal rhyme.
 *
 * A line counts when two of its words share a rhyme key. Identical repeated
 * words are excluded: repetition is a device, but it is not rhyme, and
 * counting it would score every refrain as maximally dense.
 */
function internalRhymeDensity(lines) {
  if (lines.length === 0) return 0;

  let hits = 0;
  for (const line of lines) {
    const words = lineWords(line).map((word) => word.toLowerCase().replace(/[^a-z]/g, ''));
    const seen = new Map();
    let found = false;

    for (const word of words) {
      if (word.length < 2) continue;
      const key = slantKey(word);
      if (!key) continue;

      const previous = seen.get(key);
      if (previous !== undefined && previous !== word) {
        found = true;
        break;
      }
      if (previous === undefined) seen.set(key, word);
    }

    if (found) hits += 1;
  }

  return Math.round((hits / lines.length) * 100) / 100;
}

// Enough distinct labels for any sheet a writer works on; past this the
// overlay is noise rather than information, so groups wrap.
const RHYME_LABELS = 'ABCDEFGH';

/**
 * Maps every line of a sheet to the rhyme group it lands in, for highlighting.
 *
 * Indexed against the raw sheet — headers and blank lines included — so a
 * client can walk `sheet.split('\n')` in lockstep and needs no parsing rules
 * of its own. Only groups with more than one member are labelled: a line that
 * rhymes with nothing is not part of a scheme, and colouring it would suggest
 * a pattern that is not there.
 */
function mapRhymes(text) {
  const rawLines = String(text || '').split('\n');

  // First pass: which sung lines exist, and what each one ends on.
  const sung = [];
  rawLines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line || isSectionHeader(line) || lineWords(line).length === 0) return;
    sung.push({ index, line, key: lineRhymeKey(line) });
  });

  // Only a key shared by two or more lines is a scheme.
  const counts = new Map();
  for (const entry of sung) {
    if (entry.key) counts.set(entry.key, (counts.get(entry.key) || 0) + 1);
  }

  const labels = new Map();
  for (const entry of sung) {
    if (!entry.key || counts.get(entry.key) < 2 || labels.has(entry.key)) continue;
    labels.set(entry.key, RHYME_LABELS[labels.size % RHYME_LABELS.length]);
  }

  const lines = sung.map((entry) => {
    const words = lineWords(entry.line);
    return {
      index: entry.index,
      group: entry.key ? labels.get(entry.key) || null : null,
      end_word: words.length ? words[words.length - 1] : '',
      internal: internalRhymeWords(entry.line),
    };
  });

  return { groups: [...new Set([...labels.values()])], lines };
}

/**
 * Words inside one line that rhyme with an earlier word in the same line.
 *
 * A repeated word is excluded: repetition is a device, but it is not rhyme,
 * and marking it would light up every refrain. Both halves of the pair are
 * returned, because an overlay that marks only the second one reads as an
 * error rather than a pair.
 */
function internalRhymeWords(line) {
  const words = lineWords(line);
  const byKey = new Map();
  const hits = new Set();

  for (const raw of words) {
    const word = raw.toLowerCase().replace(/[^a-z]/g, '');
    if (word.length < 2) continue;

    const key = slantKey(word);
    if (!key) continue;

    const seen = byKey.get(key);
    if (seen === undefined) {
      byKey.set(key, word);
    } else if (seen !== word) {
      hits.add(seen);
      hits.add(word);
    }
  }

  return [...hits];
}

/**
 * Structural mechanics of a lyric sheet or reference text.
 *
 * Returns nulls rather than zeros when there is nothing to measure, so a
 * caller can tell "no lines" apart from "lines averaging zero syllables".
 */
function analyzeProsody(text) {
  const lines = lyricLines(text);

  if (lines.length === 0) {
    return {
      line_count: 0,
      syllables_per_line: { avg: null, min: null, max: null },
      rhyme_scheme: 'unknown',
      internal_rhyme_density: 0,
    };
  }

  const counts = lines.map(countLineSyllables);
  const total = counts.reduce((sum, n) => sum + n, 0);

  return {
    line_count: lines.length,
    syllables_per_line: {
      avg: Math.round((total / counts.length) * 10) / 10,
      min: Math.min(...counts),
      max: Math.max(...counts),
    },
    rhyme_scheme: detectRhymeScheme(lines).pattern,
    internal_rhyme_density: internalRhymeDensity(lines),
  };
}

// A syllable lands on roughly an eighth note at a conversational delivery, so
// a 4/4 bar holds about eight before the flow reads as double-time. Used only
// to place lines on bars, never to reject them.
const SYLLABLES_PER_BAR = 8;
const BEATS_PER_BAR = 4;

/**
 * Places each sung line on a bar, so a sheet can be annotated for recording.
 *
 * Bars are estimated from syllable count, not from audio: this says "at this
 * density, this line occupies about this much of a bar", which is what a
 * writer needs to see before tracking. `seconds` is derived from `bpm` when
 * one is supplied, so a 4-bar section reads as a real duration.
 */
function buildBarGrid(text, { bpm, syllablesPerBar = SYLLABLES_PER_BAR } = {}) {
  const lines = lyricLines(text);
  const tempo = Number.isFinite(bpm) && bpm > 0 ? bpm : null;
  const secondsPerBar = tempo ? (BEATS_PER_BAR * 60) / tempo : null;

  let cursor = 0;
  const rows = lines.map((line) => {
    const syllables = countLineSyllables(line);
    // Every sung line occupies at least one bar; a dense line spills into more.
    const bars = Math.max(1, Math.ceil(syllables / syllablesPerBar));
    const startBar = cursor + 1;
    cursor += bars;

    return {
      line,
      syllables,
      bars,
      start_bar: startBar,
      end_bar: cursor,
      start_seconds: secondsPerBar ? Math.round((startBar - 1) * secondsPerBar * 100) / 100 : null,
    };
  });

  return {
    bpm: tempo,
    beats_per_bar: BEATS_PER_BAR,
    syllables_per_bar: syllablesPerBar,
    total_bars: cursor,
    rows,
  };
}

module.exports = {
  countSyllables,
  countLineSyllables,
  lyricLines,
  isSectionHeader,
  rhymeKey,
  slantKey,
  detectRhymeScheme,
  internalRhymeDensity,
  analyzeProsody,
  buildBarGrid,
  mapRhymes,
  internalRhymeWords,
  RHYME_LABELS,
  SYLLABLES_PER_BAR,
  BEATS_PER_BAR,
};
