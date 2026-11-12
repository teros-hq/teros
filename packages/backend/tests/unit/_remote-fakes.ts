/**
 * Test doubles for the Teros Remote gateway — mirrors the daemon repo's
 * `test/fake-gateway.ts` from the other side of the tunnel:
 *
 *   - InMemoryRemoteDeviceRegistry: the `remote_devices` port without Mongo
 *   - startGatewayServer: a bare node:http server that routes `/ws/remote`
 *     upgrades into a RemoteDeviceGateway (what server-bootstrap does)
 *   - FakeDaemon: a `ws` client that speaks the daemon's half of the protocol
 *     (hello, pong, tool_call → tool_result with the same id, cancel → CANCELLED)
 *
 * Shared by the unit tests and `packages/backend/scripts/remote-gateway-smoke.ts`.
 */
import { createServer, type Server } from 'node:http';
import {
  createRemoteEnvelope,
  REMOTE_PROTOCOL_VERSION,
  type RemoteCancelPayload,
  type RemoteEnvelope,
  type RemoteHelloPayload,
  type RemoteToolCallEnvelope,
  type RemoteToolResultPayload,
} from '@teros/shared';
import { WebSocket } from 'ws';
import type {
  RemoteDevice,
  RemoteDeviceOnlineInput,
  RemoteDeviceRegistry,
} from '../../src/models/remote-devices';
import type {
  RemoteDeviceBinding,
  RemoteDeviceBindingRegistry,
} from '../../src/models/remote-device-bindings';
import type { RemoteDeviceGateway } from '../../src/services/remote-device-gateway';

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class InMemoryRemoteDeviceRegistry implements RemoteDeviceRegistry {
  readonly devices = new Map<string, RemoteDevice>();
  readonly events: Array<{ op: string; deviceId: string; sessionId?: string }> = [];

  async upsertOnline(input: RemoteDeviceOnlineInput): Promise<RemoteDevice> {
    const ts = new Date();
    const existing = this.devices.get(input.deviceId);
    const device: RemoteDevice = {
      ...(existing ?? { deviceId: input.deviceId, name: input.name, createdAt: ts }),
      ownerId: input.ownerId,
      workspaceId: input.workspaceId,
      appId: input.appId,
      tokenHash: input.tokenHash,
      sessionId: input.sessionId,
      status: 'online',
      lastSeenAt: ts,
      hostname: input.hostname,
      name: input.name,
      os: input.os,
      arch: input.arch,
      daemonVersion: input.daemonVersion,
      declaredAllowedRoots: input.declaredAllowedRoots,
      execEnabled: input.execEnabled,
      capabilities: input.capabilities,
      lastError: null,
      updatedAt: ts,
    };
    this.devices.set(input.deviceId, device);
    this.events.push({ op: 'online', deviceId: input.deviceId, sessionId: input.sessionId });
    return device;
  }

  async markOffline(deviceId: string, sessionId: string): Promise<void> {
    const device = this.devices.get(deviceId);
    this.events.push({ op: 'offline', deviceId, sessionId });
    if (device && device.sessionId === sessionId && device.status === 'online') {
      device.status = 'offline';
      device.lastSeenAt = new Date();
      device.updatedAt = device.lastSeenAt;
    }
  }

  async touch(deviceId: string, patch: { lastError?: string | null } = {}): Promise<void> {
    const device = this.devices.get(deviceId);
    this.events.push({ op: 'touch', deviceId });
    if (device) {
      device.lastSeenAt = new Date();
      if (patch.lastError !== undefined) device.lastError = patch.lastError;
    }
  }

  // ---- v1.1.0 keep-alive / TTL plane ----

  async markKeepaliveSent(deviceId: string): Promise<void> {
    const device = this.devices.get(deviceId);
    this.events.push({ op: 'keepalive', deviceId });
    if (device) device.lastKeepaliveAt = new Date();
  }

  async touchUserActivity(deviceId: string, at: Date = new Date()): Promise<void> {
    const device = this.devices.get(deviceId);
    this.events.push({ op: 'user-activity', deviceId });
    if (device && (!device.lastUserActivityAt || at > device.lastUserActivityAt)) {
      device.lastUserActivityAt = at;
    }
  }

  async markStopped(deviceId: string, reason: 'ttl_inactive' | 'revoked' | 'operator'): Promise<void> {
    const device = this.devices.get(deviceId);
    this.events.push({ op: 'stopped', deviceId });
    if (device) {
      device.stoppedAt = new Date();
      device.stoppedReason = reason;
    }
  }

  async listOnline(): Promise<RemoteDevice[]> {
    return [...this.devices.values()].filter((d) => d.status === 'online');
  }

  async getByDeviceId(deviceId: string): Promise<RemoteDevice | null> {
    return this.devices.get(deviceId) ?? null;
  }

  async getByAppId(appId: string): Promise<RemoteDevice | null> {
    return [...this.devices.values()].find((d) => d.appId === appId) ?? null;
  }

  async getByTokenHash(tokenHash: string): Promise<RemoteDevice | null> {
    return [...this.devices.values()].find((d) => d.tokenHash === tokenHash) ?? null;
  }
}

