/**
 * RemoteDeviceGateway — the backend end of the Teros Remote tunnel
 * (docs/specs/remote/teros-remote.md § Architecture, § Protocol, REQ-4/5/9).
 *
 * Daemons dial OUT to `/ws/remote` (no inbound ports on the machine, ever).
 * This gateway:
 *
 *   - accepts the upgrade (noServer mode, routed from server-bootstrap like /mca)
 *   - validates `hello.key` against the app instance's stored user secret
 *     (`RemoteKeyResolver` → AuthManager), upserts `remote_devices` and answers
 *     `hello_ack` with a sessionId; a bad key gets `error UNAUTHORIZED` + close
 *   - keeps the tunnel alive with JSON ping/pong in both directions and marks
 *     the device offline when the socket closes or ~3 heartbeats go unanswered
 *   - `dispatch()` sends a `tool_call` and settles on the correlated
 *     `tool_result`; TIMEOUT after the call budget, CANCELLED on AbortSignal,
 *     MACHINE_UNREACHABLE when no tunnel is up (with reconnect guidance), BUSY
 *     past the per-device in-flight cap
 *
 * Never throws for expected tunnel conditions — every failure is a structured
 * `RemoteToolResultPayload` so the executor can surface it like any other MCA
 * error. Transport is the `ws` package, same as McaConnectionManager.
 */

import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  createRemoteEnvelope,
  isRemoteEnvelope,
  REMOTE_DEFAULT_CALL_TIMEOUT_MS,
  REMOTE_HEARTBEAT_INTERVAL_MS,
  type RemoteCancelPayload,
  type RemoteEnvelope,
  type RemoteError,
  RemoteErrorCode,
  RemoteHealthUpdatePayloadSchema,
  type RemoteHelloAckPayload,
  type RemoteHelloPayload,
  RemoteHelloPayloadSchema,
  type RemoteKeepalivePayload,
  RemoteLogPayloadSchema,
  type RemotePingPayload,
  type RemoteStopAckPayload,
  type RemoteStopPayload,
  type RemoteToolCallPayload,
  type RemoteToolResultPayload,
  RemoteToolResultPayloadSchema,
} from '@teros/shared';
import { type RawData, WebSocket, WebSocketServer } from 'ws';
import { createLogger } from '../lib/logger';
import {
  newRemoteSessionId,
  type RemoteDevice,
  type RemoteDeviceRegistry,
} from '../models/remote-devices';
import type { RemoteDeviceBindingRegistry } from '../models/remote-device-bindings';
import { hashRemoteKey, type RemoteKeyResolution, type RemoteKeyResolver } from './remote-device-key-resolver';

const log = createLogger('RemoteDeviceGateway');

/** WebSocket close codes used by the gateway (4xxx = application-defined). */
export const REMOTE_CLOSE_CODES = {
  HELLO_TIMEOUT: 4001,
  SUPERSEDED: 4002,
  UNAUTHORIZED: 4003,
  HEARTBEAT_LOST: 4004,
  /** v1.1.0 keep-alive/TTL: backend ordered a clean stop (inactivity TTL). */
  STOPPED_BY_BACKEND: 4005,
  SHUTDOWN: 1001,
  BAD_HELLO: 4400,
} as const;

/** Guidance surfaced with MACHINE_UNREACHABLE (spec REQ-9 / AC-5). */
export const MACHINE_UNREACHABLE_HINT =
  'The paired machine is not connected to Teros. On that machine run `teros-remote status` to check the daemon, ' +
  '`teros-remote reconnect` to force a reconnect, or `teros-remote start` if it is not running. ' +
  'If the key was rotated or revoked, run `teros-remote pair` again and paste the new key into the Teros Remote app.';

export interface RemoteDispatchTarget {
  /** Route on the bound app instance (what the executor knows) … */
  appId?: string;
  /** … or on the device id directly. */
  deviceId?: string;
}

export interface RemoteDispatchCall {
  tool: string;
  arguments: Record<string, unknown>;
  /** Overrides the gateway default (30s). */
  timeoutMs?: number;
  /** Aborting sends `cancel` to the daemon and settles the call as CANCELLED. */
  signal?: AbortSignal;
}

