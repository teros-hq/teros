/**
 * Lazy-loaded embeddings to avoid sharp dependency on startup
 * This module delays loading @xenova/transformers until actually needed
 */

let embeddingsModule: typeof import('./embeddings.js') | null = null;

async function loadEmbeddings() {
  if (!embeddingsModule) {
    // Dynamic import to avoid loading sharp on module initialization
    embeddingsModule = await import('./embeddings.js');
  }
  return embeddingsModule;
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const embeddings = await loadEmbeddings();
  return embeddings.generateEmbedding(text);
}

export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  const embeddings = await loadEmbeddings();
  return embeddings.generateEmbeddings(texts);
}

export async function initEmbeddings() {
  const embeddings = await loadEmbeddings();
  return embeddings.initEmbeddings();
}
