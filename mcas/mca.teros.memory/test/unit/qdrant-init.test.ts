import { describe, expect, it, mock, beforeEach } from 'bun:test';

const mockInitializeQdrant = mock(() => {});
const mockInitializeOpenAI = mock(() => {});

mock.module('@teros/shared/memory', () => ({
  initializeQdrant: mockInitializeQdrant,
}));
mock.module('@teros/shared/memory/embeddings', () => ({
  initializeOpenAI: mockInitializeOpenAI,
}));

function mockContext(systemSecrets: Record<string, any> = {}) {
  return {
    getSystemSecrets: mock(() => Promise.resolve(systemSecrets)),
  } as any;
}

describe('ensureQdrantInitialized', () => {
  beforeEach(() => {
    mockInitializeQdrant.mockClear();
    mockInitializeOpenAI.mockClear();
  });

  it('throws when qdrantUrl is missing', async () => {
    const { ensureQdrantInitialized } = await import('../../src/qdrant-init');
    const ctx = mockContext({ qdrantApiKey: 'key', openaiApiKey: 'key' });

    await expect(ensureQdrantInitialized(ctx)).rejects.toThrow('Qdrant configuration missing');
  });

  it('throws when qdrantApiKey is missing', async () => {
    const { ensureQdrantInitialized } = await import('../../src/qdrant-init');
    const ctx = mockContext({ qdrantUrl: 'http://localhost:6333', openaiApiKey: 'key' });

    await expect(ensureQdrantInitialized(ctx)).rejects.toThrow('Qdrant configuration missing');
  });

  it('throws when openaiApiKey is missing', async () => {
    const { ensureQdrantInitialized } = await import('../../src/qdrant-init');
    const ctx = mockContext({
      qdrantUrl: 'http://localhost:6333',
      qdrantApiKey: 'key',
    });

    await expect(ensureQdrantInitialized(ctx)).rejects.toThrow('OpenAI API key missing');
  });
});