export interface RemoteDeviceGatewayOptions {
  registry: RemoteDeviceRegistry;
  /** Multi-workspace: bindings registry for N:M device↔app relationships */
  bindingRegistry?: RemoteDeviceBindingRegistry;
  resolveKey: RemoteKeyResolver;
  /**
   * T-REM-5: resolve a workspace's display name for the hello_ack
   * ("Paired with workspace X"). Optional — when absent the ack carries no
   * workspaceName and old daemons are unaffected.
   */
  getWorkspaceName?: (workspaceId: string) => Promise<string | null>;
  /** Default per-call budget (default 30 000 ms). */
  defaultCallTimeoutMs?: number;
  /** JSON ping cadence towards the daemon (default 20 000 ms). */
  heartbeatIntervalMs?: number;
  /** Silent heartbeats before the socket is terminated (default 3 → ~60s, NFR-3). */
  heartbeatMissLimit?: number;
  /** A socket that has not sent `hello` within this budget is closed (default 10 000 ms). */
  helloTimeoutMs?: number;
  /** Per-device in-flight cap at the backend; beyond it calls fail BUSY (default 36 = daemon cap 4 + queue 32). */
  maxInFlightPerDevice?: number;
  /** How long a cancelled call waits for the daemon's CANCELLED result before settling locally (default 1 500 ms). */
  cancelGraceMs?: number;
  /**
   * Transfer plane (v0.7.0, REQ-14): transfer.* envelopes from the daemon are
   * routed to this handler (RemoteTransferService) instead of the tool-call
   * path. Return true when the message was consumed.
   */
  onTransferMessage?: (appId: string, envelope: RemoteEnvelope) => boolean;
  /** Directory plane (v0.8.0): dir.op envelopes (volume manifest / delete) — async, answers with dir.result. */
  onDirOp?: (appId: string, envelope: RemoteEnvelope) => Promise<void>;
}

interface PendingCall {
  id: string;
  tool: string;
  startedAt: number;
  resolve: (result: RemoteToolResultPayload) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
  cancelled: boolean;
}

interface DeviceConnection {
  ws: WebSocket;
  sessionId: string;
  deviceId: string;
  /** Primary app (first resolution) — kept for backward compat with transfer/dir handlers */
  appId: string;
  ownerId: string;
  workspaceId: string;
  /** All app bindings resolved from the hello key (multi-workspace) */
  bindings: RemoteKeyResolution[];
  hello: RemoteHelloPayload;
  lastActivity: number;
  missedHeartbeats: number;
  pingSeq: number;
  inFlight: Map<string, PendingCall>;
}

export interface RemoteDeviceGatewayEvents {
  'device:online': (device: RemoteDevice) => void;
  'device:offline': (info: { deviceId: string; appId: string; reason: string }) => void;
}

export class RemoteDeviceGateway extends EventEmitter {
  private wss: WebSocketServer | null = null;
  private readonly byDevice = new Map<string, DeviceConnection>();
  private readonly byApp = new Map<string, DeviceConnection>();
  private readonly pendingHello = new Map<WebSocket, ReturnType<typeof setTimeout>>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private readonly opts: Required<Omit<RemoteDeviceGatewayOptions, 'getWorkspaceName' | 'onTransferMessage' | 'onDirOp' | 'bindingRegistry'>> & Pick<RemoteDeviceGatewayOptions, 'getWorkspaceName' | 'onTransferMessage' | 'onDirOp' | 'bindingRegistry'>;

  constructor(options: RemoteDeviceGatewayOptions) {
    super();
    this.opts = {
      defaultCallTimeoutMs: REMOTE_DEFAULT_CALL_TIMEOUT_MS,
      heartbeatIntervalMs: REMOTE_HEARTBEAT_INTERVAL_MS,
      heartbeatMissLimit: 3,
      helloTimeoutMs: 10_000,
      maxInFlightPerDevice: 36,
      cancelGraceMs: 1_500,
      ...options,
    };
  }

  // ==========================================================================
  // LIFECYCLE
  // ==========================================================================

