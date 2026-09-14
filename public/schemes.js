'use strict';

/**
 * Saved rhyme/meter templates — "write me AABB at twelve syllables" as a thing
 * you keep rather than retype.
 *
 * Backed by localStorage for the same reasons as the draft history: a preset is
 * a personal writing habit, not shared data, and putting it in `lyric_vault`
 * would feed it back into retrieval as if it were a lyric. Every accessor sits
 * behind this one object so swapping in a server-backed store later touches
 * nothing else, and every call is guarded because localStorage throws outright
 * in some privacy modes rather than returning null.
 */

const SCHEMES_KEY = 'mozart.schemes.v1';

// A writer keeps a handful of templates, not a library. Bounded so the store
// cannot crowd the draft history out of the shared origin budget.
const MAX_SCHEMES = 24;

/**
 * Starter templates. These are not stored — they are always offered, cannot be
 * deleted, and a saved preset with the same name sits alongside them rather
 * than replacing them.
 */
const BUILT_IN_SCHEMES = [
  {
    id: 'builtin:aabb',
    name: 'AABB couplets',
    builtin: true,
    scheme: { rhyme_scheme: 'AABB', internal_rhyme_density: 0.2 },
  },
  {
    id: 'builtin:abab',
    name: 'ABAB alternating',
    builtin: true,
    scheme: { rhyme_scheme: 'ABAB', internal_rhyme_density: 0.2 },
  },
  {
    id: 'builtin:dense-internal',
    name: 'Dense internal rhyme',
    builtin: true,
    scheme: {
      internal_rhyme_density: 0.8,
      syllables_avg: 14,
      syllables_min: 11,
      syllables_max: 18,
    },
  },
];

// Mirrors the bounds in lib/validation.js. Clamping here keeps a preset that
// predates a bounds change from being rejected on every generation; the server
// still validates, this only stops the UI sending something it knows is bad.
const SYLLABLE_MIN = 1;
const SYLLABLE_MAX = 40;
const MAX_SCHEME_CHARS = 16;
const MAX_NAME_CHARS = 60;

function clampInt(value, low, high) {
  // Blank is "not pinned". Number('') is 0, which would clamp to the floor and
  // silently demand one-syllable lines from an empty box.
  if (value === '' || value === null || value === undefined) return undefined;
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return undefined;
  return Math.min(high, Math.max(low, number));
}

/**
 * Cleans a raw form reading into the `scheme` payload the API accepts, or null
 * when the writer pinned nothing.
 *
 * Blank is "not pinned", never zero: an empty syllable box must leave the
 * reference style's own average alone rather than demand one-syllable lines.
 */
function normalizeScheme(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const scheme = {};

  const label = String(raw.rhyme_scheme ?? '').trim().toUpperCase().slice(0, MAX_SCHEME_CHARS);
  if (label) scheme.rhyme_scheme = label;

  const avg = clampInt(raw.syllables_avg, SYLLABLE_MIN, SYLLABLE_MAX);
  if (avg !== undefined) scheme.syllables_avg = avg;

  let min = clampInt(raw.syllables_min, SYLLABLE_MIN, SYLLABLE_MAX);
  let max = clampInt(raw.syllables_max, SYLLABLE_MIN, SYLLABLE_MAX);
  // A backwards range is a slip, not an instruction: the server rejects it, so
  // read it the way it was plainly meant instead of failing the generation.
  if (min !== undefined && max !== undefined && min > max) [min, max] = [max, min];
  if (min !== undefined) scheme.syllables_min = min;
  if (max !== undefined) scheme.syllables_max = max;

  const density = Number(raw.internal_rhyme_density);
  if (raw.internal_rhyme_density !== '' && raw.internal_rhyme_density != null && Number.isFinite(density)) {
    scheme.internal_rhyme_density = Math.min(1, Math.max(0, density));
  }

  return Object.keys(scheme).length > 0 ? scheme : null;
}

/** A one-line description of what a preset pins, for the picker and the panel. */
function describeScheme(scheme) {
  if (!scheme) return 'pins nothing';

  const parts = [];
  if (scheme.rhyme_scheme) parts.push(scheme.rhyme_scheme);

  const { syllables_avg: avg, syllables_min: min, syllables_max: max } = scheme;
  if (typeof avg === 'number' && typeof min === 'number' && typeof max === 'number') {
    parts.push(`${avg} syll. (${min}–${max})`);
  } else if (typeof avg === 'number') {
    parts.push(`${avg} syll.`);
  } else if (typeof min === 'number' && typeof max === 'number') {
    parts.push(`${min}–${max} syll.`);
  } else if (typeof min === 'number') {
    parts.push(`${min}+ syll.`);
  } else if (typeof max === 'number') {
    parts.push(`up to ${max} syll.`);
  }

  if (typeof scheme.internal_rhyme_density === 'number') {
    parts.push(scheme.internal_rhyme_density >= 0.5 ? 'dense internal' : 'sparse internal');
  }

  return parts.length > 0 ? parts.join(' · ') : 'pins nothing';
}

const schemeStore = {
  /** Saved presets, newest first. Returns [] rather than throwing, ever. */
  list() {
    try {
      const raw = localStorage.getItem(SCHEMES_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      return [];
    }
  },

  /** The built-ins plus everything saved — what the picker offers. */
  all() {
    return [...BUILT_IN_SCHEMES, ...schemeStore.list()];
  },

  find(id) {
    return schemeStore.all().find((preset) => preset.id === id) || null;
  },

  /**
   * Saves a preset under `name`, replacing a saved one of the same name so
   * re-saving a template the writer is tuning does not leave two entries that
   * differ by one field. Returns the new list, or null if nothing was pinned.
   */
  save(name, raw) {
    const scheme = normalizeScheme(raw);
    if (!scheme) return null;

    const label = String(name || '').trim().slice(0, MAX_NAME_CHARS) || 'Untitled scheme';
    const kept = schemeStore
      .list()
      .filter((preset) => preset.name.toLowerCase() !== label.toLowerCase());

    const preset = {
      id: `scheme-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: label,
      saved_at: new Date().toISOString(),
      scheme,
    };

    const next = [preset, ...kept].slice(0, MAX_SCHEMES);
    schemeStore.write(next);
    return next;
  },

  /** Built-ins are not stored, so removing one is a no-op rather than an error. */
  remove(id) {
    const next = schemeStore.list().filter((preset) => preset.id !== id);
    schemeStore.write(next);
    return next;
  },

  clear() {
    schemeStore.write([]);
    return [];
  },

  /**
   * Writes the list, shedding the oldest presets if the browser rejects it for
   * quota — the same policy the draft history uses.
   */
  write(presets) {
    let candidate = presets;

    while (candidate.length > 0) {
      try {
        localStorage.setItem(SCHEMES_KEY, JSON.stringify(candidate));
        return true;
      } catch (err) {
        candidate = candidate.slice(0, candidate.length - 1);
      }
    }

    try {
      localStorage.removeItem(SCHEMES_KEY);
    } catch (err) {
      /* storage refused entirely — nothing to clean up */
    }
    return false;
  },
};

if (typeof window !== 'undefined') {
  window.schemeStore = schemeStore;
  window.normalizeScheme = normalizeScheme;
  window.describeScheme = describeScheme;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    schemeStore,
    normalizeScheme,
    describeScheme,
    SCHEMES_KEY,
    MAX_SCHEMES,
    BUILT_IN_SCHEMES,
  };
}
