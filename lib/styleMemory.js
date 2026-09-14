const crypto = require('crypto');

/**
 * Style memory: what the vault keeps from an analyzed reel so that later
 * generations are shaped by it, instead of the analysis being thrown away
 * the moment the response is sent.
 *
 * What is kept is deliberately narrow. The reel's transcript is someone
 * else's work and is never written anywhere — what gets stored is the
 * *derived* style (feel, cadence, metaphor domains) plus the original lyrics
 * this service wrote itself. Both are our own output, and both are what a
 * later generation actually needs in order to sound like the reference.
 */

/** Marks a vault document as a learned style profile rather than an ingested lyric chunk. */
const STYLE_PROFILE_KIND = 'style_profile';

/** What everything ingested through /api/ingest is, when it says nothing. */
const LYRIC_KIND = 'lyrics';

// A profile competes with real lyric chunks for the retrieval budget, so its
// text is capped: one wordy reel must not crowd the rest of the vault out of
// the top-K on every subsequent generation.
const MAX_PROFILE_LYRIC_CHARS = 1200;
const MAX_SOURCE_NAME_CHARS = 120;
const MAX_TOPIC_CHARS = 300;
const MAX_DEVICES = 6;
const MAX_TITLE_CHARS = 120;

// User-authored labels ("Aggressive", "R&B Hook") used to narrow which learned
// profiles a generation may draw on. Bounded so one request cannot write an
// unbounded array into a document that every retrieval then reads back.
const MAX_TAGS = 12;
const MAX_TAG_CHARS = 40;

/** Largest count /api/style-memory will total up before reporting "at least N". */
const COUNT_UPPER_BOUND = 1000;

/** Non-vector sorts are capped server-side (20 documents at the time of writing). */
const MAX_PROFILE_PAGE = 20;

