/**
 * SSRF-guard tests for the Odoo JSON-RPC client (SEC-4 / M6).
 *
 * BASE_URL is a user-supplied secret. Before the fix, odooJsonRpc called global
 * `fetch(BASE_URL + '/jsonrpc')` with no validation, so BASE_URL=169.254.169.254
 * (cloud metadata) or an internal host turned the Teros server into an SSRF proxy.
 * The fix routes through `safeFetch`, which resolves DNS and rejects loopback /
 * private / link-local addresses and non-allowed ports.
 *
 * The blocked cases assert `safeFetch` throws BEFORE reaching `fetch`
 * (`calls.length === 0`), so reverting to a plain `fetch` turns them red: the
 * request would go through and no `[BLOCKED_*]` error would surface.
 *
 * The `resolveHost` seam injects a fake DNS resolver so tests never touch the
 * network; the literal-IP / internal-hostname cases don't even resolve.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ToolContext } from '@teros/mca-sdk';
import { __setOdooResolveHostForTests, odooJsonRpc } from '../../src/lib/odoo-client';

interface FetchCall {
  url: string;
  method: string;
  body?: string;
}

const calls: FetchCall[] = [];
const originalFetch = globalThis.fetch;

beforeEach(() => {
  calls.length = 0;
  // biome-ignore lint/suspicious/noExplicitAny: fetch monkey-patch in test
  (globalThis as any).fetch = async (input: any, init?: any) => {
    calls.push({
      url: typeof input === 'string' ? input : input.url,
      method: init?.method ?? 'GET',
      body: init?.body,
    });
    return new Response(JSON.stringify({ jsonrpc: '2.0', result: [{ id: 1 }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  __setOdooResolveHostForTests(undefined);
});

function makeContext(secrets: Record<string, string>): ToolContext {
  return {
    execution: { userId: 'u1', appId: 'a1' },
    backend: null,
    requestId: 'req_test',
    getSystemSecrets: async () => ({}),
    getUserSecrets: async () => secrets,
    updateUserSecrets: async () => {},
    getScope: () => 'u1',
    getData: async () => ({ value: null, exists: false }),
    setData: async () => ({ success: true }),
    deleteData: async () => ({ success: true, deleted: false }),
    listData: async () => ({ keys: [] }),
    // biome-ignore lint/suspicious/noExplicitAny: ToolContext is loose in tests
  } as any;
}

const validSecrets = { BASE_URL: 'https://mycompany.odoo.com', DATABASE: 'db1', API_KEY: 'key-abc' };
const searchReq = { service: 'object' as const, model: 'res.partner', method: 'search_read', args: [[]] };

async function expectThrows(secrets: Record<string, string>): Promise<Error> {
  let err: unknown;
  try {
    await odooJsonRpc(makeContext(secrets), searchReq);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(Error);
  return err as Error;
}

describe('odooJsonRpc happy path', () => {
  test('POSTs to <BASE_URL>/jsonrpc through safeFetch and returns the result', async () => {
    __setOdooResolveHostForTests(async () => [{ address: '104.16.0.1' }]);
    const result = await odooJsonRpc(makeContext(validSecrets), searchReq);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://mycompany.odoo.com/jsonrpc');
    expect(calls[0].method).toBe('POST');
    expect(result).toEqual([{ id: 1 }]);
  });

  test('allows Odoo default self-host port 8069', async () => {
    __setOdooResolveHostForTests(async () => [{ address: '104.16.0.1' }]);
    await odooJsonRpc(makeContext({ ...validSecrets, BASE_URL: 'http://erp.example.com:8069' }), searchReq);
    expect(calls[0].url).toBe('http://erp.example.com:8069/jsonrpc');
  });
});

describe('odooJsonRpc SSRF guard', () => {
  test('blocks the cloud metadata IP (169.254.169.254) without reaching fetch', async () => {
    const err = await expectThrows({ ...validSecrets, BASE_URL: 'http://169.254.169.254' });
    expect(err.message).toContain('BLOCKED');
    expect(calls).toHaveLength(0);
  });

  test('blocks an internal/loopback host (localhost)', async () => {
    const err = await expectThrows({ ...validSecrets, BASE_URL: 'https://localhost' });
    expect(err.message).toContain('BLOCKED');
    expect(calls).toHaveLength(0);
  });

  test('blocks a private RFC1918 literal (10.0.0.5)', async () => {
    const err = await expectThrows({ ...validSecrets, BASE_URL: 'http://10.0.0.5' });
    expect(err.message).toContain('BLOCKED');
    expect(calls).toHaveLength(0);
  });

  test('blocks a host that resolves to a private address (DNS rebinding)', async () => {
    __setOdooResolveHostForTests(async () => [{ address: '10.0.0.5' }]);
    const err = await expectThrows({ ...validSecrets, BASE_URL: 'https://rebind.attacker.test' });
    expect(err.message).toContain('BLOCKED');
    expect(calls).toHaveLength(0);
  });

  test('blocks a non-allowed port even on a public host (e.g. :6379 redis)', async () => {
    __setOdooResolveHostForTests(async () => [{ address: '104.16.0.1' }]);
    const err = await expectThrows({ ...validSecrets, BASE_URL: 'http://erp.example.com:6379' });
    expect(err.message).toContain('BLOCKED');
    expect(calls).toHaveLength(0);
  });
});