// ---------------------------------------------------------------------------
// HTTP server hosting the gateway
// ---------------------------------------------------------------------------

export interface GatewayServer {
  url: string; // ws://127.0.0.1:<port>/ws/remote
  port: number;
  server: Server;
  close(): Promise<void>;
}

export function startGatewayServer(gateway: RemoteDeviceGateway, port = 0): Promise<GatewayServer> {
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  // Track upgraded sockets: under Bun 1.3.x `server.close()` never invokes its
  // callback while a terminated WebSocket socket is still associated with the
  // server (node:http compat bug) — destroying them first lets teardown finish.
  const upgradedSockets = new Set<import('node:stream').Duplex>();
  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url || '', `http://${request.headers.host}`).pathname;
    if (pathname === '/ws/remote') {
      upgradedSockets.add(socket);
      socket.once('close', () => upgradedSockets.delete(socket));
      gateway.handleUpgrade(request, socket, head);
    } else socket.destroy();
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        url: `ws://127.0.0.1:${actualPort}/ws/remote`,
        port: actualPort,
        server,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of upgradedSockets) socket.destroy();
            upgradedSockets.clear();
            const timer = setTimeout(done, 1_000); // belt and suspenders
            server.close(() => {
              clearTimeout(timer);
              done();
            });
          }),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Fake daemon (tunnel client)
// ---------------------------------------------------------------------------

export type FakeToolHandler = (
  call: RemoteToolCallEnvelope,
  signal: AbortSignal,
) => Promise<RemoteToolResultPayload> | RemoteToolResultPayload;

export interface FakeDaemonOptions {
  url: string;
  key: string;
  deviceId?: string;
  hostname?: string;
  /** Optional display name sent in the hello (mirrors daemon `--name`). */
  name?: string;
  execEnabled?: boolean;
  allowedRoots?: string[];
  capabilities?: string[];
  /** Answers tool_calls; default echoes the arguments back. */
  onToolCall?: FakeToolHandler;
  /** When true the daemon never answers tool_calls (timeout tests). */
  silent?: boolean;
  /** Do not auto-answer backend pings (heartbeat-loss tests). */
  ignorePings?: boolean;
  /** Send something other than hello first (protocol tests). */
  hello?: Partial<RemoteHelloPayload> | null;
  log?: (line: string) => void;
}

/** Default echo handler: `{ echo: arguments, tool }`. */
export const echoHandler: FakeToolHandler = (call) => ({
  success: true,
  result: { tool: call.payload.tool, echo: call.payload.arguments },
  duration: 1,
});

