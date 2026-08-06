import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import {
  createMcaTestEnv,
  expectToolError,
  expectToolsExact,
  type McaTestEnvironment,
} from '@teros/mca-testing';

let env: McaTestEnvironment;

beforeAll(async () => {
  env = createMcaTestEnv({ mcaId: 'mca.slack' });
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
      'list-channels',
      'get-channel',
      'create-channel',
      'archive-channel',
      'join-channel',
      'invite-to-channel',
      'send-message',
      'send-thread-reply',
      'list-messages',
      'add-reaction',
      'remove-reaction',
      'list-users',
      'get-user',
      'get-user-presence',
      'upload-file',
      'list-files',
      'search-messages',
      'search-files',
      'get-team-info',
      'update-message',
      'delete-message',
      'get-permalink',
      'schedule-message',
      'list-scheduled-messages',
      'delete-scheduled-message',
      'send-ephemeral',
      'pin-message',
      'unpin-message',
      'list-pins',
      'add-bookmark',
      'remove-bookmark',
      'list-bookmarks',
      'get-file',
      'delete-file',
      'leave-channel',
      'list-channel-members',
      'open-dm',
      'get-user-profile',
      'update-user-profile',
      'set-dnd',
      'end-dnd',
      'get-dnd',
      'get-reactions',
      'get-team-preferences',
      'create-list',
      'update-list',
      'delete-list',
      'get-list',
      'list-list-items',
      'create-list-item',
      'update-list-item',
      'delete-list-item',
      'create-canvas',
      'edit-canvas',
      'delete-canvas',
      'create-channel-canvas',
      'start-stream',
      'append-stream',
      'stop-stream',
      'add-call',
      'end-call',
      'update-call',
      'get-call',
      'add-call-participants',
      'remove-call-participants',
      'rename-channel',
      'set-channel-purpose',
      'set-channel-topic',
      'kick-from-channel',
      'unarchive-channel',
      'mark-channel-read',
      'get-upload-url',
      'complete-upload',
      'share-file-public',
      'revoke-file-public',
      'list-remote-files',
      'add-remote-file',
      'update-remote-file',
      'remove-remote-file',
      'share-remote-file',
      'get-remote-file',
      'send-me-message',
      'unfurl-link',
      'list-user-channels',
      'delete-user-photo',
      'get-user-identity',
      'list-my-reactions',
      'get-team-dnd',
      'star-item',
      'unstar-item',
      'list-stars',
      'list-emoji',
      'add-emoji',
      'remove-emoji',
      'get-access-logs',
      'get-integration-logs',
      'get-team-profile',
      'edit-bookmark',
      'list-list-fields',
      'create-list-field',
      'update-list-field',
      'delete-list-field',
      'list-connect-invites',
      'invite-shared',
      'accept-shared-invite',
      'decline-shared-invite',
      'approve-shared-invite',
      'revoke-auth',
      'list-auth-teams',
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

  it('list-channels returns structured error with invalid credentials', async () => {
    const result = await env.mcaClient.callTool('list-channels', {});
    expectToolError(result);
  }, 30_000);

  it('list-users returns structured error with invalid credentials', async () => {
    const result = await env.mcaClient.callTool('list-users', {});
    expectToolError(result);
  }, 30_000);

  it('search-messages returns structured error with invalid credentials', async () => {
    const result = await env.mcaClient.callTool('search-messages', { query: 'test' });
    expectToolError(result);
  }, 30_000);
});

// ─── Error Handling: Missing Credentials ───────────────────────────────────

describe('Error Handling', () => {
  it('list-channels fails with clear error when no credentials', async () => {
    env.mockBackend.setSystemSecrets({});
    env.mockBackend.setUserSecrets({});

    const result = await env.mcaClient.callTool('list-channels', {});

    expectToolError(result);
  });

  it('send-message fails with clear error when no credentials', async () => {
    env.mockBackend.setSystemSecrets({});
    env.mockBackend.setUserSecrets({});

    const result = await env.mcaClient.callTool('send-message', {
      channel: 'C123',
      text: 'test',
    });

    expectToolError(result);
  });
});

// ─── Input Validation (CORRECT boundaries) ────────────────────────────────

describe('Input Validation', () => {
  it('send-message fails without channel', async () => {
    const result = await env.mcaClient.callTool('send-message', { text: 'test' });
    expectToolError(result);
  });

  it('send-message fails with empty text', async () => {
    const result = await env.mcaClient.callTool('send-message', { channel: 'C123' });
    expectToolError(result);
  });

  it('get-channel fails without channelId', async () => {
    const result = await env.mcaClient.callTool('get-channel', {});
    expectToolError(result);
  });
});
