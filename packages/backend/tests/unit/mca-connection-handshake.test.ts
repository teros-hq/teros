/**
 * McaConnectionManager — handshake WS (TER-456).
 *
 * Red del protocolo de conexión MCA↔backend: pending connections con token
 * efímero, códigos de rechazo 4001-4005, replace de conexión, disconnect y
 * reconexión. Es el handshake cuyo fallo produce el cycle documentado
 * "Connection rejected: no pending connection" / Map stale de los smokes.
 *
 * El fake de WebSocket es FIEL al boundary real de `ws`: readyState muta al
 * cerrar, close(code, reason) registra ambos, los handlers `on()` se disparan
 * con la signature real (`close` recibe reason como Buffer).
 */

import { describe, expect, it } from 'bun:test';
import { McaConnectionManager } from '../../src/services/mca-connection-manager';

// ─────────────────────────────────────────────────────────────────────────────
// Fakes fieles al boundary
// ─────────────────────────────────────────────────────────────────────────────

class FakeWs {
  readyState = 1; // WebSocket.OPEN
  sent: string[] = [];
  closes: Array<{ code: number; reason: string }> = [];
  private handlers = new Map<string, Array<(...args: any[]) => void>>();

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code: code ?? 1000, reason: reason ?? '' });
    this.readyState = 3; // CLOSED — como el ws real tras close
  }

  on(event: string, cb: (...args: any[]) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
  }

  /** Dispara un evento como lo haría el socket real (close → reason Buffer). */
  trigger(event: string, ...args: any[]): void {
    for (const cb of this.handlers.get(event) ?? []) cb(...args);
  }

  lastSentJson(): any {
    return JSON.parse(this.sent[this.sent.length - 1]);
  }
}

function makeDb(grants: Array<{ agentId: string; appId: string }> = []): any {
  return {
    collection: (name: string) => ({
      createIndex: async () => 'idx',
      countDocuments: async () => 0,
      find: (filter: any) => ({
        toArray: async () =>
          name === 'agent_app_access' ? grants.filter((g) => g.appId === filter.appId) : [],
      }),
      findOne: async () => null,
      insertOne: async () => ({}),
      updateOne: async () => ({}),
    }),
  };
}

function makeManager(opts?: { tokenExpiryMs?: number; grants?: Array<{ agentId: string; appId: string }> }) {
  return new McaConnectionManager(makeDb(opts?.grants), {
    tokenExpiryMs: opts?.tokenExpiryMs ?? 30_000,
  });
}