export class FakeDaemon {
  readonly deviceId: string;
  readonly ws: WebSocket;
  readonly received: RemoteEnvelope[] = [];
  readonly inFlight = new Map<string, AbortController>();
  private readonly waiters: Array<{
    match: (e: RemoteEnvelope) => boolean;
    resolve: (e: RemoteEnvelope) => void;
  }> = [];
  private readonly opts: FakeDaemonOptions;
  closed: { code: number; reason: string } | null = null;
  private readonly closedPromise: Promise<{ code: number; reason: string }>;

  constructor(opts: FakeDaemonOptions) {
    this.opts = opts;
    this.deviceId =
      opts.deviceId ?? `dev_${Math.random().toString(16).slice(2, 18).padEnd(16, '0')}`;
    this.ws = new WebSocket(opts.url);
    let resolveClosed!: (v: { code: number; reason: string }) => void;
    this.closedPromise = new Promise((r) => {
      resolveClosed = r;
    });
    this.ws.on('open', () => {
      if (opts.hello === null) return;
      this.send(createRemoteEnvelope('hello', this.helloPayload(opts.hello)));
    });
    this.ws.on('message', (data) => this.onMessage(data.toString()));
    this.ws.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() };
      for (const c of this.inFlight.values()) c.abort();
      resolveClosed(this.closed);
    });
    this.ws.on('error', (err) => opts.log?.(`[daemon] socket error ${err.message}`));
  }

  helloPayload(overrides: Partial<RemoteHelloPayload> = {}): RemoteHelloPayload {
    const execEnabled = this.opts.execEnabled ?? false;
    const hostname = this.opts.hostname ?? 'fake-host';
    return {
      deviceId: this.deviceId,
      key: this.opts.key,
      hostname,
      // Mirror the daemon: always send `name` (falls back to hostname daemon-side).
      name: this.opts.name ?? hostname,
      os: 'linux',
      arch: 'x64',
      daemonVersion: '0.1.0-fake',
      allowedRoots: this.opts.allowedRoots ?? ['/tmp/fake-root'],
      execEnabled,
      capabilities: this.opts.capabilities ?? [
        'read-file',
        'list-files',
        'device-status',
        ...(execEnabled ? ['bash'] : []),
      ],
      maxInFlight: 4,
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      ...overrides,
    };
  }

  send(envelope: RemoteEnvelope): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(envelope));
  }

  /** Resolves on the next envelope matching `match` (or any of the given type). */
  waitFor(
    match: string | ((e: RemoteEnvelope) => boolean),
    timeoutMs = 5_000,
  ): Promise<RemoteEnvelope> {
    const fn = typeof match === 'string' ? (e: RemoteEnvelope) => e.type === match : match;
    const already = this.received.find(fn);
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(`timed out waiting for ${typeof match === 'string' ? match : 'envelope'}`),
          ),
        timeoutMs,
      );
      this.waiters.push({
        match: fn,
        resolve: (e) => {
          clearTimeout(timer);
          resolve(e);
        },
      });
    });
  }

  /** hello_ack or error, whichever the gateway answers first. */
  waitForHandshake(timeoutMs = 5_000): Promise<RemoteEnvelope> {
    return this.waitFor((e) => e.type === 'hello_ack' || e.type === 'error', timeoutMs);
  }

  waitForClose(timeoutMs = 5_000): Promise<{ code: number; reason: string }> {
    return Promise.race([
      this.closedPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('socket did not close in time')), timeoutMs),
      ),
    ]);
  }

  close(code = 1000): void {
    this.ws.close(code);
  }

  terminate(): void {
    this.ws.terminate();
  }

  private onMessage(text: string): void {
    const envelope = JSON.parse(text) as RemoteEnvelope;
    this.received.push(envelope);
    this.opts.log?.(`[daemon] ← ${envelope.type} ${envelope.id}`);
    for (const w of this.waiters.splice(0)) {
      if (w.match(envelope)) w.resolve(envelope);
      else this.waiters.push(w);
    }
    switch (envelope.type) {
      case 'ping':
        if (!this.opts.ignorePings)
          this.send(createRemoteEnvelope('pong', envelope.payload ?? {}, envelope.id));
        break;
      case 'tool_call':
        void this.handleToolCall(envelope as RemoteToolCallEnvelope);
        break;
      case 'cancel': {
        const id = (envelope.payload as RemoteCancelPayload)?.id;
        const controller = id ? this.inFlight.get(id) : undefined;
        if (controller) controller.abort();
        break;
      }
      default:
        break;
    }
  }

  private async handleToolCall(call: RemoteToolCallEnvelope): Promise<void> {
    if (this.opts.silent) return;
    const controller = new AbortController();
    this.inFlight.set(call.id, controller);
    try {
      const handler = this.opts.onToolCall ?? echoHandler;
      const result = await handler(call, controller.signal);
      this.send(createRemoteEnvelope('tool_result', result, call.id));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const cancelled = controller.signal.aborted;
      this.send(
        createRemoteEnvelope<RemoteToolResultPayload>(
          'tool_result',
          {
            success: false,
            duration: 0,
            error: { code: cancelled ? 'CANCELLED' : 'INTERNAL_ERROR', message },
          },
          call.id,
        ),
      );
    } finally {
      this.inFlight.delete(call.id);
    }
  }
}

