'use strict';

/**
 * Draft history for generated lyric sheets.
 *
 * Backed by localStorage: per-browser, private, no infrastructure and no cost.
 * The alternative — an Astra collection — would be shared across devices, but
 * it cannot live in `lyric_vault`: that is a vector collection every
 * generation searches, so drafts stored there would be returned by retrieval
 * and fed back into later generations as context. It would need its own
 * collection, its own CRUD routes and its own retention policy.
 *
 * Every accessor is behind this one object so that swap stays small: replace
 * the four methods with fetch calls and nothing else in the app changes.
 * Every call is guarded, because localStorage throws outright in some privacy
 * modes rather than returning null — a browser that refuses storage loses the
 * history, not the page.
 */

const DRAFTS_KEY = 'mozart.drafts.v1';

// Sheets are a few KB each and localStorage is a ~5MB per-origin budget shared
// with everything else this page keeps. Old drafts fall off the end.
const MAX_DRAFTS = 30;

const draftStore = {
  /** Every draft, newest first. Returns [] rather than throwing, ever. */
  list() {
    try {
      const raw = localStorage.getItem(DRAFTS_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      return [];
    }
  },

  /**
   * Saves a draft and returns the new list.
   *
   * Identical consecutive sheets are not stored twice: a section rewrite that
   * the model returned unchanged, or a double-click, should not push a
   * genuinely different draft off the end of the history.
   */
  save(draft) {
    const drafts = draftStore.list();
    if (drafts.length > 0 && drafts[0].structured_lyrics === draft.structured_lyrics) {
      return drafts;
    }

    const next = [draft, ...drafts].slice(0, MAX_DRAFTS);
    draftStore.write(next);
    return next;
  },

  remove(id) {
    const next = draftStore.list().filter((draft) => draft.id !== id);
    draftStore.write(next);
    return next;
  },

  clear() {
    draftStore.write([]);
    return [];
  },

  /**
   * Writes the list, shedding the oldest drafts if the browser rejects it for
   * quota. A history that silently stops saving is worse than a shorter one.
   */
  write(drafts) {
    let candidate = drafts;

    while (candidate.length > 0) {
      try {
        localStorage.setItem(DRAFTS_KEY, JSON.stringify(candidate));
        return true;
      } catch (err) {
        candidate = candidate.slice(0, candidate.length - 1);
      }
    }

    try {
      localStorage.removeItem(DRAFTS_KEY);
    } catch (err) {
      /* storage refused entirely — nothing to clean up */
    }
    return false;
  },
};

/**
 * Line-level difference between two sheets.
 *
 * A standard LCS, so lines that merely moved are not reported as rewritten:
 * the point of the view is "what actually changed in this verse", and a naive
 * index-by-index comparison marks everything after an inserted line as
 * changed, which is exactly the noise that makes a diff useless.
 */
function diffLines(before, after) {
  const a = String(before || '').split('\n');
  const b = String(after || '').split('\n');

  // lengths[i][j] = LCS length of a[i..] and b[j..]
  const lengths = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i][j] = a[i] === b[j]
        ? lengths[i + 1][j + 1] + 1
        : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }

  const rows = [];
  let i = 0;
  let j = 0;

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({ type: 'same', text: a[i] });
      i++;
      j++;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      rows.push({ type: 'removed', text: a[i] });
      i++;
    } else {
      rows.push({ type: 'added', text: b[j] });
      j++;
    }
  }
  while (i < a.length) rows.push({ type: 'removed', text: a[i++] });
  while (j < b.length) rows.push({ type: 'added', text: b[j++] });

  return rows;
}

/** Counts of what changed, for a one-line summary above the diff. */
function summarizeDiff(rows) {
  return {
    added: rows.filter((row) => row.type === 'added').length,
    removed: rows.filter((row) => row.type === 'removed').length,
    unchanged: rows.filter((row) => row.type === 'same').length,
  };
}

if (typeof window !== 'undefined') {
  window.draftStore = draftStore;
  window.diffLines = diffLines;
  window.summarizeDiff = summarizeDiff;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { draftStore, diffLines, summarizeDiff, DRAFTS_KEY, MAX_DRAFTS };
}
