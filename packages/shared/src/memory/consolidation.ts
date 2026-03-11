/**
 * Memory Consolidation (Dreaming)
 * 
 * Periodic batch process that:
 * 1. Deduplicates identical knowledge
 * 2. Merges similar knowledge (similarity > 0.95)
 * 3. Cleans old conversations (>6 months, importance <0.5)
 * 4. Degrades relevance of unused knowledge (-0.1 confidence/month)
 */

import { getQdrant } from './qdrant-client.js';
import { generateEmbedding } from './embeddings.js';
import { getAgentCollection, COLLECTION_TYPES } from './qdrant-client.js';

// Simple logger for consolidation
const logger = {
  info: (msg: string) => console.log(msg),
  error: (msg: string, error?: unknown) => console.error(msg, error),
  debug: (msg: string) => console.log(msg),
};

export interface ConsolidationResult {
  deduplicated: number;
  merged: number;
  cleaned: number;
  degraded: number;
  duration_ms: number;
}

export interface ConsolidationOptions {
  agentId: string;
  // Similarity threshold for merging (default: 0.95)
  similarityThreshold?: number;
  // Age threshold for cleaning conversations in days (default: 180 = 6 months)
  conversationAgeThreshold?: number;
  // Importance threshold for cleaning (default: 0.5)
  importanceThreshold?: number;
  // Confidence degradation per month of inactivity (default: 0.1)
  confidenceDegradation?: number;
  // Inactivity threshold in days (default: 30)
  inactivityThreshold?: number;
}

/**
 * Run full memory consolidation for an agent
 */
export async function consolidateMemory(
  options: ConsolidationOptions
): Promise<ConsolidationResult> {
  const startTime = Date.now();
  const {
    agentId,
    similarityThreshold = 0.95,
    conversationAgeThreshold = 180,
    importanceThreshold = 0.5,
    confidenceDegradation = 0.1,
    inactivityThreshold = 30,
  } = options;

  logger.info(`[Consolidation] 🌙 Starting memory consolidation for agent ${agentId}`);

  let deduplicated = 0;
  let merged = 0;
  let cleaned = 0;
  let degraded = 0;

  try {
    // 1. Deduplicate knowledge
    deduplicated = await deduplicateKnowledge(agentId);
    logger.info(`[Consolidation] 🔄 Deduplicated ${deduplicated} knowledge items`);

    // 2. Merge similar knowledge
    merged = await mergeSimilarKnowledge(agentId, similarityThreshold);
    logger.info(`[Consolidation] 🔗 Merged ${merged} similar knowledge items`);

    // 3. Clean old conversations
    cleaned = await cleanOldConversations(
      agentId,
      conversationAgeThreshold,
      importanceThreshold
    );
    logger.info(`[Consolidation] 🧹 Cleaned ${cleaned} old conversations`);

    // 4. Degrade unused knowledge
    degraded = await degradeUnusedKnowledge(
      agentId,
      inactivityThreshold,
      confidenceDegradation
    );
    logger.info(`[Consolidation] 📉 Degraded ${degraded} unused knowledge items`);

  } catch (error) {
    logger.error('[Consolidation] ❌ Error during consolidation:', error);
    throw error;
  }

  const duration = Date.now() - startTime;
  logger.info(`[Consolidation] ✅ Consolidation complete in ${duration}ms`);

  return {
    deduplicated,
    merged,
    cleaned,
    degraded,
    duration_ms: duration,
  };
}

/**
 * Deduplicate identical knowledge items
 * Keeps the most recent one
 */
async function deduplicateKnowledge(agentId: string): Promise<number> {
  const qdrant = getQdrant();
  const collectionName = getAgentCollection(agentId, COLLECTION_TYPES.KNOWLEDGE);

  // Scroll all knowledge items
  const response = await qdrant.scroll(collectionName, {
    limit: 1000,
    with_payload: true,
    with_vector: false,
  });

  const points = response.points;
  const seenFacts = new Map<string, any>();
  const duplicates: string[] = [];

  for (const point of points) {
    const fact = point.payload?.fact as string | undefined;
    if (!fact) continue;

    const existing = seenFacts.get(fact);
    if (existing) {
      // Duplicate found - keep the most recent one
      const existingTimestamp = new Date(existing.payload.timestamp as string).getTime();
      const currentTimestamp = new Date((point.payload?.timestamp as string) || Date.now()).getTime();

      if (currentTimestamp > existingTimestamp) {
        // Current is newer - delete existing
        duplicates.push(existing.id);
        seenFacts.set(fact, point);
      } else {
        // Existing is newer - delete current
        duplicates.push(point.id as string);
      }
    } else {
      seenFacts.set(fact, point);
    }
  }

  // Delete duplicates
  if (duplicates.length > 0) {
    await qdrant.delete(collectionName, {
      points: duplicates,
      wait: true,
    });
  }

  return duplicates.length;
}

/**
 * Merge similar knowledge items (similarity > threshold)
 */
