/**
 * admin-api.system-refresh-clients — "Reiniciar todos los browsers" handler.
 *
 * Covers the contract of the deploy-refresh broadcast:
 *   - Privilege gate: role 'user' and unknown callers → FORBIDDEN (a normal
 *     user can NEVER emit the refresh signal); 'admin' and 'super' pass.
 *   - All-clients scope: broadcastToAllSessions is called with the
 *     client.refresh event; response reports sent/totalConnections/uniqueUsers.
 *   - Per-user scope (userId param): broadcastToUser is used instead.
 *   - Param hygiene: reason defaults to 'admin', maxDelayMs defaults to 30000,
 *     out-of-range/negative/NaN maxDelayMs are clamped (<= 300000).
 *   - SERVICE_UNAVAILABLE when PubSubService is not wired.
 *
 * Handlers mocked (no Mongo) — same style as admin-handlers.test.ts.
 */

import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { WsHandlerContext } from '@teros/shared';
import { createSystemRefreshClientsHandler } from '../../src/handlers/domains/admin-api/system';
import type { PubSubService } from '../../src/services/pubsub-service';
import type { Session, SessionManager } from '../../src/services/session-manager';

const ctx = (userId: string): WsHandlerContext =>
  ({ userId, sessionId: 'sess', connectionId: 'conn' }) as any;

/** db fake: users collection resolves role by userId (requireAdmin path). */
function makeDb(users: Record<string, { role: string }>) {
  return {
    collection: (name: string) => ({
      findOne: async (filter: any) => {
        if (name === 'users') return users[filter.userId] ?? null;
        return null;
      },
    }),
  } as any;
}

type FakeWs = { readyState: number; send: ReturnType<typeof mock> };

function makeWs(open = true): FakeWs {
  return { readyState: open ? 1 : 3, send: mock(() => {}) };
}

function makeSession(userId: string, ws: FakeWs): Session {
  return {
    sessionId: `sess_${userId}_${Math.random().toString(36).slice(2, 8)}`,
    userId: userId as any,
    ws: ws as any,
    connectedAt: new Date(),
    lastActivityAt: new Date(),
    lastPingAt: new Date(),
    ip: '127.0.0.1',
    userAgent: 'test',
  };
}

/** SessionManager fake with the three methods the handler reads. */
function makeSessionManager(byUser: Record<string, Session[]>) {
  const all = Object.values(byUser).flat();
  return {
    getUserSessions: mock((userId: string) => byUser[userId] ?? []),
    getConnectionCount: mock(() => all.length),
    getAllActiveSessions: mock(() => all),
  } as unknown as SessionManager;
}

/** PubSubService fake: records broadcast calls. */
function makePubSub() {
  return {
    broadcastToAllSessions: mock((_e: Record<string, unknown>) => 2),
    broadcastToUser: mock((_u: string, _e: Record<string, unknown>) => 0),
  } as unknown as PubSubService;
}

