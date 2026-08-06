/**
 * SessionManager tests (TER-456).
 *
 * Red del registro de sesiones WS: createSession/removeSession (la limpieza
 * de userSessions es la base de broadcastToUser — un Set fantasma = broadcast
 * a sockets muertos), multi-sesión por usuario, y la delegación a
 * PubSubService (register/unregister). 0 tests previos.
 *
 * El fanout de broadcastToUser en sí ya está cubierto en
 * pubsub-broadcast.test.ts (con SessionManager mockeado) — aquí va el
 * SessionManager REAL.
 */

import { describe, expect, it, mock } from 'bun:test';
import type { WebSocket } from 'ws';
import { SessionManager } from '../../src/services/session-manager';

function makeWs(): WebSocket {
  return { readyState: 1, send: mock(() => {}) } as unknown as WebSocket;
}

/** Mock fiel del contrato que SessionManager usa de PubSubService. */
function makePubSub() {
  const calls: Array<{ op: 'register' | 'unregister'; args: unknown[] }> = [];
  return {
    calls,
    service: {
      registerSession: (sessionId: string, ws: WebSocket) =>
        calls.push({ op: 'register', args: [sessionId, ws] }),
      unregisterSession: (sessionId: string) => calls.push({ op: 'unregister', args: [sessionId] }),
    } as any,
  };
}

describe('SessionManager.createSession', () => {
  it('returns the exact Session shape and registers it', () => {
    const sm = new SessionManager();
    const ws = makeWs();
    const before = Date.now();
    const session = sm.createSession('user_1' as any, ws);

    expect(session).toEqual({
      sessionId: session.sessionId,
      userId: 'user_1' as any,
      ws,
      connectedAt: expect.any(Date),
      lastActivityAt: expect.any(Date),
    });
    expect(session.sessionId.length).toBeGreaterThan(0);
    expect(session.connectedAt.getTime()).toBeGreaterThanOrEqual(before);

    expect(sm.getSession(session.sessionId)).toBe(session);
    expect(sm.getConnectionCount()).toBe(1);
    expect(sm.getActiveSessions()).toEqual([session.sessionId]);
  });

  it('delegates registration to PubSubService with (sessionId, ws)', () => {
    const sm = new SessionManager();
    const { calls, service } = makePubSub();
    sm.setPubSubService(service);

    const ws = makeWs();
    const session = sm.createSession('user_1' as any, ws);

    expect(calls).toEqual([{ op: 'register', args: [session.sessionId, ws] }]);
  });

  it('without PubSubService wired, does not throw (optional delegation)', () => {
    const sm = new SessionManager();
    expect(() => sm.createSession('user_1' as any, makeWs())).not.toThrow();
  });

  it('generates a distinct sessionId per session', () => {
    const sm = new SessionManager();
    const a = sm.createSession('user_1' as any, makeWs());
    const b = sm.createSession('user_1' as any, makeWs());
    expect(a.sessionId).not.toBe(b.sessionId);
  });
});

describe('SessionManager — multi-session per user', () => {
  it('getUserSessions returns every live session of the user, and only theirs', () => {
    const sm = new SessionManager();
    const a1 = sm.createSession('user_a' as any, makeWs());
    const a2 = sm.createSession('user_a' as any, makeWs());
    const b1 = sm.createSession('user_b' as any, makeWs());

    expect(sm.getUserSessions('user_a' as any).map((s) => s.sessionId).sort()).toEqual(
      [a1.sessionId, a2.sessionId].sort(),
    );
    expect(sm.getUserSessions('user_b' as any).map((s) => s.sessionId)).toEqual([b1.sessionId]);
    expect(sm.getConnectionCount()).toBe(3);
  });

  it('getUserSessions for an unknown user returns []', () => {
    const sm = new SessionManager();
    expect(sm.getUserSessions('ghost' as any)).toEqual([]);
  });

  it('getAllActiveSessions returns every session across users', () => {
    const sm = new SessionManager();
    const a = sm.createSession('user_a' as any, makeWs());
    const b = sm.createSession('user_b' as any, makeWs());
    expect(sm.getAllActiveSessions().map((s) => s.sessionId).sort()).toEqual(
      [a.sessionId, b.sessionId].sort(),
    );
  });
});

