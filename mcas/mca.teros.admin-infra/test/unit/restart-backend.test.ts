/**
 * restart-backend — unit tests for the respond-immediately contract
 * (task tn_5rQMFMJInmE9piMj, regression of the e33ad2516 rewrite).
 *
 * The regression being pinned here: the rewrite polled GET /admin/port-ownership
 * for up to 90s AFTER POST /admin/restart. This MCA is a child process of the
 * backend and dies mid-poll, so the tool result never reached the agent and
 * the conversation that triggered the restart hung (resume-service only
 * rescues channels that were running when the backend died).
 *
 * New contract:
 *   - exactly THREE HTTP calls: pre-audit, cleanup, restart — never a 4th
 *     (no poll after the POST)
 *   - the handler resolves as soon as the POST returns 200 (fast — no sleeps)
 *   - expectedCommit is ECHOED in the payload, not verified in-call
 *   - the message tells the agent to verify on wake via backend-status
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { adminInfraRestartBackend } from '../../src/tools/admin-infra-restart-backend.js';

type Handler = NonNullable<typeof adminInfraRestartBackend.handler>;
type HandlerArgs = Parameters<Handler>[0];
type HandlerContext = Parameters<Handler>[1];

const SECRETS: Record<string, string> = {
  ADMIN_API_URL: 'http://backend-test:10001',
  ADMIN_API_KEY: 'test-admin-key',
};

const OK_AUDIT = {
  success: true,
  port: 10001,
  listenerPids: [1410434],
  pm2WrapperPid: 1409697,
  listenerDescendsFromPm2: true,
  listenerHasPm2Env: true,
  ok: true,
  reason: 'listener descends from pm2 wrapper',
  checkout: { commit: 'e33ad2516', dirty: false },
};

const OK_CLEANUP = {
  success: true,
  message: 'no foreign listeners on port 10001',
  killed: [] as number[],
};

const OK_RESTART = {
  success: true,
  message: 'Backend restart initiated',
  timestamp: '2026-11-02T08:00:00.000Z',
};

interface RecordedCall {
  path: string;
  method: string;
}

let calls: RecordedCall[] = [];

/**
 * Replace global fetch with a router mock. Every call is recorded and gets a
 * small artificial latency so a "fast response" assertion is meaningful: with
 * the old 2s-interval poll loop, the handler could not resolve quickly.
 */
