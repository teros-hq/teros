import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import {
  createMcaTestEnv,
  expectToolError,
  expectToolsExact,
  type McaTestEnvironment,
} from '@teros/mca-testing';

let env: McaTestEnvironment;

beforeAll(async () => {
  env = createMcaTestEnv({ mcaId: 'mca.trello' });
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
  it('starts up and reports healthy (was Cannot find module before TER-536)', async () => {
    const health = await env.mcaClient.health();
    expect(health.status).toBe('ready');
    expect(health.uptime).toBeGreaterThanOrEqual(0);
  });

  it('lists all 20 tools', async () => {
    const tools = await env.mcaClient.listTools();
    expectToolsExact(tools, [
      '-health-check',
      'list-boards',
      'create-board',
      'get-board',
      'update-board',
      'delete-board',
      'list-board-lists',
      'create-list',
      'update-list',
      'list-cards',
      'get-card',
      'create-card',
      'update-card',
      'add-comment',
      'get-card-actions',
      'list-labels',
      'create-label',
      'add-label-to-card',
      'remove-label-from-card',
      'search',
    ]);
  });
});

// ─── Health check (auth gating) ────────────────────────────────────────────

describe('Health check', () => {
  it('reports AUTH_REQUIRED when no user secrets', async () => {
    env.mockBackend.setUserSecrets({});

    const result = await env.mcaClient.callTool('-health-check', {});

    expect(result.success).toBe(true);
    const data = result.result as { status: string; issues?: { code: string }[] };
    expect(data.status).not.toBe('ready');
    const codes = (data.issues ?? []).map((i) => i.code);
    expect(codes).toContain('AUTH_REQUIRED');
  });

  it('reports AUTH_REQUIRED with partial credentials', async () => {
    env.mockBackend.setUserSecrets({ TRELLO_API_KEY: 'key-only' });

    const result = await env.mcaClient.callTool('-health-check', {});

    expect(result.success).toBe(true);
    const data = result.result as { status: string; issues?: { code: string }[] };
    const codes = (data.issues ?? []).map((i) => i.code);
    expect(codes).toContain('AUTH_REQUIRED');
  });

  it('handles secrets callback failure gracefully', async () => {
    env.mockBackend.setSecretError(500, 'Backend unavailable');

    const result = await env.mcaClient.callTool('-health-check', {});

    expect(result.success).toBe(true);
    const data = result.result as { status: string; issues?: { code: string }[] };
    expect(data.status).not.toBe('ready');
  });
});

// ─── Tools without credentials ──────────────────────────────────────────────

describe('Tools without credentials', () => {
  beforeEach(() => {
    env.mockBackend.setUserSecrets({});
  });

  it('list-boards fails with auth error, not a crash', async () => {
    const result = await env.mcaClient.callTool('list-boards', {});
    expectToolError(result);
    const msg = typeof result.error === 'string' ? result.error : result.error?.message ?? '';
    expect(msg).not.toContain('Cannot find module');
  });

  it('create-card fails with auth error', async () => {
    const result = await env.mcaClient.callTool('create-card', {
      listId: 'list_123',
      name: 'Test card',
    });
    expectToolError(result);
  });

  it('search fails with auth error', async () => {
    const result = await env.mcaClient.callTool('search', { query: 'test' });
    expectToolError(result);
  });
});

// ─── Input validation ──────────────────────────────────────────────────────

describe('Input validation', () => {
  it('get-board fails without boardId', async () => {
    const result = await env.mcaClient.callTool('get-board', {});
    expectToolError(result);
  });

  it('create-card fails without required listId', async () => {
    const result = await env.mcaClient.callTool('create-card', { name: 'orphan' });
    expectToolError(result);
  });

  it('add-comment fails without required cardId and text', async () => {
    const result = await env.mcaClient.callTool('add-comment', {});
    expectToolError(result);
  });
});

// ─── Event emission ────────────────────────────────────────────────────────

describe('Event emission', () => {
  it('health-check does not emit unexpected events', async () => {
    env.mockBackend.reset();
    env.mockBackend.setUserSecrets({});
    await env.mcaClient.callTool('-health-check', {});
    const events = env.mockBackend.getReceivedEvents();
    expect(events).toEqual([]);
  });
});