async function mergeSimilarKnowledge(
  agentId: string,
  similarityThreshold: number
): Promise<number> {
  const qdrant = getQdrant();
  const collectionName = getAgentCollection(agentId, COLLECTION_TYPES.KNOWLEDGE);

  // Scroll all knowledge items
  const response = await qdrant.scroll(collectionName, {
    limit: 1000,
    with_payload: true,
    with_vector: true,
  });

  const points = response.points;
  const toDelete: string[] = [];
  let mergedCount = 0;

  // Compare each point with all others
  for (let i = 0; i < points.length; i++) {
    const point1 = points[i];
    if (toDelete.includes(point1.id as string)) continue;

    for (let j = i + 1; j < points.length; j++) {
      const point2 = points[j];
      if (toDelete.includes(point2.id as string)) continue;

      // Calculate cosine similarity
      const similarity = cosineSimilarity(point1.vector as number[], point2.vector as number[]);

      if (similarity > similarityThreshold) {
        // Merge: keep point1, delete point2
        // Update point1 with combined info
        const mergedFact = `${point1.payload?.fact}\n[Similar: ${point2.payload?.fact}]`;
        const maxConfidence = Math.max(
          (point1.payload?.confidence as number) || 0,
          (point2.payload?.confidence as number) || 0
        );

        await qdrant.setPayload(collectionName, {
          points: [point1.id],
          payload: {
            ...point1.payload,
            fact: mergedFact,
            confidence: maxConfidence,
            merged_from: point2.id,
          },
          wait: true,
        });

        toDelete.push(point2.id as string);
        mergedCount++;
      }
    }
  }

  // Delete merged items
  if (toDelete.length > 0) {
    await qdrant.delete(collectionName, {
      points: toDelete,
      wait: true,
    });
  }

  return mergedCount;
}

/**
 * Clean old conversations with low importance
 */
async function cleanOldConversations(
  agentId: string,
  ageThresholdDays: number,
  importanceThreshold: number
): Promise<number> {
  const qdrant = getQdrant();
  const collectionName = getAgentCollection(agentId, COLLECTION_TYPES.CONVERSATIONS);

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - ageThresholdDays);
  const cutoffTimestamp = cutoffDate.toISOString();

  // Scroll all conversations
  const response = await qdrant.scroll(collectionName, {
    limit: 1000,
    with_payload: true,
    with_vector: false,
  });

  const toDelete: string[] = [];

  for (const point of response.points) {
    const timestamp = point.payload?.timestamp as string | undefined;
    const importance = (point.payload?.importance as number) || 0;

    if (timestamp && timestamp < cutoffTimestamp && importance < importanceThreshold) {
      toDelete.push(point.id as string);
    }
  }

  // Delete old conversations
  if (toDelete.length > 0) {
    await qdrant.delete(collectionName, {
      points: toDelete,
      wait: true,
    });
  }

  return toDelete.length;
}

/**
 * Degrade confidence of unused knowledge
 */
async function degradeUnusedKnowledge(
  agentId: string,
  inactivityThresholdDays: number,
  degradationAmount: number
): Promise<number> {
  const qdrant = getQdrant();
  const collectionName = getAgentCollection(agentId, COLLECTION_TYPES.KNOWLEDGE);

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - inactivityThresholdDays);
  const cutoffTimestamp = cutoffDate.toISOString();

  // Scroll all knowledge items
  const response = await qdrant.scroll(collectionName, {
    limit: 1000,
    with_payload: true,
    with_vector: false,
  });

  const toUpdate: any[] = [];
  let degradedCount = 0;

  for (const point of response.points) {
    const lastAccessed = (point.payload?.last_accessed as string | undefined) || (point.payload?.timestamp as string | undefined);

    if (lastAccessed && lastAccessed < cutoffTimestamp) {
      const currentConfidence = (point.payload?.confidence as number) || 0.8;
      const newConfidence = Math.max(0.1, currentConfidence - degradationAmount);

      if (newConfidence !== currentConfidence) {
        toUpdate.push({
          id: point.id,
          payload: {
            ...point.payload,
            confidence: newConfidence,
          },
        });
        degradedCount++;
      }
    }
  }

  // Update confidence values
  for (const update of toUpdate) {
    await qdrant.setPayload(collectionName, {
      points: [update.id],
      payload: update.payload,
      wait: true,
    });
  }

  return degradedCount;
}

/**
 * Calculate cosine similarity between two vectors
 */
function cosineSimilarity(vec1: number[], vec2: number[]): number {
  if (vec1.length !== vec2.length) {
    throw new Error('Vectors must have same length');
  }

  let dotProduct = 0;
  let magnitude1 = 0;
  let magnitude2 = 0;

  for (let i = 0; i < vec1.length; i++) {
    dotProduct += vec1[i] * vec2[i];
    magnitude1 += vec1[i] * vec1[i];
    magnitude2 += vec2[i] * vec2[i];
  }

  magnitude1 = Math.sqrt(magnitude1);
  magnitude2 = Math.sqrt(magnitude2);

  if (magnitude1 === 0 || magnitude2 === 0) {
    return 0;
  }

  return dotProduct / (magnitude1 * magnitude2);
}