function mockFetch(
  routes: Record<string, { status?: number; body?: unknown; throw?: Error }>,
  latencyMs = 10,
): void {
  const globalAny = globalThis as unknown as { fetch: typeof fetch };
  globalAny.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const path = url.startsWith(SECRETS.ADMIN_API_URL)
      ? url.slice(SECRETS.ADMIN_API_URL.length)
      : url;
    calls.push({ path, method: init?.method ?? 'GET' });

    await new Promise((r) => setTimeout(r, latencyMs));

    const route = routes[path];
    if (!route) throw new Error(`unexpected fetch in test: ${path}`);
    if (route.throw) throw route.throw;
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

const makeContext = (secrets: Record<string, string>): HandlerContext =>
  ({ getSystemSecrets: async () => secrets }) as unknown as HandlerContext;

const run = (args: HandlerArgs) =>
  adminInfraRestartBackend.handler!(args, makeContext(SECRETS));

beforeEach(() => {
  calls = [];
});

describe('admin-infra-restart-backend — respond-immediately contract', () => {
  it('makes exactly three HTTP calls (pre-audit, cleanup, restart) and never polls after the POST', async () => {
    mockFetch({
      '/admin/port-ownership': { body: OK_AUDIT },
      '/admin/kill-foreign-port': { body: OK_CLEANUP },
      '/admin/restart': { body: OK_RESTART },
    });

    const result = (await run({ confirm: true })) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(calls).toEqual([
      { path: '/admin/port-ownership', method: 'GET' },
      { path: '/admin/kill-foreign-port', method: 'POST' },
      { path: '/admin/restart', method: 'POST' },
    ]);
  });

  it('resolves fast — no sleep/poll loop between the POST and the return', async () => {
    mockFetch({
      '/admin/port-ownership': { body: OK_AUDIT },
      '/admin/kill-foreign-port': { body: OK_CLEANUP },
      '/admin/restart': { body: OK_RESTART },
    });

    const startedAt = Date.now();
    await run({ confirm: true });
    const elapsed = Date.now() - startedAt;

    // 3 mocked calls x 10ms latency ≈ 30ms. The old contract slept ≥2s before
    // the first poll — anything near that fails this bound.
    expect(elapsed).toBeLessThan(500);
  });

  it('message instructs verification on wake: system_resume + backend-status as first action', async () => {
    mockFetch({
      '/admin/port-ownership': { body: OK_AUDIT },
      '/admin/kill-foreign-port': { body: OK_CLEANUP },
      '/admin/restart': { body: OK_RESTART },
    });

    const result = (await run({ confirm: true })) as { message: string };

    expect(result.message).toContain('Backend restart initiated');
    expect(result.message).toContain('system_resume');
    expect(result.message).toContain('admin-infra-backend-status');
  });

  it('echoes expectedCommit in the payload instead of verifying it in-call', async () => {
    mockFetch({
      '/admin/port-ownership': { body: OK_AUDIT },
      '/admin/kill-foreign-port': { body: OK_CLEANUP },
      '/admin/restart': { body: OK_RESTART },
    });

    const result = (await run({ confirm: true, expectedCommit: '  abc1234  ' })) as {
      expectedCommit: string | null;
      message: string;
    };

    // trimmed echo, no in-call verification (only 3 calls — the audit is not
    // re-fetched to compare commits)
    expect(result.expectedCommit).toBe('abc1234');
    expect(result.message).toContain('abc1234');
    expect(calls).toHaveLength(3);
  });

  it('expectedCommit is null when not passed', async () => {
    mockFetch({
      '/admin/port-ownership': { body: OK_AUDIT },
      '/admin/kill-foreign-port': { body: OK_CLEANUP },
      '/admin/restart': { body: OK_RESTART },
    });

    const result = (await run({ confirm: true })) as { expectedCommit: string | null };
    expect(result.expectedCommit).toBeNull();
  });

  it('returns the pre-restart audit and the orphans killed by cleanup', async () => {
    mockFetch({
      '/admin/port-ownership': { body: OK_AUDIT },
      '/admin/kill-foreign-port': { body: { ...OK_CLEANUP, killed: [2503098] } },
      '/admin/restart': { body: OK_RESTART },
    });

    const result = (await run({ confirm: true })) as {
      preRestartAudit: { listenerPids: number[]; ok: boolean; reason: string } | null;
      orphansKilled: number[];
    };

    expect(result.preRestartAudit).toEqual({
      listenerPids: [1410434],
      ok: true,
      reason: 'listener descends from pm2 wrapper',
    });
    expect(result.orphansKilled).toEqual([2503098]);
  });

  it('spreads the restart endpoint response (timestamp reachable at top level)', async () => {
    mockFetch({
      '/admin/port-ownership': { body: OK_AUDIT },
      '/admin/kill-foreign-port': { body: OK_CLEANUP },
      '/admin/restart': { body: OK_RESTART },
    });

    const result = (await run({ confirm: true })) as Record<string, unknown>;

    expect(result.timestamp).toBe(OK_RESTART.timestamp);
    expect(result.restart).toEqual(OK_RESTART);
  });
});

describe('admin-infra-restart-backend — failure paths', () => {
  it('throws when confirm is not true — zero HTTP calls', async () => {
    mockFetch({});
    await expect(run({ confirm: false })).rejects.toThrow(/confirm: true/);
    expect(calls).toHaveLength(0);
  });

  it('throws when ADMIN_API_URL / ADMIN_API_KEY are missing', async () => {
    mockFetch({});
    await expect(
      adminInfraRestartBackend.handler!({ confirm: true }, makeContext({})),
    ).rejects.toThrow(/ADMIN_API_URL and ADMIN_API_KEY/);
    expect(calls).toHaveLength(0);
  });

  it('throws when the pre-audit cannot reach the backend — restart is NOT triggered', async () => {
    mockFetch({
      '/admin/port-ownership': { throw: new Error('ECONNREFUSED') },
    });

    await expect(run({ confirm: true })).rejects.toThrow(/Pre-restart audit failed/);
    // the restart POST must never happen when the audit failed
    expect(calls.map((c) => c.path)).toEqual(['/admin/port-ownership']);
  });

  it('throws when the pre-audit returns a server error — restart is NOT triggered', async () => {
    mockFetch({
      '/admin/port-ownership': { status: 500, body: { error: 'audit blew up' } },
    });

    await expect(run({ confirm: true })).rejects.toThrow(/Pre-restart audit failed/);
    expect(calls.map((c) => c.path)).toEqual(['/admin/port-ownership']);
  });

  it('throws when orphan cleanup fails — restart is NOT triggered', async () => {
    mockFetch({
      '/admin/port-ownership': { body: OK_AUDIT },
      '/admin/kill-foreign-port': { status: 500, body: { message: 'kill failed' } },
    });

    await expect(run({ confirm: true })).rejects.toThrow(/Orphan cleanup step failed/);
    expect(calls.map((c) => c.path)).toEqual(['/admin/port-ownership', '/admin/kill-foreign-port']);
  });

  it('throws when the restart POST itself returns non-200', async () => {
    mockFetch({
      '/admin/port-ownership': { body: OK_AUDIT },
      '/admin/kill-foreign-port': { body: OK_CLEANUP },
      '/admin/restart': { status: 401, body: { error: 'Unauthorized', message: 'bad key' } },
    });

    await expect(run({ confirm: true })).rejects.toThrow(/bad key/);
    expect(calls).toHaveLength(3);
  });
});

describe('admin-infra-restart-backend — tools.json contract', () => {
  it('the generated description announces immediate response + wake verification, not polling', async () => {
    const toolsJson = JSON.parse(
      await Bun.file(new URL('../../tools.json', import.meta.url)).text(),
    ) as { tools: Array<{ name: string; description: string }> };

    const tool = toolsJson.tools.find((t) => t.name === 'admin-infra-restart-backend');
    expect(tool).toBeDefined();

    expect(tool!.description).not.toContain('poll until');
    expect(tool!.description).toContain('returns IMMEDIATELY');
    expect(tool!.description).toContain('system_resume');
    expect(tool!.description).toContain('admin-infra-backend-status');
  });
});