describe('admin-api.system-refresh-clients', () => {
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  // =========================================================================
  // Privilege gate — a normal user can NEVER emit the refresh signal
  // =========================================================================

  it('FORBIDDEN for role user', async () => {
    const db = makeDb({ u: { role: 'user' } });
    const handler = createSystemRefreshClientsHandler(db, null, makePubSub());
    await expect(handler(ctx('u'), {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('FORBIDDEN when caller does not exist (role undefined)', async () => {
    const db = makeDb({});
    const handler = createSystemRefreshClientsHandler(db, null, makePubSub());
    await expect(handler(ctx('ghost'), {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('admin passes the gate', async () => {
    const db = makeDb({ a: { role: 'admin' } });
    const handler = createSystemRefreshClientsHandler(db, null, makePubSub());
    await expect(handler(ctx('a'), {})).resolves.toMatchObject({ success: true });
  });

  it('super passes the gate', async () => {
    const db = makeDb({ s: { role: 'super' } });
    const handler = createSystemRefreshClientsHandler(db, null, makePubSub());
    await expect(handler(ctx('s'), {})).resolves.toMatchObject({ success: true });
  });

  // =========================================================================
  // All-clients broadcast
  // =========================================================================

  it('broadcasts client.refresh to ALL sessions and reports counts', async () => {
    const db = makeDb({ a: { role: 'admin' } });
    const pubsub = makePubSub();
    const sm = makeSessionManager({
      u1: [makeSession('u1', makeWs(true)), makeSession('u1', makeWs(true))],
      u2: [makeSession('u2', makeWs(true))],
    });
    const handler = createSystemRefreshClientsHandler(db, sm, pubsub);

    const result = await handler(ctx('a'), {});

    expect((pubsub as any).broadcastToAllSessions).toHaveBeenCalledTimes(1);
    const event = (pubsub as any).broadcastToAllSessions.mock.calls[0][0] as any;
    expect(event.type).toBe('event');
    expect(event.event).toBe('client.refresh');
    expect(event.data.reason).toBe('admin');
    expect(event.data.maxDelayMs).toBe(30000);
    expect(typeof event.data.issuedAt).toBe('string');
    expect(result).toMatchObject({
      success: true,
      sent: 2, // from the fake broadcastToAllSessions
      totalConnections: 3,
      uniqueUsers: 2,
      scope: 'all',
      reason: 'admin',
      maxDelayMs: 30000,
    });
  });

  it('honours reason and maxDelayMs params', async () => {
    const db = makeDb({ a: { role: 'admin' } });
    const pubsub = makePubSub();
    const handler = createSystemRefreshClientsHandler(db, null, pubsub);

    const result = await handler(ctx('a'), { reason: 'deploy', maxDelayMs: 5000 });

    const event = (pubsub as any).broadcastToAllSessions.mock.calls[0][0] as any;
    expect(event.data.reason).toBe('deploy');
    expect(event.data.maxDelayMs).toBe(5000);
    expect(result).toMatchObject({ reason: 'deploy', maxDelayMs: 5000 });
  });

  it('clamps maxDelayMs: negative → default, over 300000 → 300000, NaN → default', async () => {
    const db = makeDb({ a: { role: 'admin' } });
    const handler = createSystemRefreshClientsHandler(db, null, makePubSub());

    const negative = await handler(ctx('a'), { maxDelayMs: -5 });
    expect(negative).toMatchObject({ maxDelayMs: 30000 });

    const over = await handler(ctx('a'), { maxDelayMs: 999999 });
    expect(over).toMatchObject({ maxDelayMs: 300000 });

    const nan = await handler(ctx('a'), { maxDelayMs: 'not-a-number' });
    expect(nan).toMatchObject({ maxDelayMs: 30000 });
  });

  // =========================================================================
  // Per-user scope
  // =========================================================================

  it('userId param → broadcastToUser, scope user, sent counted from that user sessions', async () => {
    const db = makeDb({ a: { role: 'admin' } });
    const pubsub = makePubSub();
    const sm = makeSessionManager({
      u1: [makeSession('u1', makeWs(true)), makeSession('u1', makeWs(false))],
      u2: [makeSession('u2', makeWs(true))],
    });
    const handler = createSystemRefreshClientsHandler(db, sm, pubsub);

    const result = await handler(ctx('a'), { userId: 'u1' });

    expect((pubsub as any).broadcastToAllSessions).toHaveBeenCalledTimes(0);
    expect((pubsub as any).broadcastToUser).toHaveBeenCalledTimes(1);
    expect((pubsub as any).broadcastToUser.mock.calls[0][0]).toBe('u1');
    const event = (pubsub as any).broadcastToUser.mock.calls[0][1] as any;
    expect(event.event).toBe('client.refresh');
    // sent counts only OPEN sessions of the target user (1 of 2)
    expect(result).toMatchObject({ scope: 'user', sent: 1, uniqueUsers: 2 });
  });

  // =========================================================================
  // Service availability
  // =========================================================================

  it('SERVICE_UNAVAILABLE when PubSubService is not wired', async () => {
    const db = makeDb({ a: { role: 'admin' } });
    const handler = createSystemRefreshClientsHandler(db, null, null);
    await expect(handler(ctx('a'), {})).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });
});
