import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import {
  createMcaTestEnv,
  expectToolsExact,
  type McaTestEnvironment,
} from '@teros/mca-testing';

let env: McaTestEnvironment;

beforeAll(async () => {
  env = createMcaTestEnv({
    mcaId: 'mca.teros.memory',
    profiles: ['qdrant'],
    startMockOpenAI: true,
  });
  await env.start();
}, 120_000);

afterAll(async () => {
  await env.stop();
}, 30_000);

beforeEach(() => {
  env.mockBackend.reset();
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
    expectToolsExact(tools, [
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

// ─── Event Emission ───────────────────────────────────────────────────────

describe('Event Emission', () => {
  it('health-check does not emit unexpected events', async () => {
    env.mockBackend.reset();
    await env.mcaClient.callTool('memory-health-check', {});
    const events = env.mockBackend.getReceivedEvents();
    expect(events).toEqual([]);
  });
});

// ─── Health Check ──────────────────────────────────────────────────────────

describe('Health Check', () => {
  it('reports AUTH_REQUIRED when secrets are empty', async () => {
    env.mockBackend.setSystemSecrets({});

    const result = await env.mcaClient.callTool('memory-health-check', {});

    expect(result.success).toBe(true);
    const data = result.result as { status: string; issues?: { code: string }[] };
    expect(data.status).not.toBe('ready');
    const codes = (data.issues ?? []).map((i) => i.code);
    expect(codes).toContain('AUTH_REQUIRED');
  });

  it('handles secrets callback failure gracefully', async () => {
    env.mockBackend.setSecretError(500, 'Backend unavailable');

    const result = await env.mcaClient.callTool('memory-health-check', {});

    expect(result.success).toBe(true);
    const data = result.result as { status: string; issues?: { code: string }[] };
    expect(data.status).not.toBe('ready');
  });
});

// ─── Input Validation (CORRECT boundaries) ────────────────────────────────
// These don't need Qdrant — the SDK validates required fields before
// calling the handler.

describe('Input Validation', () => {
  it('memory-save-conversation fails without required fields', async () => {
    const result = await env.mcaClient.callTool('memory-save-conversation', {});
    expect(result.success).toBe(false);
  });

  it('memory-search-conversations fails without query', async () => {
    const result = await env.mcaClient.callTool('memory-search-conversations', {});
    expect(result.success).toBe(false);
  });
});
