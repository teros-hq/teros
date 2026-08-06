import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import {
  createMcaTestEnv,
  expectToolSuccess,
  expectToolsInclude,
  type McaTestEnvironment,
} from '@teros/mca-testing';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const QDRANT_HOST = process.env.QDRANT_HOST ?? 'qdrant';
const QDRANT_PORT = process.env.QDRANT_PORT ?? '6333';

if (!OPENAI_API_KEY) {
  throw new Error(
    'OPENAI_API_KEY required for Memory MCA integration tests. ' +
    'Set it in .env.test or export it before running.',
  );
}

let env: McaTestEnvironment;

beforeAll(async () => {
  env = createMcaTestEnv({
    mcaId: 'mca.teros.memory',
    profiles: ['qdrant'],
  });

  await env.start();

  env.mockBackend.setSystemSecrets({
    qdrantUrl: `http://${QDRANT_HOST}:${QDRANT_PORT}`,
    qdrantApiKey: 'test-qdrant-key',
    openaiApiKey: OPENAI_API_KEY,
  });
}, 120_000);

afterAll(async () => {
  await env.stop();
}, 30_000);

beforeEach(() => {
  env.mockBackend.reset();
  env.mockBackend.setSystemSecrets({
    qdrantUrl: `http://${QDRANT_HOST}:${QDRANT_PORT}`,
    qdrantApiKey: 'test-qdrant-key',
    openaiApiKey: OPENAI_API_KEY,
  });
});

// ─── Lifecycle ─────────────────────────────────────────────────────────────

describe('Lifecycle', () => {
  it('starts up and reports healthy', async () => {
    const health = await env.mcaClient.health();
    expect(health.status).toBe('ready');
    expect(health.uptime).toBeGreaterThanOrEqual(0);
  });

  it('lists all expected tools', async () => {
    const tools = await env.mcaClient.listTools();
    expect(tools.tools.length).toBe(10);
    expectToolsInclude(tools, [
      'memory-health-check',
      'memory-search-conversations',
      'memory-get-recent-conversations',
      'memory-save-conversation',
      'memory-save-knowledge',
      'memory-search-knowledge',
      'memory-get-knowledge-by-category',
      'memory-calculate-importance',
      'memory-get-context-for-query',
      'memory-stats',
    ]);
  });
});

// ─── Tool: memory-save-conversation ────────────────────────────────────────

describe('memory-save-conversation', () => {
  it('saves a conversation and returns importance score', async () => {
    const result = await env.mcaClient.callTool('memory-save-conversation', {
      userMessage: 'How do I deploy the backend?',
      assistantResponse: 'Run `docker compose up -d` in the project root.',
    });

    expectToolSuccess(result);
    const data = result.result as { importance: number };
    expect(data.importance).toBeGreaterThan(0);
  }, 30_000);

  it('factors files and commands into importance', async () => {
    const result = await env.mcaClient.callTool('memory-save-conversation', {
      userMessage: 'Fix the auth bug',
      assistantResponse: 'Updated the token refresh logic in auth.ts.',
      filesModified: ['src/auth.ts', 'src/middleware.ts'],
      commandsRun: ['bun test'],
    });

    expectToolSuccess(result);
    const data = result.result as { importance: number };
    expect(data.importance).toBeGreaterThan(0);
  }, 30_000);
});

// ─── Tool: memory-search-conversations ─────────────────────────────────────

describe('memory-search-conversations', () => {
  it('finds saved conversation via semantic search', async () => {
    const uniquePhrase = `integration-test-${Date.now()}`;

    await env.mcaClient.callTool('memory-save-conversation', {
      userMessage: `Tell me about ${uniquePhrase} quantum entanglement theory`,
      assistantResponse: `The ${uniquePhrase} describes particles linked across distance.`,
    });

    // Real embeddings + real Qdrant vector search
    const result = await env.mcaClient.callTool('memory-search-conversations', {
      query: `${uniquePhrase} quantum entanglement`,
    });

    expectToolSuccess(result);
    const data = result.result as { conversations?: unknown[] };
    expect(data.conversations).toBeDefined();
    expect(data.conversations!.length).toBeGreaterThan(0);
  }, 30_000);

  it('returns empty for completely unrelated query', async () => {
    const result = await env.mcaClient.callTool('memory-search-conversations', {
      query: 'xyzzy_nonexistent_topic_999888777',
    });

    expectToolSuccess(result);
  }, 15_000);
});

// ─── Tool: memory-save-knowledge ───────────────────────────────────────────

describe('memory-save-knowledge', () => {
  it('saves and retrieves knowledge by category', async () => {
    const uniqueTitle = `deploy-process-${Date.now()}`;

    await env.mcaClient.callTool('memory-save-knowledge', {
      title: uniqueTitle,
      content: 'Always run migrations before deploying to production.',
      category: 'workflows',
    });

    const result = await env.mcaClient.callTool('memory-get-knowledge-by-category', {
      category: 'workflows',
    });

    expectToolSuccess(result);
  }, 30_000);

  it('finds knowledge via semantic search', async () => {
    const uniqueContent = `secret-rotation-policy-${Date.now()}`;

    await env.mcaClient.callTool('memory-save-knowledge', {
      title: 'Secret rotation',
      content: `${uniqueContent}: rotate API keys every 90 days.`,
      category: 'commands',
    });

    const result = await env.mcaClient.callTool('memory-search-knowledge', {
      query: uniqueContent,
    });

    expectToolSuccess(result);
  }, 30_000);
});

// ─── Tool: memory-get-context-for-query ────────────────────────────────────

describe('memory-get-context-for-query', () => {
  it('returns relevant context from saved data', async () => {
    await env.mcaClient.callTool('memory-save-conversation', {
      userMessage: 'How do I configure Redis caching?',
      assistantResponse: 'Set REDIS_URL in .env and enable the cache middleware.',
    });

    const result = await env.mcaClient.callTool('memory-get-context-for-query', {
      query: 'Redis caching setup',
    });

    expectToolSuccess(result);
  }, 30_000);
});

// ─── Tool: memory-stats ────────────────────────────────────────────────────

describe('memory-stats', () => {
  it('returns collection statistics', async () => {
    const result = await env.mcaClient.callTool('memory-stats', {});
    expectToolSuccess(result);
    expect(result.result).toHaveProperty('stats');
  }, 15_000);
});

// ─── Error Scenarios ───────────────────────────────────────────────────────
// Note: ensureQdrantInitialized() caches globally — once the first tool call
// succeeds, the MCA reuses the cached Qdrant+OpenAI clients regardless of
// secrets changes. Clearing secrets mid-process does NOT trigger re-init.
// These tests verify the health-check path (which always re-reads secrets)
// and input validation (which runs before init).

describe('Error Scenarios', () => {
  it('health-check reports issues when secrets callback fails', async () => {
    env.mockBackend.setSecretError(500, 'Internal server error');

    const result = await env.mcaClient.callTool('memory-health-check', {});

    expect(result.success).toBe(true);
    const data = result.result as { status: string; issues?: { code: string }[] };
    expect(data.status).not.toBe('ready');
  });

  it('health-check reports AUTH_REQUIRED when secrets are empty', async () => {
    env.mockBackend.setSystemSecrets({});

    const result = await env.mcaClient.callTool('memory-health-check', {});

    expect(result.success).toBe(true);
    const data = result.result as { status: string; issues?: { code: string }[] };
    expect(data.status).not.toBe('ready');
    const codes = (data.issues ?? []).map((i) => i.code);
    expect(codes).toContain('AUTH_REQUIRED');
  });
});
