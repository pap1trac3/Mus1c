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

/** Largest count /api/style-memory will total up before reporting "at least N". */
const COUNT_UPPER_BOUND = 1000;

/** Non-vector sorts are capped server-side (20 documents at the time of writing). */
const MAX_PROFILE_PAGE = 20;

function clean(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
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
  source = 'reel', title = '',
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
      learned_at: learnedAt || new Date().toISOString(),
      // Single-chunk document, but carrying these keeps it groupable by the
      // same code path as an ingested transcript.
      chunk_index: 0,
      total_chunks: 1,
    },
  };
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
  buildProfileText,
  buildProfileDocument,
  toProfileSummary,
};
