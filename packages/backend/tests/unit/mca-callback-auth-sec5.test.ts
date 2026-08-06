/**
 * SEC-5 / A6 — MCA callback identity authentication.
 *
 * Before the fix, only /secrets/* verified the per-container callback token; the
 * non-secret routes (/resources, /data, /events, /subscriptions) skipped it and
 * derived userId/appId/mcaId from the forgeable X-App-Id / X-Mca-Id headers and
 * the URL channelId → cross-tenant impersonation for any caller that could reach
 * /mca/callback/.
 *
 * Two layers:
 *   1. authenticateCallback — identity is taken from the VERIFIED container key,
 *      never from the headers. Mutation-checked: dropping the token check makes a
 *      forged request resolve.
 *   2. handleMcaCallbackRoutes — EVERY route rejects a request with no/invalid
 *      token (401). A new route forgetting the check is the drift this catches.
 *
 * The container-manager mock is faithful to the real boundary: a real Map + a
 * timing-safe, length-checked compare (mirrors McaContainerManager.verifyCallbackToken),
 * not a boolean stub.
 */

import { describe, expect, test } from 'bun:test';
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { authenticateCallback, createMcaCallbackRoutes } from '../../src/routes/mca-callback-routes';

function fakeContainerManager(
  tokens: Record<string, string>,
  infos: Record<string, { mcaId: string }> = {},
) {
  const map = new Map(Object.entries(tokens));
  return {
    verifyCallbackToken(key: string, token: string): boolean {
      const expected = map.get(key);
      if (!expected) return false;
      const a = Buffer.from(expected, 'utf8');
      const b = Buffer.from(token, 'utf8');
      if (a.length !== b.length) return false;
      return timingSafeEqual(a, b);
    },
    getInfo(key: string) {
      return infos[key];
    },
    touch() {},
    // biome-ignore lint/suspicious/noExplicitAny: minimal structural fake of McaContainerManager
  } as any;
}

function mockReq(method: string, url: string, headers: Record<string, string>, body?: unknown): IncomingMessage {
  const r = Readable.from([body !== undefined ? JSON.stringify(body) : '']);
  // biome-ignore lint/suspicious/noExplicitAny: augmenting a Readable into an IncomingMessage stub
  const req = r as any;
  req.method = method;
  req.url = url;
  req.headers = headers;
  return req as IncomingMessage;
}

function mockRes() {
  const cap: { status?: number; body?: string } = {};
  // biome-ignore lint/suspicious/noExplicitAny: minimal ServerResponse stub
  const res: any = {
    writeHead(status: number) {
      cap.status = status;
      return res;
    },
    end(data?: string) {
      cap.body = data;
    },
  };
  return { res: res as ServerResponse, cap };
}

// ---------------------------------------------------------------------------
// 1. authenticateCallback
// ---------------------------------------------------------------------------

describe('authenticateCallback (SEC-5 / A6)', () => {
  const cm = fakeContainerManager(
    { app_att: 'tokAtt', 'mca.shared': 'tokShared' },
    { app_att: { mcaId: 'mca.attacker' }, 'mca.shared': { mcaId: 'mca.shared' } },
  );

  test('null without an Authorization header', () => {
    expect(authenticateCallback(mockReq('POST', '/x', { 'x-app-id': 'app_att' }), cm)).toBeNull();
  });

  test('null when a forged X-App-Id has no matching token', () => {
    // attacker holds tokAtt (for app_att) but claims to be app_victim
    const req = mockReq('POST', '/x', { 'x-app-id': 'app_victim', authorization: 'Bearer tokAtt' });
    expect(authenticateCallback(req, cm)).toBeNull();
  });

  test('null with a wrong token even for a real key', () => {
    const req = mockReq('POST', '/x', { 'x-app-id': 'app_att', authorization: 'Bearer WRONG' });
    expect(authenticateCallback(req, cm)).toBeNull();
  });

  test('identity comes from the verified key, not the forged X-Mca-Id header', () => {
    const req = mockReq('POST', '/x', {
      'x-app-id': 'app_att',
      'x-mca-id': 'mca.victim', // forged — must be ignored
      authorization: 'Bearer tokAtt',
    });
    expect(authenticateCallback(req, cm)).toEqual({
      verifiedKey: 'app_att',
      mcaId: 'mca.attacker',
      headerAppId: 'app_att',
    });
  });

  test('shared mode verifies via the X-Mca-Id key', () => {
    const req = mockReq('POST', '/x', { 'x-mca-id': 'mca.shared', authorization: 'Bearer tokShared' });
    const auth = authenticateCallback(req, cm);
    expect(auth?.verifiedKey).toBe('mca.shared');
    expect(auth?.mcaId).toBe('mca.shared');
  });
});

// ---------------------------------------------------------------------------
// 2. handleMcaCallbackRoutes — every route is behind the token
// ---------------------------------------------------------------------------