  /** Create the `ws` server (noServer mode — upgrades are routed in by handleUpgrade). */
  initWebSocketServer(): void {
    if (this.wss) return;
    this.closed = false;
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));
    this.heartbeatTimer = setInterval(() => this.heartbeatTick(), this.opts.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
    log.info(
      { heartbeatIntervalMs: this.opts.heartbeatIntervalMs },
      'Remote device gateway initialized (/ws/remote)',
    );
  }

  /** Called from the HTTP server's `upgrade` handler for `/ws/remote`. */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.wss || this.closed) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.wss!.emit('connection', ws, request);
    });
  }

  /** Settle every in-flight call, close every tunnel and stop the server. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    for (const timer of this.pendingHello.values()) clearTimeout(timer);
    this.pendingHello.clear();
    const connections = [...this.byDevice.values()];
    for (const conn of connections) {
      this.settleAll(conn, 'gateway shutting down');
      this.closeSocket(conn.ws, REMOTE_CLOSE_CODES.SHUTDOWN, 'gateway shutting down');
      await this.detach(conn, 'gateway shutting down');
    }
    const wss = this.wss;
    this.wss = null;
    if (wss) {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  }

  // ==========================================================================
  // QUERIES
  // ==========================================================================

  isDeviceOnline(deviceId: string): boolean {
    return this.byDevice.has(deviceId);
  }

  isAppOnline(appId: string): boolean {
    return this.byApp.has(appId);
  }

  /** Hello-declared facts about a connected device (for permission prose / device-status). */
  getConnectedDevice(target: RemoteDispatchTarget): {
    deviceId: string;
    appId: string;
    sessionId: string;
    hello: RemoteHelloPayload;
    inFlight: number;
    /** Workspace the paired app instance belongs to (directory transfers resolve volumePath against it). */
    workspaceId: string;
  } | null {
    const conn = this.lookup(target);
    if (!conn) return null;
    return {
      deviceId: conn.deviceId,
      appId: conn.appId,
      sessionId: conn.sessionId,
      hello: conn.hello,
      inFlight: conn.inFlight.size,
      workspaceId: conn.workspaceId,
    };
  }

  /** Number of tool calls awaiting a result on a device. */
  inFlightCount(target: RemoteDispatchTarget): number {
    return this.lookup(target)?.inFlight.size ?? 0;
  }

  listOnline(): Array<{ deviceId: string; appId: string; sessionId: string }> {
    return [...this.byDevice.values()].map((c) => ({
      deviceId: c.deviceId,
      appId: c.appId,
      sessionId: c.sessionId,
    }));
  }

  // ==========================================================================
  // DISPATCH
  // ==========================================================================

  /**
   * Send a `tool_call` down the tunnel and await its `tool_result`.
   * Resolves (never rejects) with the daemon's payload or a gateway-made
   * structured error: MACHINE_UNREACHABLE, BUSY, TIMEOUT, CANCELLED.
   *
   * T-REM-7: when no tunnel is up, the failure is enriched with a diagnostic
   * (`details.diagnostic` = device_offline | device_unknown | session_dead),
   * the device name and a humanized "last seen X min ago" so the LLM — and
   * the channel notifier — can tell the user exactly what to run on the
   * machine (`teros-remote start` / `pair` / `status`).
   */
  async dispatch(
    target: RemoteDispatchTarget,
    call: RemoteDispatchCall,
  ): Promise<RemoteToolResultPayload> {
    const conn = this.lookup(target);
    if (!conn) {
      // Lazy import to avoid a cycle: remote-offline-diagnosis imports the
      // gateway's `failure()` helper.
      const { diagnoseUnreachable, buildUnreachableError } = await import(
        './remote-offline-diagnosis'
      );
      const diagnosis = await diagnoseUnreachable(this.opts.registry, target);
      return buildUnreachableError(diagnosis, target);
    }
    if (call.signal?.aborted) {
      return Promise.resolve(failure('CANCELLED', 'Tool call was cancelled before it was sent.'));
    }
    if (conn.inFlight.size >= this.opts.maxInFlightPerDevice) {
      return Promise.resolve(
        failure(
          'BUSY',
          `Device has ${conn.inFlight.size} calls in flight (cap ${this.opts.maxInFlightPerDevice}).`,
          'Retry shortly.',
        ),
      );
    }

    const timeoutMs = call.timeoutMs ?? this.opts.defaultCallTimeoutMs;
    const payload: RemoteToolCallPayload = {
      tool: call.tool,
      arguments: call.arguments,
      timeoutMs,
    };
    const envelope = createRemoteEnvelope('tool_call', payload);

    return new Promise<RemoteToolResultPayload>((resolve) => {
      const pending: PendingCall = {
        id: envelope.id,
        tool: call.tool,
        startedAt: Date.now(),
        resolve,
        cancelled: false,
        signal: call.signal,
        timer: setTimeout(() => {
          if (!conn.inFlight.has(envelope.id)) return;
          // Best-effort: tell the daemon to stop; its late result (if any) is dropped.
          this.sendCancel(conn, envelope.id, 'backend timeout');
          this.settle(
            conn,
            pending,
            failure(
              'TIMEOUT',
              `No result from the remote machine within ${timeoutMs}ms.`,
              'The machine may be slow or the tunnel dropped mid-call. Retry; for long commands pass a larger timeout.',
              { timeoutMs },
            ),
          );
        }, timeoutMs),
      };
      if (call.signal) {
        pending.onAbort = () => this.cancel(conn, pending, 'aborted by caller');
        call.signal.addEventListener('abort', pending.onAbort, { once: true });
      }
      conn.inFlight.set(envelope.id, pending);

      if (!this.send(conn.ws, envelope)) {
        this.settle(
          conn,
          pending,
          failure(
            'MACHINE_UNREACHABLE',
            'The tunnel to the remote machine closed while sending the call.',
            MACHINE_UNREACHABLE_HINT,
          ),
        );
      }
    });
  }

  /** Cancel an in-flight call by envelope id (returns false when unknown). */
  cancelCall(target: RemoteDispatchTarget, callId: string, reason = 'cancelled'): boolean {
    const conn = this.lookup(target);
    const pending = conn?.inFlight.get(callId);
    if (!conn || !pending) return false;
    this.cancel(conn, pending, reason);
    return true;
  }

  // ==========================================================================
  // KEEP-ALIVE / TTL PLANE (v1.1.0)
  // ==========================================================================

  /**
   * Send a `keepalive` down a device's tunnel (daily renewal while the user is
   * active). Returns false when no tunnel is up — the caller (keepalive
   * service) simply skips; the daemon reconnects on its own.
   */
  sendKeepalive(
    target: RemoteDispatchTarget,
    payload: Omit<RemoteKeepalivePayload, 'sentAt'> & { sentAt?: string },
  ): boolean {
    const conn = this.lookup(target);
    if (!conn) return false;
    const body: RemoteKeepalivePayload = {
      sentAt: payload.sentAt ?? new Date().toISOString(),
      ttlMs: payload.ttlMs,
      ...(payload.lastUserActivityAt ? { lastUserActivityAt: payload.lastUserActivityAt } : {}),
    };
    return this.send(conn.ws, createRemoteEnvelope('keepalive', body));
  }

  /**
   * Order a clean shutdown: `stop` down the tunnel, then close the socket with
   * STOPPED_BY_BACKEND. The daemon answers `stop_ack` (best-effort) and exits
   * without reconnecting. If the daemon is gone (machine off), the close still
   * releases the binding — and the daemon's own keepalive watchdog covers the
   * machine-asleep case when it comes back.
   */
  sendStop(target: RemoteDispatchTarget, payload: RemoteStopPayload): boolean {
    const conn = this.lookup(target);
    if (!conn) return false;
    const sent = this.send(conn.ws, createRemoteEnvelope('stop', payload));
    if (!sent) return false;
    this.settleAll(conn, `stopped by backend (${payload.reason})`);
    this.closeSocket(conn.ws, REMOTE_CLOSE_CODES.STOPPED_BY_BACKEND, `stopped by backend: ${payload.reason}`);
    // detach() runs from the socket 'close' event; terminate() guarantees it
    // fires even if the peer is already gone.
    conn.ws.terminate();
    return true;
  }

  private cancel(conn: DeviceConnection, pending: PendingCall, reason: string): void {
    if (pending.cancelled || !conn.inFlight.has(pending.id)) return;
    pending.cancelled = true;
    this.sendCancel(conn, pending.id, reason);
    // Give the daemon a moment to answer CANCELLED (it aborts the process group
    // and reports partial output); settle locally if it does not.
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      if (conn.inFlight.has(pending.id)) {
        this.settle(conn, pending, failure('CANCELLED', `Tool call cancelled (${reason}).`));
      }
    }, this.opts.cancelGraceMs);
  }

  private sendCancel(conn: DeviceConnection, id: string, reason: string): void {
    const payload: RemoteCancelPayload = { id, reason };
    this.send(conn.ws, createRemoteEnvelope('cancel', payload));
  }

  private settle(
    conn: DeviceConnection,
    pending: PendingCall,
    result: RemoteToolResultPayload,
  ): void {
    if (!conn.inFlight.delete(pending.id)) return;
    clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort)
      pending.signal.removeEventListener('abort', pending.onAbort);
    pending.resolve(result);
  }

  private settleAll(conn: DeviceConnection, reason: string): void {
    for (const pending of [...conn.inFlight.values()]) {
      this.settle(
        conn,
        pending,
        failure(
          'MACHINE_UNREACHABLE',
          `The tunnel to the remote machine dropped mid-call (${reason}).`,
          MACHINE_UNREACHABLE_HINT,
          { tool: pending.tool },
        ),
      );
    }
  }

  // ==========================================================================
  // CONNECTION HANDLING
  // ==========================================================================

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const remote = req.socket?.remoteAddress ?? 'unknown';
    log.debug({ remote }, 'Daemon connected, awaiting hello');

    const helloTimer = setTimeout(() => {
      this.pendingHello.delete(ws);
      log.warn({ remote }, 'No hello within budget — closing');
      this.closeSocket(ws, REMOTE_CLOSE_CODES.HELLO_TIMEOUT, 'hello timeout');
    }, this.opts.helloTimeoutMs);
    helloTimer.unref?.();
    this.pendingHello.set(ws, helloTimer);

    let conn: DeviceConnection | null = null;

    ws.on('message', (data: RawData) => {
      const envelope = this.parse(data);
      if (!envelope) {
        log.debug({ remote }, 'Ignoring malformed frame');
        return;
      }
      if (conn) {
        conn.lastActivity = Date.now();
        conn.missedHeartbeats = 0;
        this.onAuthenticatedMessage(conn, envelope);
        return;
      }
      if (envelope.type !== 'hello') {
        log.debug({ remote, type: envelope.type }, 'Frame before hello ignored');
        return;
      }
      // Stop the hello timer; the async auth below owns the socket from here on.
      const timer = this.pendingHello.get(ws);
      if (timer) clearTimeout(timer);
      this.pendingHello.delete(ws);
      void this.onHello(ws, envelope).then((established) => {
        if (established) conn = established;
      });
    });

    ws.on('close', (code, reason) => {
      const timer = this.pendingHello.get(ws);
      if (timer) clearTimeout(timer);
      this.pendingHello.delete(ws);
      if (conn) {
        const c = conn;
        conn = null;
        const why = `socket closed (${code}${reason?.length ? `, ${reason.toString()}` : ''})`;
        this.settleAll(c, why);
        void this.detach(c, why);
      }
    });

    ws.on('error', (err) => {
      log.warn({ err, remote, deviceId: conn?.deviceId }, 'Daemon socket error');
    });
  }

  private async onHello(ws: WebSocket, envelope: RemoteEnvelope): Promise<DeviceConnection | null> {
    const parsed = RemoteHelloPayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) {
      log.warn(
        { issues: parsed.error.issues.map((i) => i.path.join('.')) },
        'Malformed hello — closing',
      );
      this.send(
        ws,
        createRemoteEnvelope<RemoteError>(
          'error',
          {
            code: RemoteErrorCode.INVALID_ARGUMENTS,
            message: 'Malformed hello payload.',
            hint: `Missing or invalid: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
          },
          envelope.id,
        ),
      );
      this.closeSocket(ws, REMOTE_CLOSE_CODES.BAD_HELLO, 'malformed hello');
      return null;
    }
    const hello = parsed.data;
    const tokenHash = hashRemoteKey(hello.key);

    let resolutions: RemoteKeyResolution[] = [];
    try {
      resolutions = await this.opts.resolveKey(hello.key, { deviceId: hello.deviceId, tokenHash });
    } catch (err) {
      log.error({ err, deviceId: hello.deviceId }, 'Key resolution failed');
    }

    if (resolutions.length === 0) {
      // T-REM-5: distinguish a key that was revoked in Teros from one that has
      // simply not been pasted yet — the daemon shows revoked as a real error
      // ("run pair --new-key") while 'not registered' is the normal wait state.
      let revoked = false;
      try {
        const known = await this.opts.registry.getByTokenHash(tokenHash);
        revoked = known?.status === 'revoked';
      } catch (err) {
        log.warn({ err, deviceId: hello.deviceId }, 'Revocation check failed — treating as not registered');
      }
      log.warn(
        { deviceId: hello.deviceId, hostname: hello.hostname, revoked },
        revoked ? 'hello rejected: key revoked' : 'hello rejected: key not registered',
      );
      this.send(
        ws,
        createRemoteEnvelope<RemoteError>(
          'error',
          revoked
            ? {
                code: RemoteErrorCode.UNAUTHORIZED,
                message: 'Device key was revoked in Teros.',
                hint: 'Run `teros-remote pair --new-key` on the machine and paste the new key into the Teros Remote app instance (TEROS_REMOTE_KEY).',
              }
            : {
                code: RemoteErrorCode.UNAUTHORIZED,
                message: 'Device key not registered.',
                hint: 'Paste the key printed by `teros-remote pair` into the Teros Remote app instance (TEROS_REMOTE_KEY). If it was revoked, pair again.',
              },
          envelope.id,
        ),
      );
      this.closeSocket(ws, REMOTE_CLOSE_CODES.UNAUTHORIZED, 'unauthorized');
      return null;
    }

    if (ws.readyState !== WebSocket.OPEN) return null; // went away while we were resolving

    // One tunnel per device: a reconnect supersedes the previous socket for
    // the same device (its in-flight calls are settled as unreachable).
    // Multi-workspace: we do NOT evict by appId — multiple apps can share the
    // same device tunnel. Eviction is only for the same device reconnecting.
    const staleByDevice = this.byDevice.get(hello.deviceId);
    if (staleByDevice && staleByDevice.ws !== ws) {
      log.info(
        { deviceId: staleByDevice.deviceId, sessionId: staleByDevice.sessionId },
        'Superseding previous tunnel for device',
      );
      this.settleAll(staleByDevice, 'superseded by a new connection');
      this.detachFromMaps(staleByDevice);
      this.closeSocket(staleByDevice.ws, REMOTE_CLOSE_CODES.SUPERSEDED, 'superseded');
    }
    // Use the first resolution as the primary (backward compat for single-binding)
    const primary = resolutions[0]!;

    const sessionId = newRemoteSessionId();
    const conn: DeviceConnection = {
      ws,
      sessionId,
      deviceId: hello.deviceId,
      appId: primary.appId,
      ownerId: primary.ownerId,
      workspaceId: primary.workspaceId,
      bindings: resolutions,
      hello,
      lastActivity: Date.now(),
      missedHeartbeats: 0,
      pingSeq: 0,
      inFlight: new Map(),
    };
    this.byDevice.set(conn.deviceId, conn);
    // Multi-workspace: register ALL app bindings → same tunnel
    for (const binding of resolutions) {
      this.byApp.set(binding.appId, conn);
    }

    let device: RemoteDevice | null = null;
    try {
      device = await this.opts.registry.upsertOnline({
        deviceId: hello.deviceId,
        ownerId: primary.ownerId,
        workspaceId: primary.workspaceId,
        appId: primary.appId,
        tokenHash,
        sessionId,
        hostname: hello.hostname,
        name: hello.name ?? hello.hostname,
        os: hello.os,
        arch: hello.arch,
        daemonVersion: hello.daemonVersion,
        declaredAllowedRoots: hello.allowedRoots,
        execEnabled: hello.execEnabled,
        capabilities: hello.capabilities,
      });
    } catch (err) {
      // The tunnel is still usable; the registry catches up on the next touch.
      log.error({ err, deviceId: hello.deviceId }, 'Failed to upsert remote_devices on hello');
    }

    // Multi-workspace: upsert a binding for EVERY resolved app (idempotent)
    if (this.opts.bindingRegistry) {
      for (const res of resolutions) {
        try {
          await this.opts.bindingRegistry.upsertBinding({
            deviceId: hello.deviceId,
            appId: res.appId,
            workspaceId: res.workspaceId,
            ownerId: res.ownerId,
            tokenHash,
          });
        } catch (err) {
          log.warn({ err, deviceId: hello.deviceId, appId: res.appId }, 'Failed to upsert binding');
        }
      }
    }

    // T-REM-5: tell the daemon which workspace it paired with (additive).
    let workspaceName: string | undefined;
    if (this.opts.getWorkspaceName) {
      try {
        workspaceName = (await this.opts.getWorkspaceName(primary.workspaceId)) ?? undefined;
      } catch (err) {
        log.warn({ err, workspaceId: primary.workspaceId }, 'Workspace name lookup failed — ack goes without it');
      }
    }

    // Multi-workspace: resolve workspace names for all bindings
    const bindingInfos: Array<{ appId: string; workspaceName?: string }> = [];
    for (const res of resolutions) {
      let wsName: string | undefined;
      if (this.opts.getWorkspaceName) {
        try {
          wsName = (await this.opts.getWorkspaceName(res.workspaceId)) ?? undefined;
        } catch {
          // best-effort
        }
      }
      bindingInfos.push({ appId: res.appId, ...(wsName ? { workspaceName: wsName } : {}) });
    }

    const ack: RemoteHelloAckPayload = {
      sessionId,
      deviceId: hello.deviceId,
      serverTime: new Date().toISOString(),
      heartbeatIntervalMs: this.opts.heartbeatIntervalMs,
      message: resolutions.length === 1
        ? `Paired with ${primary.appName}`
        : `Paired with ${resolutions.length} workspaces: ${bindingInfos.map(b => b.workspaceName ?? b.appId).join(', ')}`,
      workspaceId: primary.workspaceId,
      ...(workspaceName ? { workspaceName } : {}),
      bindings: bindingInfos,
    };
    this.send(ws, createRemoteEnvelope('hello_ack', ack, envelope.id));
    log.info(
      {
        deviceId: hello.deviceId,
        appId: primary.appId,
        bindings: resolutions.length,
        hostname: hello.hostname,
        os: hello.os,
        execEnabled: hello.execEnabled,
        sessionId,
      },
      'Device online',
    );
    if (device) this.emit('device:online', device);
    return conn;
  }

  private onAuthenticatedMessage(conn: DeviceConnection, envelope: RemoteEnvelope): void {
    // Transfer plane (v0.7.0): dedicated messages bypass the tool-call path.
    if (envelope.type.startsWith('transfer.') && this.opts.onTransferMessage?.(conn.appId, envelope)) {
      return;
    }
    // Directory plane (v0.8.0): dir.op is answered by the transfer service.
    if (envelope.type === 'dir.op' && this.opts.onDirOp) {
      void this.opts.onDirOp(conn.appId, envelope);
      return;
    }
    switch (envelope.type) {
      case 'ping': {
        const payload = (envelope.payload ?? {}) as RemotePingPayload;
        this.send(conn.ws, createRemoteEnvelope('pong', payload, envelope.id));
        break;
      }
      case 'pong':
        break; // liveness already recorded by the caller
      case 'tool_result':
        this.onToolResult(conn, envelope);
        break;
      case 'health_update': {
        const parsed = RemoteHealthUpdatePayloadSchema.safeParse(envelope.payload);
        void this.opts.registry
          .touch(conn.deviceId, parsed.success ? { lastError: parsed.data.lastError } : {})
          .catch((err) => log.warn({ err, deviceId: conn.deviceId }, 'registry.touch failed'));
        break;
      }
      case 'log': {
        const parsed = RemoteLogPayloadSchema.safeParse(envelope.payload);
        if (parsed.success) {
          const level = parsed.data.level === 'error' ? 'warn' : parsed.data.level;
          log[level]({ deviceId: conn.deviceId }, `[daemon] ${parsed.data.message}`);
        }
        break;
      }
      case 'hello':
        // Already authenticated on this socket — the daemon only re-hellos on a
        // fresh socket, so this is noise.
        log.debug(
          { deviceId: conn.deviceId },
          'Duplicate hello on an authenticated tunnel ignored',
        );
        break;
      case 'stop_ack': {
        // v1.1.0: the daemon confirmed the backend-ordered stop and is exiting.
        const parsed = envelope.payload as Partial<RemoteStopAckPayload>;
        log.info(
          { deviceId: conn.deviceId, reason: parsed?.reason, exiting: parsed?.exiting },
          'Daemon confirmed backend-ordered stop (stop_ack)',
        );
        break;
      }
      case 'keepalive':
        // Backend→daemon message echoed back or forged — nothing to act on.
        log.debug({ deviceId: conn.deviceId }, 'Unexpected keepalive from daemon ignored');
        break;
      default:
        log.debug(
          { deviceId: conn.deviceId, type: envelope.type },
          'Unexpected message type from daemon',
        );
    }
  }

  private onToolResult(conn: DeviceConnection, envelope: RemoteEnvelope): void {
    const pending = conn.inFlight.get(envelope.id);
    if (!pending) {
      log.debug(
        { deviceId: conn.deviceId, id: envelope.id },
        'tool_result for unknown/settled call ignored',
      );
      return;
    }
    const parsed = RemoteToolResultPayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) {
      this.settle(
        conn,
        pending,
        failure('INTERNAL_ERROR', 'The daemon returned a malformed tool_result.', undefined, {
          issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        }),
      );
      return;
    }
    this.settle(conn, pending, parsed.data);
    void this.opts.registry
      .touch(conn.deviceId)
      .catch((err) => log.warn({ err, deviceId: conn.deviceId }, 'registry.touch failed'));
  }

  /** Remove a connection from both lookup maps (all app slots). */
  private detachFromMaps(conn: DeviceConnection): void {
    if (this.byDevice.get(conn.deviceId) === conn) this.byDevice.delete(conn.deviceId);
    for (const binding of conn.bindings) {
      if (this.byApp.get(binding.appId) === conn) this.byApp.delete(binding.appId);
    }
    // Also clean the primary appId in case bindings array was modified
    if (this.byApp.get(conn.appId) === conn) this.byApp.delete(conn.appId);
  }

  private async detach(conn: DeviceConnection, reason: string): Promise<void> {
    this.detachFromMaps(conn);
    log.info(
      { deviceId: conn.deviceId, appId: conn.appId, bindings: conn.bindings.length, sessionId: conn.sessionId, reason },
      'Device offline',
    );
    try {
      await this.opts.registry.markOffline(conn.deviceId, conn.sessionId);
    } catch (err) {
      log.warn({ err, deviceId: conn.deviceId }, 'registry.markOffline failed');
    }
    this.emit('device:offline', { deviceId: conn.deviceId, appId: conn.appId, reason });
  }

  // ==========================================================================
  // HEARTBEAT
  // ==========================================================================

  private heartbeatTick(): void {
    const now = Date.now();
    for (const conn of [...this.byDevice.values()]) {
      const silentFor = now - conn.lastActivity;
      if (silentFor > this.opts.heartbeatIntervalMs * this.opts.heartbeatMissLimit) {
        log.warn(
          { deviceId: conn.deviceId, silentMs: silentFor },
          'Heartbeat lost — terminating tunnel',
        );
        this.settleAll(conn, 'heartbeat lost');
        this.closeSocket(conn.ws, REMOTE_CLOSE_CODES.HEARTBEAT_LOST, 'heartbeat lost');
        // 'close' fires detach(); terminate() makes sure it does even if the peer is gone.
        conn.ws.terminate();
        continue;
      }
      const payload: RemotePingPayload = {
        seq: ++conn.pingSeq,
        sentAt: new Date(now).toISOString(),
      };
      this.send(conn.ws, createRemoteEnvelope('ping', payload));
    }
  }

  // ==========================================================================
  // TRANSPORT HELPERS
  // ==========================================================================

  private lookup(target: RemoteDispatchTarget): DeviceConnection | null {
    if (target.deviceId) return this.byDevice.get(target.deviceId) ?? null;
    if (target.appId) return this.byApp.get(target.appId) ?? null;
    return null;
  }

  private parse(data: RawData): RemoteEnvelope | null {
    let text: string;
    try {
      text =
        typeof data === 'string'
          ? data
          : Buffer.isBuffer(data)
            ? data.toString('utf8')
            : Buffer.from(data as ArrayBuffer).toString('utf8');
    } catch {
      return null;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
    return isRemoteEnvelope(value) ? value : null;
  }

  /** Transfer plane (v0.7.0): late-bind the transfer handler (the service is built after the gateway). */
  setTransferHandler(handler: (appId: string, envelope: RemoteEnvelope) => boolean): void {
    this.opts.onTransferMessage = handler;
  }

  /** Directory plane (v0.8.0): late-bind the dir.op handler. */
  setDirOpHandler(handler: (appId: string, envelope: RemoteEnvelope) => Promise<void>): void {
    this.opts.onDirOp = handler;
  }

  /**
   * Send an envelope down a device's tunnel (transfer plane + tests).
   * Returns false when no tunnel is up or the socket is closing.
   */
  sendEnvelope(target: RemoteDispatchTarget, envelope: RemoteEnvelope): boolean {
    const conn = this.lookup(target);
    if (!conn) return false;
    return this.send(conn.ws, envelope);
  }

  private send(ws: WebSocket, envelope: RemoteEnvelope): boolean {
    if (ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(envelope));
      return true;
    } catch (err) {
      log.warn({ err, type: envelope.type }, 'send failed');
      return false;
    }
  }

  private closeSocket(ws: WebSocket, code: number, reason: string): void {
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
        ws.close(code, reason.slice(0, 120));
    } catch {
      // already closed
    }
  }
}

/** Build a gateway-side failure payload (duration 0 — nothing ran on the machine). */
export function failure(
  code: keyof typeof RemoteErrorCode,
  message: string,
  hint?: string,
  details?: Record<string, unknown>,
): RemoteToolResultPayload {
  return {
    success: false,
    duration: 0,
    error: { code, message, ...(hint ? { hint } : {}), ...(details ? { details } : {}) },
  };
}
