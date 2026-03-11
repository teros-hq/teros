import { v4 as uuidv4 } from 'uuid';
import { qdrant, getAgentCollection, COLLECTION_TYPES, ensureAgentCollections } from './qdrant-client.js';
import { generateEmbedding } from './embeddings-lazy.js';
import type { KnowledgeMemory, SearchResult } from './types.js';
import { logger } from './logger.js';

/**
 * Save knowledge to the agent's personal knowledge base
 */
export async function saveKnowledge(
  agentId: string,
  fact: string,
  source: string,
  category: string,
  options: {
    confidence?: number;
    userId?: string;
  } = {}
): Promise<string> {
  const { confidence = 0.8, userId } = options;

  if (!agentId) {
    throw new Error('agentId is required for saveKnowledge');
  }

  await ensureAgentCollections(agentId);
  const collectionName = getAgentCollection(agentId, COLLECTION_TYPES.KNOWLEDGE);

  const id = uuidv4();
  const vector = await generateEmbedding(fact);

  const payload: KnowledgeMemory = {
    id,
    fact,
    source,
    category,
    confidence,
    timestamp: new Date().toISOString(),
    agentId,
    userId,
  };

  await qdrant.upsert(collectionName, {
    wait: true,
    points: [
      {
        id,
        vector,
        payload: payload as unknown as Record<string, unknown>,
      },
    ],
  });

  logger.debug(`📚 [${agentId}] Saved knowledge: ${fact.slice(0, 50)}...`);
  return id;
}

/**
 * Search knowledge in the agent's knowledge base
 */
export async function searchKnowledge(
  agentId: string,
  query: string,
  limit: number = 5,
  category?: string
): Promise<SearchResult<KnowledgeMemory>[]> {
  const collectionName = getAgentCollection(agentId, COLLECTION_TYPES.KNOWLEDGE);
  const vector = await generateEmbedding(query);

  const filter = category
    ? {
        must: [
          {
            key: 'category',
            match: { value: category },
          },
        ],
      }
    : undefined;

  try {
    const results = await qdrant.search(collectionName, {
      vector,
      limit,
      filter,
      with_payload: true,
    });

    // Update last_accessed timestamp
    for (const result of results) {
      await qdrant.setPayload(collectionName, {
        points: [result.id],
        payload: {
          last_accessed: new Date().toISOString(),
        },
      });
    }

    return results.map((result) => ({
      id: result.id,
      score: result.score,
      payload: result.payload as unknown as KnowledgeMemory,
    }));
  } catch (error) {
    logger.debug(`Collection ${collectionName} not found, returning empty results`);
    return [];
  }
}

/**
 * Get all knowledge in a category for an agent
 */
export async function getKnowledgeByCategory(
  agentId: string,
  category: string
): Promise<KnowledgeMemory[]> {
  const collectionName = getAgentCollection(agentId, COLLECTION_TYPES.KNOWLEDGE);

  try {
    const results = await qdrant.scroll(collectionName, {
      filter: {
        must: [
          {
            key: 'category',
            match: { value: category },
          },
        ],
      },
      limit: 100,
      with_payload: true,
    });

    return (results.points || []).map((point) => point.payload as unknown as KnowledgeMemory);
  } catch (error) {
    logger.debug(`Collection ${collectionName} not found, returning empty results`);
    return [];
  }
}

export const KNOWLEDGE_CATEGORIES = {
  USER_PREFERENCES: 'user_preferences',
  PROJECT_DATA: 'project_data',
  COMMANDS: 'commands',
  CODING_PATTERNS: 'coding_patterns',
  TOOLS: 'tools',
  WORKFLOWS: 'workflows',
} as const;
