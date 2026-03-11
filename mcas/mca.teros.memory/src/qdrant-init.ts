import type { HttpToolContext } from '@teros/mca-sdk';
import { initializeQdrant } from '@teros/shared/memory';
import { initializeOpenAI } from '@teros/shared/memory/embeddings';

let initialized = false;

/**
 * Ensure Qdrant and OpenAI are initialized with secrets from the system
 * This is called lazily on first tool execution
 */
export async function ensureQdrantInitialized(context: HttpToolContext): Promise<void> {
  if (initialized) {
    return;
  }

  const secrets = await context.getSystemSecrets();

  if (!secrets.qdrantUrl || !secrets.qdrantApiKey) {
    throw new Error(
      'Qdrant configuration missing. Expected qdrantUrl and qdrantApiKey in system secrets.',
    );
  }

  if (!secrets.openaiApiKey) {
    throw new Error('OpenAI API key missing. Expected openaiApiKey in system secrets.');
  }

  initializeQdrant({
    url: secrets.qdrantUrl as string,
    apiKey: secrets.qdrantApiKey as string,
  });

  initializeOpenAI(secrets.openaiApiKey as string);

  initialized = true;
  console.log('[Memory MCA] Qdrant and OpenAI initialized');
}
