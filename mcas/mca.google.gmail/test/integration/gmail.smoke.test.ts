import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import {
  createMcaTestEnv,
  expectToolError,
  expectToolsExact,
  type McaTestEnvironment,
} from '@teros/mca-testing';

let env: McaTestEnvironment;

beforeAll(async () => {
  env = createMcaTestEnv({ mcaId: 'mca.google.gmail' });
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
      'list-messages',
      'get-message',
      'send-message',
      'reply-message',
      'search-messages',
      'modify-labels',
      'list-drafts',
      'create-draft',
      'delete-draft',
      'update-draft',
      'get-attachment',
      'store-attachment',
      'list-labels',
      'create-label',
      'update-label',
      'delete-label',
      'list-filters',
      'create-filter',
      'delete-filter',
      'start-email-watcher',
      'stop-email-watcher',
      'get-watcher-status',
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

  it('reports AUTH_REQUIRED when no OAuth tokens', async () => {
    env.mockBackend.setSystemSecrets({
      CLIENT_ID: 'test-client-id',
      CLIENT_SECRET: 'test-client-secret',
      REDIRECT_URIS: 'http://localhost/callback',
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

// ─── Error Handling: Missing Credentials ───────────────────────────────────

describe('Error Handling', () => {
  it('list-messages fails with clear error when no credentials', async () => {
    env.mockBackend.setSystemSecrets({});
    env.mockBackend.setUserSecrets({});

    const result = await env.mcaClient.callTool('list-messages', {});

    expectToolError(result);
  });

  it('send-message fails with clear error when no credentials', async () => {
    env.mockBackend.setSystemSecrets({});
    env.mockBackend.setUserSecrets({});

    const result = await env.mcaClient.callTool('send-message', {
      to: 'test@example.com',
      subject: 'Test',
      body: 'Hello',
    });

    expectToolError(result);
  });
});

// ─── Mock-Authenticated Tools ─────────────────────────────────────────────
// Tests that exercise handler code with fake-but-present secrets.
// Tools fail at the external API boundary — asserts structured error, not crash.

describe('Mock-Authenticated Tools', () => {
  beforeEach(() => {
    env.mockBackend.setSystemSecrets({
      CLIENT_ID: 'fake-client-id',
      CLIENT_SECRET: 'fake-client-secret',
      REDIRECT_URIS: 'http://localhost/callback',
    });
    env.mockBackend.setUserSecrets({
      ACCESS_TOKEN: 'fake-access-token',
      EMAIL: 'test@example.com',
    });
  });

  it('list-messages returns structured error with invalid credentials', async () => {
    const result = await env.mcaClient.callTool('list-messages', { maxResults: 1 });
    expectToolError(result);
  }, 30_000);

  it('search-messages returns structured error with invalid credentials', async () => {
    const result = await env.mcaClient.callTool('search-messages', { query: 'test' });
    expectToolError(result);
  }, 30_000);

  it('list-labels returns structured error with invalid credentials', async () => {
    const result = await env.mcaClient.callTool('list-labels', {});
    expectToolError(result);
  }, 30_000);
});

// ─── Input Validation (CORRECT boundaries) ────────────────────────────────

describe('Input Validation', () => {
  it('send-message fails with empty params', async () => {
    const result = await env.mcaClient.callTool('send-message', {});
    expectToolError(result);
  });

  it('get-message fails without messageId', async () => {
    const result = await env.mcaClient.callTool('get-message', {});
    expectToolError(result);
  });

  it('create-draft handles empty body', async () => {
    const result = await env.mcaClient.callTool('create-draft', {});
    expectToolError(result);
  });
});

// ─── Email Watcher ─────────────────────────────────────────────────────────

describe('Email Watcher', () => {
  it('start-email-watcher returns error without callbackUrl', async () => {
    const result = await env.mcaClient.callTool(
      'start-email-watcher',
      { intervalMinutes: 5 },
      { callbackUrl: undefined },
    );

    const data = result.result as { success: boolean; error?: string };
    expect(data.success).toBe(false);
  });

  it('get-watcher-status returns inactive when not started', async () => {
    const result = await env.mcaClient.callTool('get-watcher-status', {});

    expect(result.success).toBe(true);
    const data = result.result as { active: boolean };
    expect(data.active).toBe(false);
  });

  it('stop-email-watcher returns not-active when never started', async () => {
    const result = await env.mcaClient.callTool('stop-email-watcher', {});

    expect(result.success).toBe(true);
    const data = result.result as { success: boolean };
    expect(data.success).toBe(false);
  });
});
