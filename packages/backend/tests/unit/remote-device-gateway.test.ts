/**
 * RemoteDeviceGateway — contract with the teros-remote daemon over a real
 * WebSocket (ws client ↔ ws server on an ephemeral port), driven by the
 * FakeDaemon in _remote-fakes.ts (the mirror of the daemon repo's
 * fake-gateway smoke harness).
 *
 * Covers: hello/hello_ack + registry online, UNAUTHORIZED + close on a bad
 * key, malformed hello, ping/pong both directions, dispatch round-trip with
 * id correlation, TIMEOUT, cancel via AbortSignal (daemon CANCELLED and local
 * fallback), BUSY cap, MACHINE_UNREACHABLE when offline, offline on
 * disconnect, mid-call disconnect, supersede on reconnect, heartbeat loss.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { RemoteError, RemoteHelloAckPayload, RemoteToolResultPayload } from '@teros/shared';
import { RemoteDeviceGateway } from '../../src/services/remote-device-gateway';
import {
  hashRemoteKey,
  type RemoteKeyResolver,
} from '../../src/services/remote-device-key-resolver';
import {
  FakeDaemon,
  type GatewayServer,
  hangUntilCancelled,
  InMemoryRemoteDeviceRegistry,
  sleep,
  startGatewayServer,
} from './_remote-fakes';

const GOOD_KEY = 'trsk_good_key_0123456789abcdef0123456789abcdef';
const APP = {
  appId: 'app_remote_1',
  appName: 'My Laptop',
  ownerId: 'user_alice',
  workspaceId: 'work_hq',
};

const resolveKey: RemoteKeyResolver = async (key) => (key === GOOD_KEY ? [{ ...APP }] : []);

let registry: InMemoryRemoteDeviceRegistry;
let gateway: RemoteDeviceGateway;
let server: GatewayServer;
const daemons: FakeDaemon[] = [];

function daemon(opts: Partial<ConstructorParameters<typeof FakeDaemon>[0]> = {}): FakeDaemon {
  const d = new FakeDaemon({ url: server.url, key: GOOD_KEY, ...opts });
  daemons.push(d);
  return d;
}

async function online(
  opts: Partial<ConstructorParameters<typeof FakeDaemon>[0]> = {},
): Promise<FakeDaemon> {
  const d = daemon(opts);
  const ack = await d.waitForHandshake();
  if (ack.type !== 'hello_ack') throw new Error(`expected hello_ack, got ${ack.type}`);
  return d;
}

beforeEach(async () => {
  registry = new InMemoryRemoteDeviceRegistry();
  gateway = new RemoteDeviceGateway({
    registry,
    resolveKey,
    defaultCallTimeoutMs: 300,
    heartbeatIntervalMs: 120,
    heartbeatMissLimit: 3,
    helloTimeoutMs: 400,
    maxInFlightPerDevice: 2,
    cancelGraceMs: 200,
  });
  gateway.initWebSocketServer();
  server = await startGatewayServer(gateway);
});

afterEach(async () => {
  for (const d of daemons.splice(0)) d.terminate();
  await gateway.close();
  await server.close();
});

describe('RemoteDeviceGateway — pairing (hello)', () => {
  it('valid key → hello_ack (same id, sessionId, serverTime) and the device is online in the registry', async () => {
    const d = daemon({ hostname: 'raw', execEnabled: true, allowedRoots: ['/srv'] });
    const ack = await d.waitForHandshake();
    expect(ack.type).toBe('hello_ack');
    const payload = ack.payload as RemoteHelloAckPayload;
    expect(payload.sessionId).toMatch(/^rsess_/);
    expect(payload.deviceId).toBe(d.deviceId);
    expect(Number.isNaN(Date.parse(payload.serverTime!))).toBe(false);
    expect(payload.heartbeatIntervalMs).toBe(120);

    expect(gateway.isDeviceOnline(d.deviceId)).toBe(true);
    expect(gateway.isAppOnline(APP.appId)).toBe(true);
    const rec = registry.devices.get(d.deviceId)!;
    expect(rec.status).toBe('online');
    expect(rec.appId).toBe(APP.appId);
    expect(rec.ownerId).toBe(APP.ownerId);
    expect(rec.workspaceId).toBe(APP.workspaceId);
    expect(rec.tokenHash).toBe(hashRemoteKey(GOOD_KEY));
    expect(rec.hostname).toBe('raw');
    expect(rec.name).toBe('raw'); // daemon fell back to hostname
    expect(rec.execEnabled).toBe(true);
    expect(rec.declaredAllowedRoots).toEqual(['/srv']);
    expect(rec.capabilities).toContain('bash');
    expect(rec.sessionId).toBe(payload.sessionId);
    expect(rec.lastSeenAt).toBeInstanceOf(Date);
  });

  it('hello with explicit name → registry stores it verbatim', async () => {
    const d = daemon({ hostname: 'raw', name: "Alice's Laptop" });
    const ack = await d.waitForHandshake();
    expect(ack.type).toBe('hello_ack');
    const rec = registry.devices.get(d.deviceId)!;
    expect(rec.hostname).toBe('raw');
    expect(rec.name).toBe("Alice's Laptop");
  });

  it('hello without name → registry falls back to hostname', async () => {
    const d = daemon({ hostname: 'my-host', hello: { name: undefined } });
    const ack = await d.waitForHandshake();
    expect(ack.type).toBe('hello_ack');
    const rec = registry.devices.get(d.deviceId)!;
    expect(rec.hostname).toBe('my-host');
    expect(rec.name).toBe('my-host');
  });

  it('ack carries workspaceId + workspaceName (T-REM-5) — old daemons ignore them', async () => {
    await gateway.close();
    await server.close();
    gateway = new RemoteDeviceGateway({
      registry,
      resolveKey,
      defaultCallTimeoutMs: 300,
      heartbeatIntervalMs: 120,
      heartbeatMissLimit: 3,
      helloTimeoutMs: 400,
      maxInFlightPerDevice: 2,
      cancelGraceMs: 200,
      getWorkspaceName: async (workspaceId) => (workspaceId === 'work_hq' ? 'Teros HQ' : null),
    });
    gateway.initWebSocketServer();
    server = await startGatewayServer(gateway);

    const d = daemon();
    const ack = await d.waitForHandshake();
    expect(ack.type).toBe('hello_ack');
    const payload = ack.payload as RemoteHelloAckPayload;
    expect(payload.workspaceId).toBe('work_hq');
    expect(payload.workspaceName).toBe('Teros HQ');
  });

  it('ack without a workspace lookup → no workspaceName (backwards compatible)', async () => {
    const d = daemon();
    const ack = await d.waitForHandshake();
    expect(ack.type).toBe('hello_ack');
    const payload = ack.payload as RemoteHelloAckPayload;
    expect(payload.workspaceId).toBe('work_hq');
    expect(payload.workspaceName).toBeUndefined();
  });

  it('revoked device key → UNAUTHORIZED says revoked (T-REM-5), socket closed 4003', async () => {
    // Register the device as revoked under the hash of the key it will present.
    const revokedKey = 'trsk_revoked_key_0123456789abcdef0123456789a';
    await registry.upsertOnline({
      deviceId: 'dev_revoked',
      ownerId: APP.ownerId,
      workspaceId: APP.workspaceId,
      appId: APP.appId,
      tokenHash: hashRemoteKey(revokedKey),
      sessionId: 'rsess_old',
      hostname: 'old-host',
      name: 'old-host',
      os: 'linux',
      arch: 'x64',
      daemonVersion: '0.3.0',
      declaredAllowedRoots: [],
      execEnabled: false,
      capabilities: [],
    });
    registry.devices.get('dev_revoked')!.status = 'revoked';

    const d = daemon({ key: revokedKey });
    const reply = await d.waitForHandshake();
    expect(reply.type).toBe('error');
    const err = reply.payload as RemoteError;
    expect(err.code).toBe('UNAUTHORIZED');
    expect(err.message.toLowerCase()).toContain('revoked');
    expect(err.hint).toContain('--new-key');
    const closed = await d.waitForClose();
    expect(closed.code).toBe(4003);
  });

  it('unknown key → error UNAUTHORIZED, socket closed 4003, nothing registered', async () => {
    const d = daemon({ key: 'trsk_wrong' });
    const reply = await d.waitForHandshake();
    expect(reply.type).toBe('error');
    const err = reply.payload as RemoteError;
    expect(err.code).toBe('UNAUTHORIZED');
    expect(err.hint).toContain('teros-remote pair');
    const closed = await d.waitForClose();
    expect(closed.code).toBe(4003);
    expect(registry.devices.size).toBe(0);
    expect(gateway.isDeviceOnline(d.deviceId)).toBe(false);
  });

  it('malformed hello (no key) → error INVALID_ARGUMENTS and close', async () => {
    const d = daemon({ hello: { key: undefined as unknown as string } });
    const reply = await d.waitForHandshake();
    expect(reply.type).toBe('error');
    expect((reply.payload as RemoteError).code).toBe('INVALID_ARGUMENTS');
    const closed = await d.waitForClose();
    expect(closed.code).toBe(4400);
  });

  it('a socket that never says hello is closed after the hello budget', async () => {
    const d = daemon({ hello: null });
    const closed = await d.waitForClose(2_000);
    expect(closed.code).toBe(4001);
  });

  it('dispatch before hello is MACHINE_UNREACHABLE (frames before hello are ignored, no crash)', async () => {
    const d = daemon({ hello: null });
    await sleep(50);
    d.send({
      id: 'x',
      type: 'tool_result',
      timestamp: '',
      version: '1.0',
      payload: { success: true, duration: 0 },
    });
    const result = await gateway.dispatch(
      { deviceId: d.deviceId },
      { tool: 'read-file', arguments: {} },
    );
    expect(result.error?.code).toBe('MACHINE_UNREACHABLE');
  });
});

describe('RemoteDeviceGateway — keepalive', () => {
  it('daemon ping → gateway pong with the same id', async () => {
    const d = await online();
    d.send({
      id: 'ping-1',
      type: 'ping',
      timestamp: new Date().toISOString(),
      version: '1.0',
      payload: { seq: 7 },
    });
    const pong = await d.waitFor('pong');
    expect(pong.id).toBe('ping-1');
    expect((pong.payload as { seq?: number }).seq).toBe(7);
  });

  it('gateway pings on its own cadence; the daemon pong keeps the device online', async () => {
    const d = await online();
    await d.waitFor('ping', 1_000);
    await sleep(450); // > 3 missed intervals if pongs were not counted
    expect(gateway.isDeviceOnline(d.deviceId)).toBe(true);
    expect(registry.devices.get(d.deviceId)!.status).toBe('online');
  });

  it('three silent heartbeats → tunnel terminated and device offline', async () => {
    const d = await online({ ignorePings: true });
    const closed = await d.waitForClose(3_000);
    expect(closed.code).toBe(4004);
    await sleep(20);
    expect(gateway.isDeviceOnline(d.deviceId)).toBe(false);
    expect(registry.devices.get(d.deviceId)!.status).toBe('offline');
  });
});

describe('RemoteDeviceGateway — dispatch', () => {
  it('tool_call → tool_result round-trip: same envelope id, payload passed through, routed by appId', async () => {
    const d = await online();
    const result = await gateway.dispatch(
      { appId: APP.appId },
      { tool: 'read-file', arguments: { filePath: '/srv/a.txt' } },
    );
    expect(result.success).toBe(true);
    expect(result.result).toEqual({ tool: 'read-file', echo: { filePath: '/srv/a.txt' } });
    const call = d.received.find((e) => e.type === 'tool_call')!;
    expect(call.payload).toEqual({
      tool: 'read-file',
      arguments: { filePath: '/srv/a.txt' },
      timeoutMs: 300,
    });
    expect(gateway.inFlightCount({ appId: APP.appId })).toBe(0);
    expect(registry.events.some((e) => e.op === 'touch' && e.deviceId === d.deviceId)).toBe(true);
  });

  it('daemon structured errors (FORBIDDEN with roots hint) pass through untouched', async () => {
    await online({
      onToolCall: () => ({
        success: false,
        duration: 2,
        error: { code: 'FORBIDDEN', message: 'outside allowed roots', hint: 'Allowed roots: /srv' },
      }),
    });
    const result = await gateway.dispatch(
      { appId: APP.appId },
      { tool: 'read-file', arguments: { filePath: '/etc/passwd' } },
    );
    expect(result.success).toBe(false);
    expect(result.error).toEqual({
      code: 'FORBIDDEN',
      message: 'outside allowed roots',
      hint: 'Allowed roots: /srv',
    });
    expect(result.duration).toBe(2);
  });

  it('no result within the budget → TIMEOUT, cancel sent to the daemon, in-flight cleared', async () => {
    const d = await online({ silent: true });
    const t0 = Date.now();
    const result = await gateway.dispatch(
      { appId: APP.appId },
      { tool: 'bash', arguments: { command: 'sleep 99' }, timeoutMs: 150 },
    );
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    expect(result.error?.code).toBe('TIMEOUT');
    expect(result.error?.details).toEqual({ timeoutMs: 150 });
    const cancel = await d.waitFor('cancel');
    const call = d.received.find((e) => e.type === 'tool_call')!;
    expect((cancel.payload as { id: string }).id).toBe(call.id);
    expect(gateway.inFlightCount({ appId: APP.appId })).toBe(0);
    expect(gateway.isDeviceOnline(d.deviceId)).toBe(true); // a slow call does not drop the tunnel
  });

  it('AbortSignal → cancel envelope; the daemon answers CANCELLED and that result settles the call', async () => {
    const d = await online({ onToolCall: hangUntilCancelled });
    const controller = new AbortController();
    const pending = gateway.dispatch(
      { appId: APP.appId },
      {
        tool: 'bash',
        arguments: { command: 'sleep 99' },
        signal: controller.signal,
        timeoutMs: 5_000,
      },
    );
    await d.waitFor('tool_call');
    expect(gateway.inFlightCount({ appId: APP.appId })).toBe(1);
    controller.abort();
    const result = await pending;
    expect(result.error?.code).toBe('CANCELLED');
    expect(result.error?.message).toContain('aborted by cancel'); // came from the daemon, not the local fallback
    const cancel = d.received.find((e) => e.type === 'cancel')!;
    expect((cancel.payload as { id: string; reason?: string }).reason).toBe('aborted by caller');
    expect(gateway.inFlightCount({ appId: APP.appId })).toBe(0);
  });

  it('AbortSignal with a daemon that never confirms → settled locally as CANCELLED after the grace period', async () => {
    await online({ silent: true });
    const controller = new AbortController();
    const pending = gateway.dispatch(
      { appId: APP.appId },
      { tool: 'bash', arguments: {}, signal: controller.signal, timeoutMs: 5_000 },
    );
    await sleep(30);
    controller.abort();
    const result = await pending;
    expect(result.error?.code).toBe('CANCELLED');
    expect(result.error?.message).toContain('aborted by caller');
  });

  it('cancelCall(id) cancels by envelope id; already-aborted signal never sends', async () => {
    const d = await online({ onToolCall: hangUntilCancelled });
    const pending = gateway.dispatch(
      { appId: APP.appId },
      { tool: 'bash', arguments: {}, timeoutMs: 5_000 },
    );
    const call = await d.waitFor('tool_call');
    expect(gateway.cancelCall({ appId: APP.appId }, call.id, 'user stop')).toBe(true);
    expect((await pending).error?.code).toBe('CANCELLED');
    expect(gateway.cancelCall({ appId: APP.appId }, call.id)).toBe(false);

    const aborted = new AbortController();
    aborted.abort();
    const before = d.received.length;
    const r = await gateway.dispatch(
      { appId: APP.appId },
      { tool: 'bash', arguments: {}, signal: aborted.signal },
    );
    expect(r.error?.code).toBe('CANCELLED');
    expect(d.received.length).toBe(before);
  });

  it('per-device in-flight cap → BUSY beyond it, while earlier calls still complete', async () => {
    const d = await online({ onToolCall: hangUntilCancelled });
    const a = gateway.dispatch(
      { appId: APP.appId },
      { tool: 'bash', arguments: { n: 1 }, timeoutMs: 5_000 },
    );
    const b = gateway.dispatch(
      { appId: APP.appId },
      { tool: 'bash', arguments: { n: 2 }, timeoutMs: 5_000 },
    );
    await sleep(30);
    expect(gateway.inFlightCount({ deviceId: d.deviceId })).toBe(2);
    const c = await gateway.dispatch({ appId: APP.appId }, { tool: 'bash', arguments: { n: 3 } });
    expect(c.error?.code).toBe('BUSY');
    for (const e of d.received.filter((x) => x.type === 'tool_call'))
      gateway.cancelCall({ appId: APP.appId }, e.id);
    expect((await a).error?.code).toBe('CANCELLED');
    expect((await b).error?.code).toBe('CANCELLED');
  });

  it('concurrent calls are correlated by id even when results arrive out of order', async () => {
    await online({
      onToolCall: async (call) => {
        const n = (call.payload.arguments as { n: number }).n;
        await sleep(n === 1 ? 80 : 10);
        return { success: true, result: { n }, duration: 1 };
      },
    });
    const [r1, r2] = await Promise.all([
      gateway.dispatch({ appId: APP.appId }, { tool: 't', arguments: { n: 1 } }),
      gateway.dispatch({ appId: APP.appId }, { tool: 't', arguments: { n: 2 } }),
    ]);
    expect(r1.result).toEqual({ n: 1 });
    expect(r2.result).toEqual({ n: 2 });
  });

  it('malformed tool_result from the daemon → INTERNAL_ERROR, not a hang', async () => {
    await online({
      onToolCall: () => ({ success: 'yes' }) as unknown as RemoteToolResultPayload,
    });
    const result = await gateway.dispatch({ appId: APP.appId }, { tool: 't', arguments: {} });
    expect(result.error?.code).toBe('INTERNAL_ERROR');
  });
});

describe('RemoteDeviceGateway — offline UX', () => {
  it('no device connected → MACHINE_UNREACHABLE immediately with reconnect guidance', async () => {
    const t0 = Date.now();
    const result = await gateway.dispatch(
      { appId: 'app_nobody' },
      { tool: 'read-file', arguments: {} },
    );
    expect(Date.now() - t0).toBeLessThan(50);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('MACHINE_UNREACHABLE');
    // T-REM-7: the hint is now the actionable one-liner — for an appId with no
    // remote_devices record the diagnostic is device_unknown and the command
    // is `teros-remote pair`.
    expect(result.error?.hint).toContain('teros-remote pair');
    expect(result.error?.hint).toContain('never paired');
    expect(result.error?.details).toMatchObject({
      appId: 'app_nobody',
      diagnostic: 'device_unknown',
    });
  });

  it('disconnect → device offline (lastSeenAt updated) and subsequent calls MACHINE_UNREACHABLE', async () => {
    const d = await online();
    const before = registry.devices.get(d.deviceId)!.lastSeenAt!.getTime();
    await sleep(5);
    d.close(1000);
    await sleep(60);
    expect(gateway.isDeviceOnline(d.deviceId)).toBe(false);
    const rec = registry.devices.get(d.deviceId)!;
    expect(rec.status).toBe('offline');
    expect(rec.lastSeenAt!.getTime()).toBeGreaterThanOrEqual(before);
    const result = await gateway.dispatch(
      { appId: APP.appId },
      { tool: 'read-file', arguments: {} },
    );
    expect(result.error?.code).toBe('MACHINE_UNREACHABLE');
  });

  it('tunnel drop mid-call → in-flight calls settle MACHINE_UNREACHABLE at once (no wait for the timeout)', async () => {
    const d = await online({ onToolCall: hangUntilCancelled });
    const pending = gateway.dispatch(
      { appId: APP.appId },
      { tool: 'bash', arguments: {}, timeoutMs: 10_000 },
    );
    await d.waitFor('tool_call');
    const t0 = Date.now();
    d.terminate();
    const result = await pending;
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(result.error?.code).toBe('MACHINE_UNREACHABLE');
    expect(result.error?.message).toContain('dropped mid-call');
  });

  it('reconnect with the same device supersedes the old tunnel; the stale socket is closed 4002', async () => {
    const first = await online({ deviceId: 'dev_same' });
    const second = await online({ deviceId: 'dev_same' });
    const closed = await first.waitForClose();
    expect(closed.code).toBe(4002);
    await sleep(30);
    expect(gateway.isDeviceOnline('dev_same')).toBe(true);
    const rec = registry.devices.get('dev_same')!;
    expect(rec.status).toBe('online'); // the old session's markOffline must not clobber the new one
    expect(gateway.getConnectedDevice({ deviceId: 'dev_same' })!.sessionId).toBe(rec.sessionId!);
    const result = await gateway.dispatch(
      { appId: APP.appId },
      { tool: 't', arguments: { via: 'second' } },
    );
    expect(result.success).toBe(true);
    expect(second.received.some((e) => e.type === 'tool_call')).toBe(true);
  });

  it('gateway close() settles in-flight calls and marks every device offline', async () => {
    const d = await online({ onToolCall: hangUntilCancelled });
    const pending = gateway.dispatch(
      { appId: APP.appId },
      { tool: 'bash', arguments: {}, timeoutMs: 10_000 },
    );
    await d.waitFor('tool_call');
    await gateway.close();
    expect((await pending).error?.code).toBe('MACHINE_UNREACHABLE');
    expect(registry.devices.get(d.deviceId)!.status).toBe('offline');
    expect(gateway.listOnline()).toEqual([]);
  });
});

// =============================================================================
// T-REM-7 — offline diagnostics
//
// When dispatch() finds no tunnel, the gateway now classifies the failure
// against the registry (device_unknown / session_dead / device_offline) and
// returns an actionable notice: device name, humanized "last seen X min ago",
// and the exact command to run on the machine. The wire code stays
// MACHINE_UNREACHABLE; the nuance travels in `details.diagnostic`.
// =============================================================================
describe('RemoteDeviceGateway — T-REM-7 offline diagnostics', () => {
  it('device_unknown: appId with no remote_devices record → pair guidance', async () => {
    const result = await gateway.dispatch(
      { appId: 'app_never_paired' },
      { tool: 'read-file', arguments: {} },
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('MACHINE_UNREACHABLE');
    expect(result.error?.details).toMatchObject({
      diagnostic: 'device_unknown',
      appId: 'app_never_paired',
    });
    expect(result.error?.message).toContain('never paired');
    expect(result.error?.message).toContain('teros-remote pair');
    // hint mirrors message — the LLM reads either
    expect(result.error?.hint).toBe(result.error?.message);
  });

  it('device_offline: known device, lastSeenAt 12 min ago → humanized notice + start command', async () => {
    // Seed the registry with a device that went offline 12 minutes ago.
    const twelveMinAgo = new Date(Date.now() - 12 * 60_000);
    await registry.upsertOnline({
      deviceId: 'dev_midgar',
      ownerId: APP.ownerId,
      workspaceId: APP.workspaceId,
      appId: APP.appId,
      tokenHash: 'hash',
      sessionId: 'rsess_old',
      hostname: 'midgar.local',
      name: 'midgar',
      os: 'darwin',
      arch: 'arm64',
      daemonVersion: '0.4.0',
      declaredAllowedRoots: [],
      execEnabled: true,
      capabilities: ['bash'],
    });
    await registry.markOffline('dev_midgar', 'rsess_old');
    // Force lastSeenAt to 12 min ago (markOffline just set it to now).
    registry.devices.get('dev_midgar')!.lastSeenAt = twelveMinAgo;

    const result = await gateway.dispatch(
      { appId: APP.appId },
      { tool: 'bash', arguments: { command: 'ls' } },
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('MACHINE_UNREACHABLE');
    expect(result.error?.details).toMatchObject({
      diagnostic: 'device_offline',
      deviceId: 'dev_midgar',
      deviceName: 'midgar',
      lastSeenHuman: '12 min ago',
    });
    expect(result.error?.message).toContain('midgar is offline');
    expect(result.error?.message).toContain('last seen 12 min ago');
    expect(result.error?.message).toContain('teros-remote start');
    expect(result.error?.message).toContain('teros-remote service status');
    expect(result.error?.message).toContain('retry automatically');
  });

  it('session_dead: lastSeenAt < 30s ago → reconnect-in-progress notice, no spam command', async () => {
    await registry.upsertOnline({
      deviceId: 'dev_flapping',
      ownerId: APP.ownerId,
      workspaceId: APP.workspaceId,
      appId: APP.appId,
      tokenHash: 'hash',
      sessionId: 'rsess_old',
      hostname: 'flapping',
      name: 'flapping',
      os: 'linux',
      arch: 'x64',
      daemonVersion: '0.4.0',
      declaredAllowedRoots: [],
      execEnabled: false,
      capabilities: [],
    });
    await registry.markOffline('dev_flapping', 'rsess_old');
    // markOffline just set lastSeenAt = now → age < 30s → session_dead

    const result = await gateway.dispatch(
      { appId: APP.appId },
      { tool: 'read-file', arguments: {} },
    );
    expect(result.success).toBe(false);
    expect(result.error?.details?.diagnostic).toBe('session_dead');
    expect(result.error?.message).toContain('reconnect in progress');
    expect(result.error?.message).toContain('teros-remote status');
  });

  it('device_offline with no lastSeenAt (legacy record) → notice without the "last seen" clause', async () => {
    await registry.upsertOnline({
      deviceId: 'dev_legacy',
      ownerId: APP.ownerId,
      workspaceId: APP.workspaceId,
      appId: 'app_legacy',
      tokenHash: 'hash',
      sessionId: 'rsess_old',
      hostname: 'legacy',
      name: 'legacy',
      os: 'linux',
      arch: 'x64',
      daemonVersion: '0.4.0',
      declaredAllowedRoots: [],
      execEnabled: false,
      capabilities: [],
    });
    await registry.markOffline('dev_legacy', 'rsess_old');
    // Simulate a legacy record with no lastSeenAt at all.
    delete registry.devices.get('dev_legacy')!.lastSeenAt;

    const result = await gateway.dispatch(
      { appId: 'app_legacy' },
      { tool: 'read-file', arguments: {} },
    );
    expect(result.error?.details?.diagnostic).toBe('device_offline');
    expect(result.error?.message).toContain('legacy is offline');
    expect(result.error?.message).not.toContain('last seen');
    expect(result.error?.message).toContain('teros-remote start');
  });

  it('device_revoked: status revoked → dedicated diagnostic + pair --new-key command (T-REM-14)', async () => {
    await registry.upsertOnline({
      deviceId: 'dev_revoked',
      ownerId: APP.ownerId,
      workspaceId: APP.workspaceId,
      appId: 'app_revoked',
      tokenHash: 'hash',
      sessionId: 'rsess_old',
      hostname: 'revoked',
      name: 'revoked',
      os: 'linux',
      arch: 'x64',
      daemonVersion: '0.4.0',
      declaredAllowedRoots: [],
      execEnabled: false,
      capabilities: [],
    });
    await registry.markOffline('dev_revoked', 'rsess_old');
    registry.devices.get('dev_revoked')!.status = 'revoked';

    const result = await gateway.dispatch(
      { appId: 'app_revoked' },
      { tool: 'read-file', arguments: {} },
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('MACHINE_UNREACHABLE');
    expect(result.error?.details?.diagnostic).toBe('device_revoked');
    expect(result.error?.message).toContain('unpaired or revoked');
    expect(result.error?.message).toContain('teros-remote pair --new-key');
    // Must NOT suggest the useless 'teros-remote start' for a revoked device.
    expect(result.error?.message).not.toContain('teros-remote start');
  });

  it('non-Date lastSeenAt (corrupted record) → does not throw, omits lastSeenAt from details (T-REM-14)', async () => {
    await registry.upsertOnline({
      deviceId: 'dev_corrupt',
      ownerId: APP.ownerId,
      workspaceId: APP.workspaceId,
      appId: 'app_corrupt',
      tokenHash: 'hash',
      sessionId: 'rsess_old',
      hostname: 'corrupt',
      name: 'corrupt',
      os: 'linux',
      arch: 'x64',
      daemonVersion: '0.4.0',
      declaredAllowedRoots: [],
      execEnabled: false,
      capabilities: [],
    });
    await registry.markOffline('dev_corrupt', 'rsess_old');
    // Simulate a corrupted record where lastSeenAt is a string, not a Date.
    (registry.devices.get('dev_corrupt') as any).lastSeenAt = 'not-a-date';

    const result = await gateway.dispatch(
      { appId: 'app_corrupt' },
      { tool: 'read-file', arguments: {} },
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('MACHINE_UNREACHABLE');
    // The diagnostic must still classify (not crash) and lastSeenAt must be absent.
    expect(result.error?.details?.diagnostic).toBe('device_offline');
    expect(result.error?.details?.lastSeenAt).toBeUndefined();
  });
});
