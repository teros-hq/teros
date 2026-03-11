import OpenAI from 'openai';
import { logger } from './logger.js';

let openaiClient: OpenAI | null = null;

const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;

/**
 * Initialize OpenAI client with API key
 * Must be called before using embeddings
 */
export function initializeOpenAI(apiKey: string): void {
  if (!apiKey) {
    throw new Error('OpenAI API key is required');
  }
  
  openaiClient = new OpenAI({
    apiKey,
  });
  
  logger.info('OpenAI client initialized for embeddings');
}

/**
 * Get the OpenAI client instance
 * Throws if not initialized
 */
function getOpenAI(): OpenAI {
  if (!openaiClient) {
    throw new Error('OpenAI client not initialized. Call initializeOpenAI() first.');
  }
  return openaiClient;
}

export async function initEmbeddings() {
  // Backwards compatibility - now handled by initializeOpenAI
  return true;
}

export async function generateEmbedding(text: string): Promise<number[]> {
  if (typeof text !== 'string') {
    throw new Error(`generateEmbedding expects string, got ${typeof text}: ${JSON.stringify(text)}`);
  }

  if (!text || text.trim().length === 0) {
    throw new Error('generateEmbedding expects non-empty string');
  }

  const openai = getOpenAI();

  try {
    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: text,
      dimensions: EMBEDDING_DIMENSIONS,
    });
    return response.data[0].embedding;
  } catch (error) {
    logger.error({ err: error, msg: 'Error generating embedding' });
    throw error;
  }
}

export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  // Batch request to OpenAI (more efficient)
  if (texts.length === 0) {
    return [];
  }

  const openai = getOpenAI();

  try {
    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: texts,
      dimensions: EMBEDDING_DIMENSIONS,
    });
    return response.data.map(item => item.embedding);
  } catch (error) {
    logger.error({ err: error, msg: 'Error generating embeddings batch' });
    // Fallback to individual requests if batch fails
    return Promise.all(texts.map(text => generateEmbedding(text)));
  }
}