/** Simula la conexión entrante como la dispara el WebSocketServer. */
function connect(manager: McaConnectionManager, appId: string | null, token: string | null): FakeWs {
  const ws = new FakeWs();
  const params = new URLSearchParams();
  if (appId !== null) params.set('appId', appId);
  if (token !== null) params.set('token', token);
  const req = { url: `/mca?${params.toString()}`, headers: { host: 'localhost:10001' } };
  (manager as any).handleConnection(ws, req);
  return ws;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// Handshake feliz
// ─────────────────────────────────────────────────────────────────────────────

describe('handshake — happy path', () => {
  it('valid pending + token → registered, ack sent, pending consumed, event emitted', () => {
    const manager = makeManager();
    const connected: string[] = [];
    manager.on('mca:connected', (appId: string) => connected.push(appId));

    const token = manager.registerPendingConnection('app_1', 'mca.test', 'user_1');
    expect(token.length).toBe(32);

    const ws = connect(manager, 'app_1', token);

    expect(ws.closes).toEqual([]);
    expect(manager.isConnected('app_1')).toBe(true);
    expect(connected).toEqual(['app_1']);

    const ack = JSON.parse(ws.sent[0]);
    expect(ack).toEqual({
      type: 'connection_ack',
      appId: 'app_1',
      serverTime: expect.any(Number),
    });

    // El pending se consume: una segunda conexión con el MISMO token → 4002
    const ws2 = connect(manager, 'app_1', token);
    expect(ws2.closes).toEqual([{ code: 4002, reason: 'No pending connection' }]);
  });

  it('getConnection exposes the registered connection metadata', () => {
    const manager = makeManager();
    const token = manager.registerPendingConnection('app_1', 'mca.test', 'user_1');
    connect(manager, 'app_1', token);

    expect(manager.getConnection('app_1')).toEqual({
      appId: 'app_1',
      connectedAt: expect.any(Number),
      lastPingAt: undefined,
      lastPongAt: undefined,
      status: 'ready',
      subscriptionCount: 0,
    });
    expect(manager.getConnectedAppIds()).toEqual(['app_1']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rechazos 4001-4004
// ─────────────────────────────────────────────────────────────────────────────

describe('handshake — rejections', () => {
  it('missing appId or token → 4001', () => {
    const manager = makeManager();
    expect(connect(manager, null, 'tok').closes).toEqual([
      { code: 4001, reason: 'Missing appId or token' },
    ]);
    expect(connect(manager, 'app_1', null).closes).toEqual([
      { code: 4001, reason: 'Missing appId or token' },
    ]);
  });

  it('no pending connection → 4002 (the documented smoke-cycle code)', () => {
    const manager = makeManager();
    const ws = connect(manager, 'app_ghost', 'whatever');
    expect(ws.closes).toEqual([{ code: 4002, reason: 'No pending connection' }]);
    expect(manager.isConnected('app_ghost')).toBe(false);
  });

  it('token mismatch → 4003, pending stays usable with the right token', () => {
    const manager = makeManager();
    const token = manager.registerPendingConnection('app_1', 'mca.test', 'user_1');

    const bad = connect(manager, 'app_1', 'wrong-token');
    expect(bad.closes).toEqual([{ code: 4003, reason: 'Invalid token' }]);

    // El pending NO se consume con un token inválido — el bueno aún conecta.
    const good = connect(manager, 'app_1', token);
    expect(good.closes).toEqual([]);
    expect(manager.isConnected('app_1')).toBe(true);
  });

  it('expired token → 4004 and the pending is deleted (next attempt → 4002)', async () => {
    const manager = makeManager({ tokenExpiryMs: 0 });
    const token = manager.registerPendingConnection('app_1', 'mca.test', 'user_1');

    await sleep(5); // expiresAt = createdAt + 0 → ya pasado
    const ws = connect(manager, 'app_1', token);
    expect(ws.closes).toEqual([{ code: 4004, reason: 'Token expired' }]);

    const retry = connect(manager, 'app_1', token);
    expect(retry.closes).toEqual([{ code: 4002, reason: 'No pending connection' }]);
  });

  it('double-register invalidates the first token (4003 for token1, OK for token2)', () => {
    const manager = makeManager();
    const token1 = manager.registerPendingConnection('app_1', 'mca.test', 'user_1');
    const token2 = manager.registerPendingConnection('app_1', 'mca.test', 'user_1');
    expect(token1).not.toBe(token2);

    const stale = connect(manager, 'app_1', token1);
    expect(stale.closes).toEqual([{ code: 4003, reason: 'Invalid token' }]);

    const fresh = connect(manager, 'app_1', token2);
    expect(fresh.closes).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Replace, disconnect y reconexión
// ─────────────────────────────────────────────────────────────────────────────

describe('replace and reconnection', () => {
  it('a new valid connection replaces the existing one (old gets 4005)', () => {
    const manager = makeManager();
    const tokenA = manager.registerPendingConnection('app_1', 'mca.test', 'user_1');
    const wsA = connect(manager, 'app_1', tokenA);

    const tokenB = manager.registerPendingConnection('app_1', 'mca.test', 'user_1');
    const wsB = connect(manager, 'app_1', tokenB);

    expect(wsA.closes).toEqual([{ code: 4005, reason: 'Replaced by new connection' }]);
    expect(wsB.closes).toEqual([]);
    expect(manager.isConnected('app_1')).toBe(true);
  });

  it('REGRESSION: the stale close of a REPLACED socket must not evict the live connection', () => {
    // En ws real, close() dispara el evento 'close' de forma ASÍNCRONA: el
    // close del socket A reemplazado llega DESPUÉS de registrar B. Si
    // handleDisconnect borra por appId sin comprobar identidad del socket,
    // B queda huérfana (Map stale: send() → false, setContext → no-op) con
    // su WS perfectamente vivo.
    const manager = makeManager();
    const disconnects: string[] = [];
    manager.on('mca:disconnected', (appId: string) => disconnects.push(appId));

    const tokenA = manager.registerPendingConnection('app_1', 'mca.test', 'user_1');
    const wsA = connect(manager, 'app_1', tokenA);
    const tokenB = manager.registerPendingConnection('app_1', 'mca.test', 'user_1');
    connect(manager, 'app_1', tokenB);

    // Llega el close asíncrono del socket A (reemplazado)
    wsA.trigger('close', 4005, Buffer.from('Replaced by new connection'));

    // La conexión VIVA (B) debe seguir registrada y sin evento disconnected.
    expect(manager.isConnected('app_1')).toBe(true);
    expect(manager.send('app_1', { type: 'ping', serverTime: 1 } as any)).toBe(true);
    expect(disconnects).toEqual([]);
  });

  it('a real disconnect of the LIVE socket evicts it and emits mca:disconnected', () => {
    const manager = makeManager();
    const disconnects: Array<{ appId: string; reason: string }> = [];
    manager.on('mca:disconnected', (appId: string, reason: string) =>
      disconnects.push({ appId, reason }),
    );

    const token = manager.registerPendingConnection('app_1', 'mca.test', 'user_1');
    const ws = connect(manager, 'app_1', token);

    ws.trigger('close', 1006, Buffer.from('container died'));

    expect(manager.isConnected('app_1')).toBe(false);
    expect(disconnects).toEqual([{ appId: 'app_1', reason: 'container died' }]);
  });

  it('reconnection after disconnect: new pending + new socket → connected again', () => {
    const manager = makeManager();
    const token1 = manager.registerPendingConnection('app_1', 'mca.test', 'user_1');
    const ws1 = connect(manager, 'app_1', token1);
    ws1.trigger('close', 1006, Buffer.from(''));
    expect(manager.isConnected('app_1')).toBe(false);

    // El respawn registra un pending nuevo (handshake iniciado por el backend)
    const token2 = manager.registerPendingConnection('app_1', 'mca.test', 'user_1');
    const ws2 = connect(manager, 'app_1', token2);
    expect(ws2.closes).toEqual([]);
    expect(manager.isConnected('app_1')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// send / mensajes entrantes / contexto
// ─────────────────────────────────────────────────────────────────────────────

describe('send', () => {
  it('returns false for unknown appId and for non-OPEN sockets', () => {
    const manager = makeManager();
    expect(manager.send('app_ghost', { type: 'ping', serverTime: 1 } as any)).toBe(false);

    const token = manager.registerPendingConnection('app_1', 'mca.test', 'user_1');
    const ws = connect(manager, 'app_1', token);
    ws.readyState = 3; // socket cerrado por fuera, aún en el Map
    expect(manager.send('app_1', { type: 'ping', serverTime: 1 } as any)).toBe(false);
  });

  it('serialises the exact message to the socket when OPEN', () => {
    const manager = makeManager();
    const token = manager.registerPendingConnection('app_1', 'mca.test', 'user_1');
    const ws = connect(manager, 'app_1', token);

    const ok = manager.send('app_1', { type: 'ping', serverTime: 42 } as any);
    expect(ok).toBe(true);
    expect(ws.lastSentJson()).toEqual({ type: 'ping', serverTime: 42 });
  });
});

describe('incoming messages', () => {
  it('pong updates lastPongAt and status on the connection', () => {
    const manager = makeManager();
    const token = manager.registerPendingConnection('app_1', 'mca.test', 'user_1');
    const ws = connect(manager, 'app_1', token);

    // Shape REAL del protocolo (WsPongSchema): mcaTime es required.
    ws.trigger(
      'message',
      Buffer.from(JSON.stringify({ type: 'pong', mcaTime: Date.now(), status: 'degraded' })),
    );

    const conn = manager.getConnection('app_1')!;
    expect(conn.lastPongAt).toBeGreaterThan(0);
    expect(conn.status).toBe('degraded');
  });

  it('malformed JSON from the MCA is contained (no throw, connection stays)', () => {
    const manager = makeManager();
    const token = manager.registerPendingConnection('app_1', 'mca.test', 'user_1');
    const ws = connect(manager, 'app_1', token);

    expect(() => ws.trigger('message', Buffer.from('{not json'))).not.toThrow();
    expect(manager.isConnected('app_1')).toBe(true);
  });

  it('event messages are re-emitted as mca:event with the appId attached', () => {
    const manager = makeManager();
    const events: any[] = [];
    manager.on('mca:event', (e: any) => events.push(e));

    const token = manager.registerPendingConnection('app_1', 'mca.test', 'user_1');
    const ws = connect(manager, 'app_1', token);

    // Shape REAL del protocolo (WsMcaEventSchema): eventId/subscriptionId/data required.
    const event = {
      type: 'event',
      eventId: 'evt_1',
      subscriptionId: 'sub_1',
      eventType: 'email.received',
      data: { id: 'm1' },
    };
    ws.trigger('message', Buffer.from(JSON.stringify(event)));

    expect(events).toEqual([{ ...event, appId: 'app_1' }]);
  });
});

describe('setContext / resolveEffectiveAgentId', () => {
  it('setContext stores the agent context; resolve returns it directly', async () => {
    const manager = makeManager();
    const token = manager.registerPendingConnection('app_1', 'mca.test', 'user_1');
    connect(manager, 'app_1', token);

    manager.setContext('app_1', { agentId: 'agent_ctx', channelId: 'ch_1' });
    const connection = (manager as any).connections.get('app_1');
    const resolved = await (manager as any).resolveEffectiveAgentId(connection);
    expect(resolved).toBe('agent_ctx');
  });

  it('without context: single grant resolves to that agent', async () => {
    const manager = makeManager({ grants: [{ agentId: 'agent_only', appId: 'app_1' }] });
    const token = manager.registerPendingConnection('app_1', 'mca.test', 'user_1');
    connect(manager, 'app_1', token);

    const connection = (manager as any).connections.get('app_1');
    expect(await (manager as any).resolveEffectiveAgentId(connection)).toBe('agent_only');
  });

  it('multiple grants: a VALID hint wins, an invalid hint resolves to undefined', async () => {
    const grants = [
      { agentId: 'agent_a', appId: 'app_1' },
      { agentId: 'agent_b', appId: 'app_1' },
    ];
    const manager = makeManager({ grants });
    const token = manager.registerPendingConnection('app_1', 'mca.test', 'user_1');
    connect(manager, 'app_1', token);
    const connection = (manager as any).connections.get('app_1');

    expect(await (manager as any).resolveEffectiveAgentId(connection, 'agent_b')).toBe('agent_b');
    expect(await (manager as any).resolveEffectiveAgentId(connection, 'agent_intruso')).toBeUndefined();
    expect(await (manager as any).resolveEffectiveAgentId(connection)).toBeUndefined();
  });

  it('setContext on an unknown appId is a no-op', () => {
    const manager = makeManager();
    expect(() => manager.setContext('app_ghost', { agentId: 'x' })).not.toThrow();
  });
});

describe('heartbeat — pingAllConnections', () => {
  it('sends ping with serverTime and records lastPingAt on every connection', () => {
    const manager = makeManager();
    const token = manager.registerPendingConnection('app_1', 'mca.test', 'user_1');
    const ws = connect(manager, 'app_1', token);

    (manager as any).pingAllConnections();

    expect(ws.lastSentJson()).toEqual({ type: 'ping', serverTime: expect.any(Number) });
    const conn = (manager as any).connections.get('app_1');
    expect(conn.lastPingAt).toBeGreaterThan(0);
  });

  it('closes a connection with 4006 when the last pong is older than ping+pong timeout', () => {
    const manager = new McaConnectionManager(makeDb(), {
      pingIntervalMs: 100,
      pongTimeoutMs: 50,
    });
    const token = manager.registerPendingConnection('app_1', 'mca.test', 'user_1');
    const ws = connect(manager, 'app_1', token);

    // Simular un ciclo previo de ping/pong ya viejo (>150ms de silencio)
    const conn = (manager as any).connections.get('app_1');
    conn.lastPingAt = Date.now() - 1_000;
    conn.lastPongAt = Date.now() - 1_000;

    (manager as any).pingAllConnections();

    expect(ws.closes).toEqual([{ code: 4006, reason: 'Pong timeout' }]);
  });

  it('a connection with a RECENT pong is pinged again, not closed', () => {
    const manager = new McaConnectionManager(makeDb(), {
      pingIntervalMs: 100,
      pongTimeoutMs: 50,
    });
    const token = manager.registerPendingConnection('app_1', 'mca.test', 'user_1');
    const ws = connect(manager, 'app_1', token);

    const conn = (manager as any).connections.get('app_1');
    conn.lastPingAt = Date.now() - 10;
    conn.lastPongAt = Date.now() - 10;

    (manager as any).pingAllConnections();

    expect(ws.closes).toEqual([]);
    expect(ws.lastSentJson().type).toBe('ping');
  });
});

describe('getStatus', () => {
  it('returns the exact aggregate shape', () => {
    const manager = makeManager();
    const token = manager.registerPendingConnection('app_1', 'mca.test', 'user_1');
    connect(manager, 'app_1', token);

    expect(manager.getStatus()).toEqual({
      connectedCount: 1,
      connections: [
        {
          appId: 'app_1',
          connectedAt: expect.any(Number),
          lastPongAt: undefined,
          status: 'ready',
        },
      ],
    });
  });
});