describe('handleMcaCallbackRoutes rejects unauthenticated callers (SEC-5 / A6)', () => {
  const cm = fakeContainerManager({ app_att: 'tokAtt' }, { app_att: { mcaId: 'mca.attacker' } });
  // db is never reached on the 401 path (auth runs before routing).
  // biome-ignore lint/suspicious/noExplicitAny: only containerManager is exercised here
  const handler = createMcaCallbackRoutes({ containerManager: cm, db: {} } as any);

  const ROUTES = [
    'resources/agents',
    'data/mykey',
    'events',
    'subscriptions/channel',
    'secrets/user',
    'secrets/system',
    'health',
    'auth/error',
  ];

  for (const path of ROUTES) {
    const url = `/mca/callback/ch_abc/${path}`;

    test(`401 without a token: /${path}`, async () => {
      const { res, cap } = mockRes();
      await handler(mockReq('POST', url, { 'x-app-id': 'app_victim' }, {}), res, url);
      expect(cap.status).toBe(401);
    });

    test(`401 with a forged X-App-Id but no valid token for it: /${path}`, async () => {
      const req = mockReq('POST', url, { 'x-app-id': 'app_victim', authorization: 'Bearer tokAtt' }, {});
      const { res, cap } = mockRes();
      await handler(req, res, url);
      expect(cap.status).toBe(401);
    });
  }

  test('503 when containerManager is not configured (fail closed)', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: minimal cfg
    const h = createMcaCallbackRoutes({ db: {} } as any);
    const url = '/mca/callback/ch_abc/events';
    const { res, cap } = mockRes();
    await h(mockReq('POST', url, {}, {}), res, url);
    expect(cap.status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// 3. Authenticated-caller scoping — the NEW authz (mcaId bind + channel bind +
//    /events userId gate). These exercise a VALID token through the handler, so
//    a mutation deleting the new checks turns red (they were unverified before).
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
function fakeDb(apps: Row[] = [], workspaces: Row[] = []) {
  const store: Record<string, Row[]> = { apps, workspaces, mca_data: [] };
  return {
    collection(name: string) {
      const rows = store[name] ?? [];
      return {
        findOne: async (q: Row) => rows.find((row) => Object.entries(q).every(([k, v]) => row[k] === v)) ?? null,
        updateOne: async () => ({ acknowledged: true }),
        deleteOne: async () => ({ deletedCount: 0 }),
      };
    },
    // biome-ignore lint/suspicious/noExplicitAny: structural Db fake for the callback handler
  } as any;
}

describe('authenticated-caller scoping (SEC-5 / A6)', () => {
  test('shared container cannot act as an app of a DIFFERENT mca (forged X-App-Id)', async () => {
    const cm = fakeContainerManager({ 'mca.shared': 'tokShared' }, { 'mca.shared': { mcaId: 'mca.shared' } });
    // app_victim belongs to a different mca (mca.other) — the token is for mca.shared.
    const db = fakeDb(
      [{ appId: 'app_victim', mcaId: 'mca.other', ownerId: 'work_v' }],
      [{ workspaceId: 'work_v', ownerId: 'user_victim' }],
    );
    // biome-ignore lint/suspicious/noExplicitAny: minimal cfg
    const handler = createMcaCallbackRoutes({ containerManager: cm, db } as any);
    const url = '/mca/callback/ch_x/data/somekey';
    const req = mockReq(
      'POST',
      url,
      { 'x-mca-id': 'mca.shared', 'x-app-id': 'app_victim', authorization: 'Bearer tokShared' },
      { action: 'get' },
    );
    const { res, cap } = mockRes();
    await handler(req, res, url);
    // ctx.appId must NOT be set to app_victim (app.mcaId !== verified mcaId) →
    // /data requires an appId → 401. (Mutation: drop `app.mcaId === ctx.mcaId` → 200.)
    expect(cap.status).toBe(401);
  });

  test('rejects a channelId owned by another user (403)', async () => {
    const cm = fakeContainerManager({ app_att: 'tokAtt' }, { app_att: { mcaId: 'mca.attacker' } });
    const db = fakeDb(
      [{ appId: 'app_att', mcaId: 'mca.attacker', ownerId: 'work_att' }],
      [{ workspaceId: 'work_att', ownerId: 'user_att' }],
    );
    const getChannelOwnerUserIdFn = async (ch: string) => (ch === 'ch_victim' ? 'user_victim' : null);
    // biome-ignore lint/suspicious/noExplicitAny: minimal cfg
    const handler = createMcaCallbackRoutes({ containerManager: cm, db, getChannelOwnerUserIdFn } as any);
    const url = '/mca/callback/ch_victim/events';
    const req = mockReq('POST', url, { 'x-app-id': 'app_att', authorization: 'Bearer tokAtt' }, { event: 'x' });
    const { res, cap } = mockRes();
    await handler(req, res, url);
    expect(cap.status).toBe(403);
  });

  test('/events fails closed when no userId resolves (valid token, no X-App-Id)', async () => {
    const cm = fakeContainerManager({ 'mca.shared': 'tokShared' }, { 'mca.shared': { mcaId: 'mca.shared' } });
    const db = fakeDb([], []);
    const getChannelOwnerUserIdFn = async () => 'user_victim'; // channel has an owner
    // biome-ignore lint/suspicious/noExplicitAny: minimal cfg
    const handler = createMcaCallbackRoutes({ containerManager: cm, db, getChannelOwnerUserIdFn } as any);
    const url = '/mca/callback/ch_victim/events';
    // valid token but NO X-App-Id → userId unresolved → must not dispatch as victim.
    const req = mockReq('POST', url, { 'x-mca-id': 'mca.shared', authorization: 'Bearer tokShared' }, { event: 'x' });
    const { res, cap } = mockRes();
    await handler(req, res, url);
    expect(cap.status).toBe(401);
  });
});
