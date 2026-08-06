import { describe, expect, test } from 'bun:test';
import type { ToolContext } from '@teros/mca-sdk';
import { healthCheck } from '../../src/tools/health-check';

/** Minimal ToolContext exposing only what the health-check handler reads. */
function ctx(secrets: Record<string, string>): ToolContext {
  return { getUserSecrets: async () => secrets } as unknown as ToolContext;
}

type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Run `fn` with `globalThis.fetch` temporarily replaced, always restoring it. */
async function withGlobalFetch(stub: FetchFn, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = stub as unknown as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

const TOKEN = { MAKE_API_TOKEN: 'tok-abc', MAKE_REGION: 'eu1' };

interface HealthResult {
  status: 'ready' | 'degraded' | 'not_ready';
  issues?: Array<{ code: string; message: string; action?: { type: string } }>;
  version?: string;
  uptime?: number;
}

async function run(secrets: Record<string, string>): Promise<HealthResult> {
  return (await healthCheck.handler({}, ctx(secrets))) as HealthResult;
}

describe('mca.make health-check', () => {
  test('no token → ready (webhook-only mode is fully usable), no issues, version+uptime set', async () => {
    const res = await run({});
    expect(res.status).toBe('ready');
    expect(res.issues).toBeUndefined();
    expect(res.version).toBe('2.0.0');
    expect(typeof res.uptime).toBe('number');
  });

  test('token + 200 from /users/me → ready, no issues', async () => {
    await withGlobalFetch(
      (async () => new Response('{"id":1}', { status: 200 })),
      async () => {
        const res = await run(TOKEN);
        expect(res.status).toBe('ready');
        expect(res.issues).toBeUndefined();
      },
    );
  });

  test('token + 401 → not_ready with a blocking AUTH_INVALID issue', async () => {
    await withGlobalFetch(
      (async () => new Response('unauthorized', { status: 401 })),
      async () => {
        const res = await run(TOKEN);
        expect(res.status).toBe('not_ready');
        expect(res.issues?.[0]?.code).toBe('AUTH_INVALID');
        expect(res.issues?.[0]?.action?.type).toBe('user_action');
      },
    );
  });

  test('token + 403 → ready (token valid but lacks organization:read scope — NOT AUTH_INVALID)', async () => {
    // BITES: the old code mapped 401||403 → AUTH_INVALID. A scenarios-scoped
    // token gets 403 on /users/me yet is perfectly usable → must stay healthy.
    await withGlobalFetch(
      (async () => new Response('forbidden', { status: 403 })),
      async () => {
        const res = await run(TOKEN);
        expect(res.status).toBe('ready');
        expect(res.issues).toBeUndefined();
      },
    );
  });

  test('token + network failure → degraded with an auto_retry DEPENDENCY_UNAVAILABLE issue', async () => {
    await withGlobalFetch(
      (async () => {
        throw new Error('ECONNREFUSED');
      }),
      async () => {
        const res = await run(TOKEN);
        expect(res.status).toBe('degraded');
        expect(res.issues?.[0]?.code).toBe('DEPENDENCY_UNAVAILABLE');
        expect(res.issues?.[0]?.action?.type).toBe('auto_retry');
      },
    );
  });

  test('invalid MAKE_REGION + token → not_ready CONFIG_INVALID without touching the network', async () => {
    let fetched = false;
    await withGlobalFetch(
      (async () => {
        fetched = true;
        return new Response('{}', { status: 200 });
      }),
      async () => {
        const res = await run({ MAKE_API_TOKEN: 'tok', MAKE_REGION: 'mars1' });
        expect(res.status).toBe('not_ready');
        expect(res.issues?.[0]?.code).toBe('CONFIG_INVALID');
        expect(fetched).toBe(false);
      },
    );
  });
});