describe('SessionManager.removeSession', () => {
  it('removes the session from both maps and unregisters from PubSub', () => {
    const sm = new SessionManager();
    const { calls, service } = makePubSub();
    sm.setPubSubService(service);

    const session = sm.createSession('user_1' as any, makeWs());
    sm.removeSession(session.sessionId);

    expect(sm.getSession(session.sessionId)).toBeUndefined();
    expect(sm.getUserSessions('user_1' as any)).toEqual([]);
    expect(sm.getConnectionCount()).toBe(0);
    expect(calls).toEqual([
      { op: 'register', args: [session.sessionId, session.ws] },
      { op: 'unregister', args: [session.sessionId] },
    ]);
  });

  it('removing one of two sessions keeps the other (broadcastToUser base intact)', () => {
    const sm = new SessionManager();
    const s1 = sm.createSession('user_1' as any, makeWs());
    const s2 = sm.createSession('user_1' as any, makeWs());

    sm.removeSession(s1.sessionId);

    expect(sm.getUserSessions('user_1' as any).map((s) => s.sessionId)).toEqual([s2.sessionId]);
    expect(sm.getSession(s2.sessionId)).toBe(s2);
    expect(sm.getConnectionCount()).toBe(1);
  });

  it('removing the LAST session of a user deletes the userSessions entry entirely', () => {
    const sm = new SessionManager();
    const s1 = sm.createSession('user_1' as any, makeWs());
    sm.removeSession(s1.sessionId);

    // Re-crear una sesión tras el delete del Set: si la entrada no se borró,
    // el Set viejo se reutilizaría — verificamos estado consistente.
    const s2 = sm.createSession('user_1' as any, makeWs());
    expect(sm.getUserSessions('user_1' as any).map((s) => s.sessionId)).toEqual([s2.sessionId]);
  });

  it('unknown sessionId is a no-op: no throw, no unregister call', () => {
    const sm = new SessionManager();
    const { calls, service } = makePubSub();
    sm.setPubSubService(service);

    expect(() => sm.removeSession('sess_ghost')).not.toThrow();
    expect(calls).toEqual([]);
  });

  it('structural invariant: no ghost sessionIds accumulate in the userSessions index', () => {
    // El leak de "sesiones fantasma" no es observable vía la API pública
    // porque getUserSessions filtra undefineds (defensa en capas) — este
    // test fija el invariante INTERNO que evita el crecimiento sin límite.
    const sm = new SessionManager();
    const s1 = sm.createSession('user_1' as any, makeWs());
    const s2 = sm.createSession('user_1' as any, makeWs());

    sm.removeSession(s1.sessionId);
    const index: Map<string, Set<string>> = (sm as any).userSessions;
    expect(Array.from(index.get('user_1' as any)!)).toEqual([s2.sessionId]);

    sm.removeSession(s2.sessionId);
    expect(index.has('user_1' as any)).toBe(false);
  });

  it('double remove of the same session unregisters only once', () => {
    const sm = new SessionManager();
    const { calls, service } = makePubSub();
    sm.setPubSubService(service);

    const session = sm.createSession('user_1' as any, makeWs());
    sm.removeSession(session.sessionId);
    sm.removeSession(session.sessionId);

    const unregisters = calls.filter((c) => c.op === 'unregister');
    expect(unregisters).toEqual([{ op: 'unregister', args: [session.sessionId] }]);
  });
});

describe('SessionManager.updateActivity', () => {
  it('bumps lastActivityAt for an existing session', async () => {
    const sm = new SessionManager();
    const session = sm.createSession('user_1' as any, makeWs());
    const initial = session.lastActivityAt.getTime();

    await new Promise((r) => setTimeout(r, 5));
    sm.updateActivity(session.sessionId);

    expect(sm.getSession(session.sessionId)!.lastActivityAt.getTime()).toBeGreaterThan(initial);
  });

  it('unknown sessionId is a no-op without throwing', () => {
    const sm = new SessionManager();
    expect(() => sm.updateActivity('sess_ghost')).not.toThrow();
  });
});
