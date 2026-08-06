import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import {
  createMcaTestEnv,
  expectToolsExact,
  type McaTestEnvironment,
} from '@teros/mca-testing';

let env: McaTestEnvironment;

beforeAll(async () => {
  env = createMcaTestEnv({ mcaId: 'mca.teros.feedback-admin' });
  await env.start();
}, 120_000);

afterAll(async () => {
  await env.stop();
}, 30_000);

beforeEach(() => {
  env.mockBackend.reset();
});

// ─── Lifecycle ─────────────────────────────────────────────────────────────
// All feedback-admin tools need MongoDB. Without it tool calls hang on the
// driver's 30s serverSelectionTimeout. The lifecycle tier (boot + tool list)
// verifies the MCA starts, registers its tools, and serves the health
// endpoint — the smoke bar. Tool-level regressions (context.execution.userId)
// are covered by unit tests.

describe('Lifecycle', () => {
  it('starts up and reports healthy', async () => {
    const health = await env.mcaClient.health();
    expect(health.status).toBe('ready');
    expect(health.uptime).toBeGreaterThanOrEqual(0);
  });

  it('lists all registered tools', async () => {
    const tools = await env.mcaClient.listTools();
    expectToolsExact(tools, [
      'list-feedback',
      'get-feedback',
      'update-status',
      'set-priority',
      'add-update',
      'get-stats',
    ]);
  });
});

// ─── Event emission ────────────────────────────────────────────────────────

describe('Event emission', () => {
  it('startup does not emit unexpected backend events', async () => {
    const events = env.mockBackend.getReceivedEvents();
    expect(events).toEqual([]);
  });
});
