const { VaultRepository } = require('../../lib/vaultRepository');
const { STYLE_PROFILE_KIND } = require('../../lib/styleMemory');

/**
 * These assert the exact query handed to the Data API. The Data API is not
 * reachable from the test suite, so the filter shape is what is pinned: a
 * refactor that widened the tag filter to reach ingested chunks, or dropped
 * the kind scoping from a write, would fail here rather than in production.
 */
function mockCollection(rows = []) {
  const find = jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue(rows) });
  const updateOne = jest.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
  return { find, updateOne };
}

const VECTOR = [0.1, 0.2];

describe('findSimilarProfilesByTags()', () => {
  it('matches a profile carrying any of the requested tags', async () => {
    const collection = mockCollection();
    await new VaultRepository(collection).findSimilarProfilesByTags(VECTOR, {
      tags: ['aggressive', 'melodic'],
      limit: 5,
    });

    expect(collection.find).toHaveBeenCalledWith(
      {
        'metadata.kind': STYLE_PROFILE_KIND,
        'metadata.tags': { $in: ['aggressive', 'melodic'] },
      },
      expect.objectContaining({ sort: { $vector: VECTOR }, limit: 5 })
    );
  });

  it('scopes to profiles, so the filter can never return an ingested chunk', async () => {
    const collection = mockCollection();
    await new VaultRepository(collection).findSimilarProfilesByTags(VECTOR, {
      tags: ['aggressive'],
      limit: 3,
    });

    expect(collection.find.mock.calls[0][0]['metadata.kind']).toBe(STYLE_PROFILE_KIND);
  });

  it('asks for similarity scores, since the caller merges on them', async () => {
    const collection = mockCollection();
    await new VaultRepository(collection).findSimilarProfilesByTags(VECTOR, {
      tags: ['aggressive'],
      limit: 3,
    });

    expect(collection.find.mock.calls[0][1].includeSimilarity).toBe(true);
  });

  it('projects the vector out: 1536 floats per row that nothing here reads', async () => {
    const collection = mockCollection();
    await new VaultRepository(collection).findSimilarProfilesByTags(VECTOR, {
      tags: ['aggressive'],
      limit: 3,
    });

    expect(collection.find.mock.calls[0][1].projection).toEqual({ $vector: 0 });
  });
});

describe('updateProfileTags()', () => {
  it('writes the tags onto the profile with that document id', async () => {
    const collection = mockCollection();
    await new VaultRepository(collection).updateProfileTags('prof-1', ['aggressive']);

    expect(collection.updateOne).toHaveBeenCalledWith(
      { 'metadata.document_id': 'prof-1', 'metadata.kind': STYLE_PROFILE_KIND },
      { $set: { 'metadata.tags': ['aggressive'] } }
    );
  });

  it('is scoped by kind, so a document_id collision cannot tag a lyric chunk', async () => {
    const collection = mockCollection();
    await new VaultRepository(collection).updateProfileTags('prof-1', []);

    expect(collection.updateOne.mock.calls[0][0]['metadata.kind']).toBe(STYLE_PROFILE_KIND);
  });
});
