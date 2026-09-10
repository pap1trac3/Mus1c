/**
 * Repository layer for the "lyric_vault" Astra DB collection.
 * Isolates route handlers from the vector-DB SDK surface (insertMany/find/sort shape),
 * so a schema or SDK change only touches this file.
 */
class VaultRepository {
  constructor(collection) {
    this.collection = collection;
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
}

module.exports = { VaultRepository };