/** A handler that resolves only when aborted (for cancel tests) — like a long bash. */
export const hangUntilCancelled: FakeToolHandler = (_call, signal) =>
  new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted by cancel')), { once: true });
  });

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}


// ---------------------------------------------------------------------------
// Binding Registry (multi-workspace)
// ---------------------------------------------------------------------------

export class InMemoryRemoteDeviceBindingRegistry implements RemoteDeviceBindingRegistry {
  readonly bindings = new Map<string, RemoteDeviceBinding>(); // key: `${deviceId}:${appId}`

  private key(deviceId: string, appId: string): string {
    return `${deviceId}:${appId}`;
  }

  async upsertBinding(input: {
    deviceId: string;
    appId: string;
    workspaceId: string;
    ownerId: string;
    tokenHash: string;
  }): Promise<RemoteDeviceBinding> {
    const k = this.key(input.deviceId, input.appId);
    const existing = this.bindings.get(k);
    const ts = new Date();
    const binding: RemoteDeviceBinding = {
      deviceId: input.deviceId,
      appId: input.appId,
      workspaceId: input.workspaceId,
      ownerId: input.ownerId,
      tokenHash: input.tokenHash,
      status: 'active',
      boundAt: existing?.boundAt ?? ts,
      updatedAt: ts,
    };
    this.bindings.set(k, binding);
    return binding;
  }

  async revokeBinding(deviceId: string, appId: string): Promise<boolean> {
    const k = this.key(deviceId, appId);
    const b = this.bindings.get(k);
    if (!b || b.status !== 'active') return false;
    b.status = 'revoked';
    b.updatedAt = new Date();
    return true;
  }

  async revokeAllBindings(deviceId: string): Promise<number> {
    let count = 0;
    for (const [k, b] of this.bindings) {
      if (b.deviceId === deviceId && b.status === 'active') {
        b.status = 'revoked';
        b.updatedAt = new Date();
        count++;
      }
    }
    return count;
  }

  async getActiveByDeviceId(deviceId: string): Promise<RemoteDeviceBinding[]> {
    return [...this.bindings.values()].filter(
      (b) => b.deviceId === deviceId && b.status === 'active',
    );
  }

  async getActiveByAppId(appId: string): Promise<RemoteDeviceBinding[]> {
    return [...this.bindings.values()].filter(
      (b) => b.appId === appId && b.status === 'active',
    );
  }

  async getBinding(deviceId: string, appId: string): Promise<RemoteDeviceBinding | null> {
    return this.bindings.get(this.key(deviceId, appId)) ?? null;
  }

  async hasActiveBinding(deviceId: string): Promise<boolean> {
    return [...this.bindings.values()].some(
      (b) => b.deviceId === deviceId && b.status === 'active',
    );
  }
}
