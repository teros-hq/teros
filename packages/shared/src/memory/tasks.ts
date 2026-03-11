import { v4 as uuidv4 } from 'uuid';
import { qdrant, getAgentCollection, COLLECTION_TYPES, ensureAgentCollections } from './qdrant-client.js';
import { generateEmbedding } from './embeddings-lazy.js';
import type { TaskMemory, SearchResult } from './types.js';
import { logger } from './logger.js';

/**
 * Save a task to the agent's task memory
 */
export async function saveTask(
  agentId: string,
  description: string,
  filesModified: string[],
  commandsRun: string[],
  outcome: 'success' | 'failure' | 'partial',
  options: {
    lessonsLearned?: string;
    durationMs?: number;
    userId?: string;
  } = {}
): Promise<string> {
  if (!agentId) {
    throw new Error('agentId is required for saveTask');
  }

  await ensureAgentCollections(agentId);
  const collectionName = getAgentCollection(agentId, COLLECTION_TYPES.TASKS);

  const id = uuidv4();
  const combinedText = `${description}\nFiles: ${filesModified.join(', ')}\nCommands: ${commandsRun.join('; ')}`;
  const vector = await generateEmbedding(combinedText);

  const payload: TaskMemory = {
    id,
    description,
    files_modified: filesModified,
    commands_run: commandsRun,
    outcome,
    lessons_learned: options.lessonsLearned,
    timestamp: new Date().toISOString(),
    duration_ms: options.durationMs,
    agentId,
    userId: options.userId,
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

  logger.debug(`✅ [${agentId}] Saved task: ${description.slice(0, 50)}... (${outcome})`);
  return id;
}

/**
 * Search tasks in the agent's task memory
 */
export async function searchTasks(
  agentId: string,
  query: string,
  limit: number = 5,
  outcomeFilter?: 'success' | 'failure' | 'partial'
): Promise<SearchResult<TaskMemory>[]> {
  const collectionName = getAgentCollection(agentId, COLLECTION_TYPES.TASKS);
  const vector = await generateEmbedding(query);

  const filter = outcomeFilter
    ? {
        must: [
          {
            key: 'outcome',
            match: { value: outcomeFilter },
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

    return results.map((result) => ({
      id: result.id,
      score: result.score,
      payload: result.payload as TaskMemory,
    }));
  } catch (error) {
    logger.debug(`Collection ${collectionName} not found, returning empty results`);
    return [];
  }
}

/**
 * Get recent tasks from the agent's memory
 */
export async function getRecentTasks(
  agentId: string,
  limit: number = 10
): Promise<TaskMemory[]> {
  const collectionName = getAgentCollection(agentId, COLLECTION_TYPES.TASKS);

  try {
    const results = await qdrant.scroll(collectionName, {
      limit,
      with_payload: true,
    });

    return (results.points || [])
      .map((point) => point.payload as TaskMemory)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  } catch (error) {
    logger.debug(`Collection ${collectionName} not found, returning empty results`);
    return [];
  }
}

/**
 * Get successful tasks from the agent's memory
 */
export async function getSuccessfulTasks(
  agentId: string,
  limit: number = 10
): Promise<TaskMemory[]> {
  const collectionName = getAgentCollection(agentId, COLLECTION_TYPES.TASKS);

  try {
    const results = await qdrant.scroll(collectionName, {
      filter: {
        must: [
          {
            key: 'outcome',
            match: { value: 'success' },
          },
        ],
      },
      limit,
      with_payload: true,
    });

    return (results.points || []).map((point) => point.payload as TaskMemory);
  } catch (error) {
    logger.debug(`Collection ${collectionName} not found, returning empty results`);
    return [];
  }
}
