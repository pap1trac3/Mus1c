const { STYLE_PROFILE_KIND } = require('./styleMemory');

/**
 * Repository layer for the "lyric_vault" Astra DB collection.
 * Isolates route handlers from the vector-DB SDK surface (insertMany/find/sort shape),
 * so a schema or SDK change only touches this file.
 */
class VaultRepository {
  constructor(collection) {
    this.collection = collection;
  }

  /**
   * Cheapest call that proves reachability, auth, and that the collection
   * exists: it reads collection metadata rather than any documents.
   */
  async ping() {
    return this.collection.options();
  }

  async insertChunks(documents) {
    return this.collection.insertMany(documents);
  }

  async findSimilar(vector, { limit, includeSimilarity = true } = {}) {
    const cursor = this.collection.find(
      {},
      { sort: { $vector: vector }, limit, includeSimilarity }
    );
    return cursor.toArray();
  }

  /**
   * Learned reel style profiles, newest first.
   *
   * `learned_at` is stored as an ISO-8601 string, so a plain descending sort
   * is also chronological. The Data API caps a non-vector sort at 20 documents,
   * which is why callers page rather than asking for everything.
   * The vector is projected out: 1536 floats per row, none of them wanted here.
   */
  async findProfiles({ limit = 10 } = {}) {
    const cursor = this.collection.find(
      { 'metadata.kind': STYLE_PROFILE_KIND },
      {
        sort: { 'metadata.learned_at': -1 },
        limit,
        projection: { $vector: 0 },
      }
    );
    return cursor.toArray();
  }

  /**
   * Counts learned profiles. Throws when the total exceeds `upperBound` —
   * the Data API refuses to count without a ceiling, so the caller decides
   * what "too many to bother counting" means.
   */
  async countProfiles(upperBound) {
    return this.collection.countDocuments({ 'metadata.kind': STYLE_PROFILE_KIND }, upperBound);
  }

  /**
   * Forgets one learned profile. Scoped to the profile kind so a document_id
   * collision can never delete ingested lyric chunks.
   */
  async deleteProfile(documentId) {
    return this.collection.deleteMany({
      'metadata.document_id': documentId,
      'metadata.kind': STYLE_PROFILE_KIND,
    });
  }
}

module.exports = { VaultRepository };
