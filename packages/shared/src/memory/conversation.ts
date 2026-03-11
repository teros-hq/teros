import { v4 as uuidv4 } from 'uuid';
import { qdrant, getAgentCollection, COLLECTION_TYPES, ensureAgentCollections } from './qdrant-client.js';
// Use lazy-loaded embeddings to avoid sharp dependency on startup
import { generateEmbedding } from './embeddings-lazy.js';
import type { ConversationMemory, SearchResult } from './types.js';
import { logger } from './logger.js';

/**
 * Save a conversation to the agent's personal memory
 * Each agent has its own collection: agent_{agentId}_conversations
 */
export async function saveConversation(
  userMessage: string,
  assistantResponse: string,
  options: {
    agentId: string;       // Required: which agent owns this memory
    context?: string;
    importance?: number;
    userId?: string;
    sessionId?: string;
    channelId?: string;
    deduplicationThreshold?: number;
    deduplicationWindowHours?: number;
  }
): Promise<string | null> {
  const {
    agentId,
    context,
    importance = 0.5,
    userId,
    sessionId,
    channelId,
    deduplicationThreshold = 0.95,
    deduplicationWindowHours = 24,
  } = options;

  if (!agentId) {
    throw new Error('agentId is required for saveConversation');
  }

  // Ensure agent's collections exist
  await ensureAgentCollections(agentId);
  
  const collectionName = getAgentCollection(agentId, COLLECTION_TYPES.CONVERSATIONS);

  // Check for duplicates if threshold is set
  if (deduplicationThreshold > 0) {
    const combinedText = `User: ${userMessage}\nAssistant: ${assistantResponse}`;
    const isDuplicate = await checkForDuplicate(
      agentId,
      combinedText,
      deduplicationThreshold,
      deduplicationWindowHours
    );

    if (isDuplicate) {
      logger.debug(
        `⏭️ [${agentId}] Skipping duplicate conversation (similarity > ${deduplicationThreshold})`
      );
      return null;
    }
  }

  const id = uuidv4();
  const combinedText = `User: ${userMessage}\nAssistant: ${assistantResponse}`;
  const vector = await generateEmbedding(combinedText);

  const payload: ConversationMemory = {
    id,
    timestamp: new Date().toISOString(),
    user_message: userMessage,
    assistant_response: assistantResponse,
    context,
    importance,
    agentId,
    userId,
    sessionId,
    channelId,
  };

  await qdrant.upsert(collectionName, {
    wait: true,
    points: [
      {
        id,
        vector,
        payload,
      },
    ],
  });

  logger.debug(`💾 [${agentId}] Saved conversation ${id}`);
  return id;
}

/**
 * Check if a similar conversation exists in the agent's recent memory
 */
async function checkForDuplicate(
  agentId: string,
  combinedText: string,
  threshold: number,
  windowHours: number
): Promise<boolean> {
  const collectionName = getAgentCollection(agentId, COLLECTION_TYPES.CONVERSATIONS);
  const vector = await generateEmbedding(combinedText);
  const now = new Date();
  const windowStart = new Date(now.getTime() - windowHours * 60 * 60 * 1000);

  try {
    const results = await qdrant.search(collectionName, {
      vector,
      limit: 5,
      filter: {
        must: [
          {
            key: 'timestamp',
            range: {
              gte: windowStart.toISOString(),
            },
          },
        ],
      },
      with_payload: true,
    });

    const hasDuplicate = results.some((result) => result.score >= threshold);

    if (hasDuplicate && results[0]) {
      logger.debug(
        `🔍 [${agentId}] Found duplicate: score ${results[0].score.toFixed(3)} (threshold: ${threshold})`
      );
    }

    return hasDuplicate;
  } catch (error) {
    // Collection might not exist yet
    return false;
  }
}

/**
 * Search conversations in the agent's memory
 */
export async function searchConversations(
  agentId: string,
  query: string,
  limit: number = 5,
  filter?: {
    userId?: string;
    channelId?: string;
    since?: string;
  }
): Promise<SearchResult<ConversationMemory>[]> {
  const collectionName = getAgentCollection(agentId, COLLECTION_TYPES.CONVERSATIONS);
  const vector = await generateEmbedding(query);

  // Build Qdrant filter
  const qdrantFilter: any = { must: [] };
  
  if (filter?.userId) {
    qdrantFilter.must.push({
      key: 'userId',
      match: { value: filter.userId },
    });
  }
  
  if (filter?.channelId) {
    qdrantFilter.must.push({
      key: 'channelId',
      match: { value: filter.channelId },
    });
  }
  
  if (filter?.since) {
    qdrantFilter.must.push({
      key: 'timestamp',
      range: { gte: filter.since },
    });
  }

  try {
    const results = await qdrant.search(collectionName, {
      vector,
      limit,
      filter: qdrantFilter.must.length > 0 ? qdrantFilter : undefined,
      with_payload: true,
    });

    return results.map((result) => ({
      id: result.id,
      score: result.score,
      payload: result.payload as ConversationMemory,
    }));
  } catch (error) {
    logger.debug(`Collection ${collectionName} not found, returning empty results`);
    return [];
  }
}

/**
 * Get recent conversations from the agent's memory
 */
export async function getRecentConversations(
  agentId: string,
  limit: number = 10,
  filter?: {
    userId?: string;
    channelId?: string;
  }
): Promise<ConversationMemory[]> {
  const collectionName = getAgentCollection(agentId, COLLECTION_TYPES.CONVERSATIONS);

  // Build Qdrant filter
  const qdrantFilter: any = { must: [] };
  
  if (filter?.userId) {
    qdrantFilter.must.push({
      key: 'userId',
      match: { value: filter.userId },
    });
  }
  
  if (filter?.channelId) {
    qdrantFilter.must.push({
      key: 'channelId',
      match: { value: filter.channelId },
    });
  }

  try {
    const results = await qdrant.scroll(collectionName, {
      limit,
      filter: qdrantFilter.must.length > 0 ? qdrantFilter : undefined,
      with_payload: true,
    });

    return (results.points || [])
      .map((point) => point.payload as ConversationMemory)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  } catch (error) {
    logger.debug(`Collection ${collectionName} not found, returning empty results`);
    return [];
  }
}
