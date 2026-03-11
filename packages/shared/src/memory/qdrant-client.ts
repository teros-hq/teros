import { QdrantClient } from '@qdrant/js-client-rest';
import { logger } from './logger.js';

// Global qdrant client instance
let qdrantInstance: QdrantClient | null = null;

/**
 * Initialize Qdrant client with configuration
 * Must be called before using any memory functions
 */
export function initializeQdrant(config: { url: string; apiKey: string }): void {
  if (!config.url) {
    throw new Error('Qdrant URL is required');
  }
  if (!config.apiKey) {
    throw new Error('Qdrant API key is required');
  }
  
  qdrantInstance = new QdrantClient({
    url: config.url,
    apiKey: config.apiKey,
  });
  
  logger.info(`Qdrant client initialized with URL: ${config.url}`);
}

/**
 * Get the Qdrant client instance
 * Throws if not initialized
 */
export function getQdrant(): QdrantClient {
  if (!qdrantInstance) {
    throw new Error('Qdrant client not initialized. Call initializeQdrant() first.');
  }
  return qdrantInstance;
}

// Legacy export for backwards compatibility
// Will throw if not initialized
export const qdrant = new Proxy({} as QdrantClient, {
  get(target, prop) {
    return getQdrant()[prop as keyof QdrantClient];
  }
});

/**
 * Collection types for agent memory
 */
export const COLLECTION_TYPES = {
  CONVERSATIONS: 'conversations',
  KNOWLEDGE: 'knowledge',
  TASKS: 'tasks',
} as const;

export type CollectionType = typeof COLLECTION_TYPES[keyof typeof COLLECTION_TYPES];

/**
 * Get collection name for a specific agent
 * Format: agent_{agentId}_{type}
 * Example: agent_alice123_conversations
 */
export function getAgentCollection(agentId: string, type: CollectionType): string {
  // Sanitize agentId to be safe for collection names
  let safeAgentId = agentId.replace(/[^a-zA-Z0-9_-]/g, '_');
  
  // Remove 'agent_' prefix if it exists to avoid duplication
  // agentId is usually 'agent_xxx', so we extract just the ID part
  if (safeAgentId.startsWith('agent_')) {
    safeAgentId = safeAgentId.substring(6); // Remove 'agent_' prefix
  }
  
  return `agent_${safeAgentId}_${type}`;
}

/**
 * Vector size for embeddings (OpenAI text-embedding-3-small)
 */
export const VECTOR_SIZE = 1536;

/**
 * Ensure agent collections exist, create if not
 */
export async function ensureAgentCollections(agentId: string): Promise<void> {
  const client = getQdrant();
  const collections = await client.getCollections();
  const existingNames = new Set(collections.collections.map(c => c.name));

  for (const type of Object.values(COLLECTION_TYPES)) {
    const collectionName = getAgentCollection(agentId, type);
    
    if (!existingNames.has(collectionName)) {
      logger.info(`Creating collection ${collectionName} for agent ${agentId}`);
      
      await client.createCollection(collectionName, {
        vectors: {
          size: VECTOR_SIZE,
          distance: 'Cosine',
        },
        // Optimize for small-medium collections
        optimizers_config: {
          default_segment_number: 2,
        },
        // Enable payload indexing for common filters
        on_disk_payload: true,
      });

      // Create payload indexes for efficient filtering
      await client.createPayloadIndex(collectionName, {
        field_name: 'timestamp',
        field_schema: 'keyword',
      });
      
      if (type === COLLECTION_TYPES.CONVERSATIONS) {
        await client.createPayloadIndex(collectionName, {
          field_name: 'userId',
          field_schema: 'keyword',
        });
        await client.createPayloadIndex(collectionName, {
          field_name: 'channelId',
          field_schema: 'keyword',
        });
      }
      
      if (type === COLLECTION_TYPES.KNOWLEDGE) {
        await client.createPayloadIndex(collectionName, {
          field_name: 'category',
          field_schema: 'keyword',
        });
      }
    }
  }
}

/**
 * Delete all collections for an agent
 */
export async function deleteAgentCollections(agentId: string): Promise<void> {
  const client = getQdrant();
  for (const type of Object.values(COLLECTION_TYPES)) {
    const collectionName = getAgentCollection(agentId, type);
    try {
      await client.deleteCollection(collectionName);
      logger.info(`Deleted collection ${collectionName}`);
    } catch (error) {
      // Collection might not exist, that's ok
      logger.debug(`Collection ${collectionName} not found, skipping`);
    }
  }
}

/**
 * List all agent IDs that have collections
 */
export async function listAgentsWithMemory(): Promise<string[]> {
  const client = getQdrant();
  const collections = await client.getCollections();
  const agentIds = new Set<string>();
  
  for (const collection of collections.collections) {
    const match = collection.name.match(/^agent_(.+)_(conversations|knowledge|tasks)$/);
    if (match) {
      agentIds.add(match[1]);
    }
  }
  
  return Array.from(agentIds);
}

/**
 * Get stats for an agent's memory
 */
export async function getAgentMemoryStats(agentId: string): Promise<{
  conversations: number;
  knowledge: number;
  tasks: number;
  totalPoints: number;
}> {
  const client = getQdrant();
  const stats = {
    conversations: 0,
    knowledge: 0,
    tasks: 0,
    totalPoints: 0,
  };

  for (const type of Object.values(COLLECTION_TYPES)) {
    const collectionName = getAgentCollection(agentId, type);
    try {
      const info = await client.getCollection(collectionName);
      const count = info.points_count || 0;
      stats[type as keyof typeof stats] = count;
      stats.totalPoints += count;
    } catch {
      // Collection doesn't exist
    }
  }

  return stats;
}
