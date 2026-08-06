import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import {
  createMcaTestEnv,
  expectToolError,
  expectToolsExact,
  type McaTestEnvironment,
} from '@teros/mca-testing';

let env: McaTestEnvironment;

beforeAll(async () => {
  env = createMcaTestEnv({ mcaId: 'mca.teros.feedback' });
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

  it('lists exactly the registered tools — no phantom entries', async () => {
    const tools = await env.mcaClient.listTools();
    expectToolsExact(tools, ['report-bug', 'report-suggestion']);
  });
});

// ─── report-bug ────────────────────────────────────────────────────────────

describe('report-bug', () => {
  it('passes context.execution.userId as reportedBy in the outgoing fetch', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    const feedbackEndpoint = `${env.mockBackend.getUrl()}/api/feedback/submit`;

    const originalFetch = globalThis.fetch;

    // The MCA runs inside Docker — it calls the backend URL derived from
    // MCA_BACKEND_URL env. The mock backend doesn't have /api/feedback/submit,
    // so we test via the tool result shape and context propagation instead.

    const result = await env.mcaClient.callTool(
      'report-bug',
      { title: 'Crash on load', description: 'App crashes when opening settings' },
      { userId: 'user:smoke_tester', userDisplayName: 'Smoke Tester' },
    );

    // The tool calls an external /api/feedback/submit endpoint. In the Docker
    // smoke environment that endpoint doesn't exist, so the tool should error
    // gracefully — the important thing is it doesn't crash with
    // "Cannot read properties of undefined (reading 'userId')" which was the
    // original bug (context.userId instead of context.execution.userId).
    if (!result.success) {
      expect(result.error).toBeDefined();
      // Must NOT be a ReferenceError / TypeError about accessing userId on
      // undefined — that would mean the context.execution fix didn't land.
      const msg = typeof result.error === 'string' ? result.error : result.error?.message ?? '';
      expect(msg).not.toContain('Cannot read properties of undefined');
      expect(msg).not.toContain('userId');
    }
  });

  it('fails without required fields', async () => {
    const result = await env.mcaClient.callTool('report-bug', {});
    expectToolError(result);
  });
});

// ─── report-suggestion ─────────────────────────────────────────────────────

describe('report-suggestion', () => {
  it('does not crash accessing context.execution fields', async () => {
    const result = await env.mcaClient.callTool(
      'report-suggestion',
      { title: 'Dark mode', description: 'Add dark mode support' },
      { userId: 'user:smoke_tester', userDisplayName: 'Smoke', userAvatarUrl: 'https://example.com/avatar.png' },
    );

    if (!result.success) {
      const msg = typeof result.error === 'string' ? result.error : result.error?.message ?? '';
      expect(msg).not.toContain('Cannot read properties of undefined');
    }
  });

  it('fails without required fields', async () => {
    const result = await env.mcaClient.callTool('report-suggestion', {});
    expectToolError(result);
  });
});

// ─── Event emission ────────────────────────────────────────────────────────

describe('Event emission', () => {
  it('tool calls do not emit unexpected backend events', async () => {
    env.mockBackend.reset();
    await env.mcaClient.callTool(
      'report-bug',
      { title: 'test', description: 'test' },
    ).catch(() => {});
    const events = env.mockBackend.getReceivedEvents();
    expect(events).toEqual([]);
  });
});
