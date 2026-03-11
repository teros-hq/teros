/**
 * Migrate memory collections from old naming (agent_agent_xxx) to new naming (agent_xxx)
 */

import { QdrantClient } from '@qdrant/js-client-rest';

const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const QDRANT_API_KEY = process.env.QDRANT_API_KEY || 'qdrant-dev-key';

const qdrant = new QdrantClient({
  url: QDRANT_URL,
  apiKey: QDRANT_API_KEY,
});

async function migrateCollections() {
  console.log('🔄 Starting memory collection migration...\n');

  try {
    // Get all collections
    const { collections } = await qdrant.getCollections();
    
    // Find collections with double agent_ prefix
    const oldCollections = collections.filter(c => 
      c.name.startsWith('agent_agent_')
    );

    if (oldCollections.length === 0) {
      console.log('✅ No collections to migrate. All good!');
      return;
    }

    console.log(`Found ${oldCollections.length} collections to migrate:\n`);

    for (const collection of oldCollections) {
      const oldName = collection.name;
      // Remove one 'agent_' prefix: agent_agent_xxx -> agent_xxx
      const newName = oldName.replace(/^agent_agent_/, 'agent_');

      console.log(`  📦 ${oldName}`);
      console.log(`     → ${newName}`);

      // Check if new collection already exists
      try {
        await qdrant.getCollection(newName);
        console.log(`     ⚠️  New collection already exists, skipping...`);
        continue;
      } catch {
        // Collection doesn't exist, we can create it
      }

      // Get old collection info
      const oldCollectionInfo = await qdrant.getCollection(oldName);
      const vectors = oldCollectionInfo.config?.params?.vectors;
      const vectorSize = typeof vectors === 'object' && vectors && 'size' in vectors 
        ? (vectors.size as number) 
        : 1536;

      // Create new collection with same config
      await qdrant.createCollection(newName, {
        vectors: {
          size: vectorSize,
          distance: 'Cosine',
        },
      });

      console.log(`     ✓ Created new collection`);

      // Copy all points from old to new
      let offset: string | number | undefined = undefined;
      let totalCopied = 0;

      while (true) {
        const response = await qdrant.scroll(oldName, {
          limit: 100,
          offset,
          with_payload: true,
          with_vector: true,
        });

        if (response.points.length === 0) break;

        // Upsert points to new collection
        await qdrant.upsert(newName, {
          wait: true,
          points: response.points.map(p => ({
            id: p.id,
            vector: p.vector as number[],
            payload: p.payload,
          })),
        });

        totalCopied += response.points.length;
        
        // Handle offset - can be string, number, or undefined
        const nextOffset = response.next_page_offset;
        if (!nextOffset || (typeof nextOffset === 'object')) break;
        offset = nextOffset as string | number;
      }

      console.log(`     ✓ Copied ${totalCopied} points`);

      // Delete old collection
      await qdrant.deleteCollection(oldName);
      console.log(`     ✓ Deleted old collection\n`);
    }

    console.log('✅ Migration complete!');

  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrateCollections();
