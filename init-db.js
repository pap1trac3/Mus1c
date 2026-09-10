require('dotenv').config({ quiet: true });
const { DataAPIClient } = require('@datastax/astra-db-ts');

const COLLECTION_NAME = 'lyric_vault';

async function initDb() {
  const endpoint = process.env.ASTRA_DB_API_ENDPOINT;
  const token = process.env.ASTRA_DB_APPLICATION_TOKEN;
  const keyspace = process.env.ASTRA_DB_KEYSPACE;

  if (!endpoint || !token) {
    console.error(
      'Missing required environment variables: ASTRA_DB_API_ENDPOINT and ASTRA_DB_APPLICATION_TOKEN must be set.'
    );
    process.exit(1);
  }

  const client = new DataAPIClient(token);
  const db = client.db(endpoint, keyspace ? { keyspace } : undefined);

  try {
    await db.createCollection(COLLECTION_NAME, {
      vector: {
        dimension: 1536,
        metric: 'cosine',
        sourceModel: 'openai-v3-small',
      },
    });
    console.log(`Collection "${COLLECTION_NAME}" created successfully.`);
  } catch (err) {
    const alreadyExists =
      err?.errorDescriptors?.some((d) => d.errorCode === 'EXISTING_COLLECTION_DIFFERENT_SETTINGS' || d.errorCode === 'COLLECTION_ALREADY_EXISTS') ||
      /already exists/i.test(err?.message || '');

    if (alreadyExists) {
      console.log(`Collection "${COLLECTION_NAME}" already exists. Skipping creation.`);
    } else {
      console.error('Failed to initialize Astra DB collection:', err?.message || err);
      process.exit(1);
    }
  }
}

initDb();