function clean(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/**
 * Canonical form for a tag list, applied on the way in *and* on the way out.
 *
 * Matching is exact server-side, so "Aggressive" and "aggressive" would
 * otherwise be two different tags that look identical in the UI. Lowercasing
 * here makes a filter match regardless of how the tag was typed, and the
 * dedupe keeps a paste of "hook, hook" from bloating the stored array.
 */
function normalizeTags(value) {
  if (!Array.isArray(value)) return [];

  const seen = new Set();
  for (const entry of value) {
    const tag = clean(entry, MAX_TAG_CHARS).toLowerCase();
    if (tag) seen.add(tag);
    if (seen.size >= MAX_TAGS) break;
  }
  return [...seen];
}

/**
 * The text that is embedded and later retrieved. Written to read as a usable
 * instruction on its own, because that is exactly how it reaches the model:
 * dropped into the reference-context block of a generation prompt.
 */
function buildProfileText({ style_dna: styleDna = {}, topic = '', lyrics = '', source = 'reel', title = '' }) {
  const domains = Array.isArray(styleDna.metaphor_domains) ? styleDna.metaphor_domains : [];
  const devices = Array.isArray(styleDna.literary_devices) ? styleDna.literary_devices : [];
  const cleanTopic = clean(topic, MAX_TOPIC_CHARS);
  const cleanTitle = clean(title, MAX_TITLE_CHARS);

  const lines = [
    source === 'text'
      ? `Style profile learned from reference text${cleanTitle ? ` ("${cleanTitle}")` : ''}.`
      : 'Style profile learned from a reference reel.',
    `Feel: ${clean(styleDna.feel, 200) || 'Unknown'}`,
    `Cadence: ${clean(styleDna.cadence, 300) || 'Unknown'}`,
    `Metaphor domains: ${domains.length ? domains.join(', ') : 'none identified'}`,
  ];

  // Only written when present, so a reel profile's text is unchanged.
  if (devices.length) lines.push(`Literary devices: ${devices.join(', ')}`);

  const body = clean(lyrics, MAX_PROFILE_LYRIC_CHARS);
  if (body) {
    lines.push(
      '',
      cleanTopic
        ? `Original lyrics previously written in this style, on the topic "${cleanTopic}":`
        : 'Original lyrics previously written in this style:',
      body
    );
  }

  return lines.join('\n');
}

/** Numeric or null — never NaN, and never a string that reached a metric field. */
function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Canonical prosody block. Applied on write and on read, so a profile learned
 * before these metrics existed reads back with the same shape as a new one
 * rather than as undefined at every call site that renders it.
 */
function normalizeProsody(value) {
  const source = value && typeof value === 'object' ? value : {};
  const perLine = source.syllables_per_line && typeof source.syllables_per_line === 'object'
    ? source.syllables_per_line
    : {};

  return {
    line_count: finiteOrNull(source.line_count) ?? 0,
    syllables_per_line: {
      avg: finiteOrNull(perLine.avg),
      min: finiteOrNull(perLine.min),
      max: finiteOrNull(perLine.max),
    },
    rhyme_scheme: typeof source.rhyme_scheme === 'string' ? source.rhyme_scheme : 'unknown',
    internal_rhyme_density: finiteOrNull(source.internal_rhyme_density) ?? 0,
  };
}

/**
 * Builds the vault document for a learned profile.
 *
 * The text lives under `text`, not `transcript`: every `transcript` field in
 * the vault came from a caller's own /api/ingest payload, and keeping reel-
 * derived text out of that field means the "no reel transcript is ever
 * persisted" rule stays true by construction rather than by convention.
 */
function buildProfileDocument({
  vector, style_dna: styleDna = {}, topic, lyrics, sourceName, learnedAt, documentId,
  source = 'reel', title = '', prosody,
}) {
  const domains = Array.isArray(styleDna.metaphor_domains) ? styleDna.metaphor_domains : [];
  const devices = (Array.isArray(styleDna.literary_devices) ? styleDna.literary_devices : [])
    .map((device) => clean(device, 60))
    .filter(Boolean)
    .slice(0, MAX_DEVICES);

  // Pasted text and reels share this shape deliberately. A document with its
  // fields at the top level and no `text`/`metadata` would still be returned
  // by vector search, contribute an empty string to the generation context,
  // and be invisible to findProfiles and undeletable by deleteProfile.
  return {
    $vector: vector,
    text: buildProfileText({ style_dna: styleDna, topic, lyrics, source, title }),
    metadata: {
      kind: STYLE_PROFILE_KIND,
      document_id: documentId || crypto.randomUUID(),
      source,
      source_name:
        clean(sourceName, MAX_SOURCE_NAME_CHARS) ||
        (source === 'text' ? clean(title, MAX_TITLE_CHARS) || 'pasted text' : 'reel clip'),
      topic: clean(topic, MAX_TOPIC_CHARS),
      feel: clean(styleDna.feel, 200) || 'Unknown',
      cadence: clean(styleDna.cadence, 300) || 'Unknown',
      metaphor_domains: domains,
      literary_devices: devices,
      // Measured, not model-reported: a generation is told to match these
      // numbers, so they have to be countable rather than guessed.
      prosody: normalizeProsody(prosody),
      learned_at: learnedAt || new Date().toISOString(),
      // Single-chunk document, but carrying these keeps it groupable by the
      // same code path as an ingested transcript.
      chunk_index: 0,
      total_chunks: 1,
    },
  };
}

/**
 * Composes one style brief from up to two named profiles, field by field.
 *
 * Not vector interpolation. Cadence, metaphor domains and feel are separate
 * text fields in the prompt, so "60% of A and 40% of B" has no meaning for
 * them — averaging two embeddings would land between the two styles rather
 * than combining them, and would lose the fields entirely. What a writer
 * actually wants is whole fields from each source: this rhythm, that imagery.
 *
 * Either side may be omitted; with neither, there is no blend and the caller
 * falls back to ordinary retrieval.
 */
function composeStyleBrief({ cadenceProfile, imageryProfile }) {
  if (!cadenceProfile && !imageryProfile) return null;

  const cadenceMeta = cadenceProfile?.metadata || {};
  const imageryMeta = imageryProfile?.metadata || {};

  // Each side falls back to the other, so naming one profile still produces a
  // complete brief rather than a half-empty one.
  const rhythmFrom = cadenceProfile ? cadenceMeta : imageryMeta;
  const imageryFrom = imageryProfile ? imageryMeta : cadenceMeta;

  const domains = Array.isArray(imageryFrom.metaphor_domains) ? imageryFrom.metaphor_domains : [];
  const devices = Array.isArray(rhythmFrom.literary_devices) ? rhythmFrom.literary_devices : [];

  return {
    cadence_source: cadenceProfile ? cadenceMeta.document_id : null,
    imagery_source: imageryProfile ? imageryMeta.document_id : null,
    cadence: clean(rhythmFrom.cadence, 300) || 'Unknown',
    feel: clean(imageryFrom.feel, 200) || 'Unknown',
    metaphor_domains: domains,
    literary_devices: devices,
    prosody: normalizeProsody(rhythmFrom.prosody),
  };
}

/** The brief as prompt text, labelled so the model knows what came from where. */
function describeStyleBrief(brief) {
  if (!brief) return '';

  const lines = [
    'Blended style brief (the user chose these explicitly — follow it over anything retrieved below):',
    `- Cadence and rhythm${brief.cadence_source ? ' (from the cadence profile)' : ''}: ${brief.cadence}`,
    `- Feel and vibe${brief.imagery_source ? ' (from the imagery profile)' : ''}: ${brief.feel}`,
  ];

  if (brief.metaphor_domains.length) {
    lines.push(`- Draw imagery from these domains only: ${brief.metaphor_domains.join(', ')}`);
  }
  if (brief.literary_devices.length) {
    lines.push(`- Techniques to use: ${brief.literary_devices.join(', ')}`);
  }

  return lines.join('\n');
}

/** The public shape of a profile: metadata only, never the stored text blob. */
function toProfileSummary(doc) {
  const metadata = doc?.metadata || {};
  return {
    id: metadata.document_id || doc?._id || null,
    feel: metadata.feel || 'Unknown',
    cadence: metadata.cadence || 'Unknown',
    metaphor_domains: Array.isArray(metadata.metaphor_domains) ? metadata.metaphor_domains : [],
    literary_devices: Array.isArray(metadata.literary_devices) ? metadata.literary_devices : [],
    // Absent on every profile learned before tagging shipped, and on any
    // profile nobody has tagged yet — both read back as "no tags".
    tags: normalizeTags(metadata.tags),
    prosody: normalizeProsody(metadata.prosody),
    source: metadata.source || 'reel',
    topic: metadata.topic || '',
    source_name: metadata.source_name || 'reel clip',
    learned_at: metadata.learned_at || null,
  };
}

module.exports = {
  STYLE_PROFILE_KIND,
  LYRIC_KIND,
  COUNT_UPPER_BOUND,
  MAX_PROFILE_PAGE,
  MAX_PROFILE_LYRIC_CHARS,
  MAX_DEVICES,
  MAX_TITLE_CHARS,
  MAX_TAGS,
  MAX_TAG_CHARS,
  buildProfileText,
  buildProfileDocument,
  toProfileSummary,
  normalizeTags,
  normalizeProsody,
  composeStyleBrief,
  describeStyleBrief,
};
