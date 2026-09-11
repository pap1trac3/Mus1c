// server.js validates required env vars and constructs the OpenAI/Astra
// clients at import time, so these must be set before the first require.
process.env.OPENAI_API_KEY = 'test-key';
process.env.ASTRA_DB_API_ENDPOINT = 'https://example.apps.astra.datastax.com';
process.env.ASTRA_DB_APPLICATION_TOKEN = 'AstraCS:test-token';

const { chunkText, groupRetrievedChunks } = require('../../server');

describe('Unit Tests - Helper Functions', () => {
  describe('chunkText()', () => {
    it('slides a character-based window with the given size and overlap', () => {
      const text = 'a'.repeat(2500);
      const chunks = chunkText(text, 1000, 200);

      expect(chunks).toHaveLength(3);
      expect(chunks[0]).toHaveLength(1000);
      expect(chunks[1]).toHaveLength(1000);
      expect(chunks[2]).toHaveLength(900);
      // step = chunkSize - overlap = 800, so chunk 1 starts at char 800
      expect(chunks[1]).toBe(text.slice(800, 1800));
    });

    it('returns a single chunk when the text is under chunkSize', () => {
      const chunks = chunkText('hello world', 1000, 200);
      expect(chunks).toEqual(['hello world']);
    });

    it('returns an empty array for empty or whitespace-only input', () => {
      expect(chunkText('')).toEqual([]);
      expect(chunkText('   ')).toEqual([]);
      expect(chunkText(undefined)).toEqual([]);
    });

    it('falls back to a non-overlapping step when overlap >= chunkSize (no infinite loop)', () => {
      const text = 'a'.repeat(30);
      const chunks = chunkText(text, 10, 20);

      expect(chunks).toHaveLength(3);
      expect(chunks.every((c) => c.length === 10)).toBe(true);
    });
  });

  describe('groupRetrievedChunks()', () => {
    it('dedupes by document_id and orders each group by chunk_index', () => {
      const rawResults = [
        { metadata: { document_id: 'docA', chunk_index: 2 }, transcript: 'Chunk A2' },
        { metadata: { document_id: 'docB', chunk_index: 0 }, transcript: 'Chunk B0' },
        { metadata: { document_id: 'docA', chunk_index: 0 }, transcript: 'Chunk A0' },
        { metadata: { document_id: 'docA', chunk_index: 1 }, transcript: 'Chunk A1' },
      ];

      const sections = groupRetrievedChunks(rawResults);

      expect(sections.map((s) => s.document_id)).toEqual(['docA', 'docB']);
      expect(sections[0].text).toBe('Chunk A0 Chunk A1 Chunk A2');
      expect(sections[1].text).toBe('Chunk B0');
    });

    it('falls back to metadata.source, then _id, when document_id is absent', () => {
      const rawResults = [
        { metadata: { source: 'src-1', chunk_index: 0 }, transcript: 'From source' },
        { metadata: {}, transcript: 'From doc id', _id: 'doc-9' },
      ];

      const sections = groupRetrievedChunks(rawResults);

      expect(sections).toEqual([
        { document_id: 'src-1', text: 'From source', kind: 'lyrics' },
        { document_id: 'doc-9', text: 'From doc id', kind: 'lyrics' },
      ]);
    });

    it('returns an empty array for no input', () => {
      expect(groupRetrievedChunks([])).toEqual([]);
    });

    it('reads a learned style profile, which stores its text under `text`', () => {
      const sections = groupRetrievedChunks([
        {
          metadata: { document_id: 'profile-1', kind: 'style_profile' },
          text: 'Style profile learned from a reference reel.',
        },
      ]);

      expect(sections).toEqual([
        {
          document_id: 'profile-1',
          text: 'Style profile learned from a reference reel.',
          kind: 'style_profile',
        },
      ]);
    });

    it('keeps profiles and ingested chunks as separate sections', () => {
      const sections = groupRetrievedChunks([
        { metadata: { document_id: 'profile-1', kind: 'style_profile' }, text: 'Profile text' },
        { metadata: { document_id: 'docA', chunk_index: 0 }, transcript: 'Lyric text' },
      ]);

      expect(sections.map((s) => s.kind)).toEqual(['style_profile', 'lyrics']);
    });
  });
});
