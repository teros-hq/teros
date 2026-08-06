import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import {
  createMcaTestEnv,
  expectToolError,
  expectToolsExact,
  type McaTestEnvironment,
} from '@teros/mca-testing';

let env: McaTestEnvironment;

beforeAll(async () => {
  env = createMcaTestEnv({ mcaId: 'mca.notion' });
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
      '-health-check',
      'search',
      'get-page',
      'get-page-markdown',
      'create-page',
      'update-page',
      'update-page-markdown',
      'set-page-icon',
      'set-page-cover',
      'duplicate-page',
      'get-database',
      'query-database',
      'create-database',
      'update-database-schema',
      'create-database-item',
      'update-database-item',
      'get-block',
      'get-block-children',
      'get-blocks',
      'append-blocks',
      'update-block',
      'delete-block',
      'create-column-layout',
      'create-advanced-blocks',
      'list-users',
      'get-user',
      'get-me',
      'list-comments',
      'create-comment',
      'update-comment',
      'delete-comment',
      'upload-file',
    ]);
  });

});

// ─── Health Check ──────────────────────────────────────────────────────────

describe('Health Check (-health-check)', () => {
  it('reports SYSTEM_CONFIG_MISSING when CLIENT_ID is missing', async () => {
    env.mockBackend.setSystemSecrets({});
    env.mockBackend.setUserSecrets({});

    const result = await env.mcaClient.callTool('-health-check', {});

    expect(result.success).toBe(true);
    const data = result.result as { status: string; issues?: { code: string }[] };
    expect(data.status).not.toBe('ready');
    const codes = (data.issues ?? []).map((i) => i.code);
    expect(codes).toContain('SYSTEM_CONFIG_MISSING');
  });

  it('reports AUTH_REQUIRED when no user tokens', async () => {
    env.mockBackend.setSystemSecrets({
      CLIENT_ID: 'test-client-id',
      CLIENT_SECRET: 'test-client-secret',
    });
    env.mockBackend.setUserSecrets({});

    const result = await env.mcaClient.callTool('-health-check', {});

    expect(result.success).toBe(true);
    const data = result.result as { status: string; issues?: { code: string }[] };
    expect(data.status).not.toBe('ready');
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

// ─── Event Emission ───────────────────────────────────────────────────────

describe('Event Emission', () => {
  it('health-check does not emit unexpected events', async () => {
    env.mockBackend.reset();
    await env.mcaClient.callTool('-health-check', {});
    const events = env.mockBackend.getReceivedEvents();
    expect(events).toEqual([]);
  });
});

// ─── Secrets Flow ──────────────────────────────────────────────────────────

describe('Secrets Flow', () => {
  it('requests both system and user secrets on health check', async () => {
    env.mockBackend.setSystemSecrets({ CLIENT_ID: 'id', CLIENT_SECRET: 'secret' });
    env.mockBackend.setUserSecrets({});

    await env.mcaClient.callTool('-health-check', {});

    const reqs = env.mockBackend.getSecretRequests();
    const types = reqs.map((r) => r.type);
    expect(types).toContain('system');
    expect(types).toContain('user');
  });
});

// ─── Mock-Authenticated Tools ─────────────────────────────────────────────

describe('Mock-Authenticated Tools', () => {
  beforeEach(() => {
    env.mockBackend.setSystemSecrets({
      CLIENT_ID: 'fake-client-id',
      CLIENT_SECRET: 'fake-client-secret',
    });
    env.mockBackend.setUserSecrets({
      ACCESS_TOKEN: 'fake-access-token',
    });
  });

  it('search returns structured error with invalid credentials', async () => {
    const result = await env.mcaClient.callTool('search', { query: 'test' });
    expectToolError(result);
  }, 30_000);

  it('list-users returns structured error with invalid credentials', async () => {
    const result = await env.mcaClient.callTool('list-users', {});
    expectToolError(result);
  }, 30_000);

  it('get-me returns structured error with invalid credentials', async () => {
    const result = await env.mcaClient.callTool('get-me', {});
    expectToolError(result);
  }, 30_000);
});

// ─── Error Handling: Missing Credentials ───────────────────────────────────

describe('Error Handling', () => {
  it('search fails with clear error when no credentials', async () => {
    env.mockBackend.setSystemSecrets({});
    env.mockBackend.setUserSecrets({});

    const result = await env.mcaClient.callTool('search', { query: 'test' });

    expectToolError(result);
  });

  it('create-page fails with clear error when no credentials', async () => {
    env.mockBackend.setSystemSecrets({});
    env.mockBackend.setUserSecrets({});

    const result = await env.mcaClient.callTool('create-page', {
      parentPageId: '00000000-0000-0000-0000-000000000000',
      title: 'Test',
    });

    expectToolError(result);
  });
});

// ─── Input Validation (CORRECT boundaries) ────────────────────────────────

describe('Input Validation', () => {
  it('create-page fails without parentPageId', async () => {
    const result = await env.mcaClient.callTool('create-page', { title: 'Test' });
    expectToolError(result);
  });

  it('get-page fails without pageId', async () => {
    const result = await env.mcaClient.callTool('get-page', {});
    expectToolError(result);
  });

  it('query-database fails without databaseId', async () => {
    const result = await env.mcaClient.callTool('query-database', {});
    expectToolError(result);
  });
});
