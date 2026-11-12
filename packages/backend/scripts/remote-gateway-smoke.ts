#!/usr/bin/env bun
/**
 * Teros Remote gateway smoke — boots a RemoteDeviceGateway on a local port
 * (no Mongo, no backend bootstrap), connects a fake daemon, pairs it with a
 * known key, and round-trips one tool_call → tool_result through
 * `dispatch()`. Also proves the two failure modes an agent must see: a bad
 * key gets UNAUTHORIZED, and a disconnected device gets MACHINE_UNREACHABLE.
 *
 *   LOG_LEVEL=silent bun packages/backend/scripts/remote-gateway-smoke.ts
 *   PORT=18080 bun packages/backend/scripts/remote-gateway-smoke.ts --verbose
 *
 * To drive the REAL daemon against this gateway instead of the fake one, run
 * it with --hold (keeps listening; prints the key) and point the daemon at it:
 *   teros-remote pair --server ws://127.0.0.1:<port>   # then paste the printed key? No —
 *   the smoke gateway accepts the key it prints, so: TEROS_REMOTE_KEY=<printed> …
 *
 * Exit code 0 when every step passes, 1 otherwise.
 */
import { randomBytes } from 'node:crypto';
import { RemoteDeviceGateway } from '../src/services/remote-device-gateway';
import type { RemoteKeyResolver } from '../src/services/remote-device-key-resolver';
import {
  FakeDaemon,
  InMemoryRemoteDeviceRegistry,
  startGatewayServer,
} from '../tests/unit/_remote-fakes';

const verbose = process.argv.includes('--verbose');
const hold = process.argv.includes('--hold');
const port = Number(process.env.PORT ?? 0);
const log = (line: string) => verbose && process.stderr.write(`${line}\n`);

const key = process.env.TEROS_REMOTE_SMOKE_KEY ?? `trsk_${randomBytes(32).toString('base64url')}`;
const app = {
  appId: 'app_smoke',
  appName: 'Smoke machine',
  ownerId: 'user_smoke',
  workspaceId: 'work_smoke',
};
const resolveKey: RemoteKeyResolver = async (candidate) => (candidate === key ? { ...app } : null);

const registry = new InMemoryRemoteDeviceRegistry();
const gateway = new RemoteDeviceGateway({
  registry,
  resolveKey,
  defaultCallTimeoutMs: 10_000,
  heartbeatIntervalMs: 2_000,
});
gateway.initWebSocketServer();
const server = await startGatewayServer(gateway, port);
console.log(`gateway listening on ${server.url}`);

let failures = 0;
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    failures++;
    console.log(`✗ ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
function expect(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

if (hold) {
  console.log(`accepted key: ${key}`);
  console.log('holding — connect a daemon to the URL above (Ctrl-C to stop)');
  gateway.on('device:online', (d) =>
    console.log(
      `device online: ${d.deviceId} (${d.hostname}, ${d.os}/${d.arch}, roots=${d.declaredAllowedRoots.join(',')})`,
    ),
  );
  gateway.on('device:offline', (i) => console.log(`device offline: ${i.deviceId} (${i.reason})`));
  await new Promise(() => {});
}

await step('bad key → UNAUTHORIZED and close', async () => {
  const bad = new FakeDaemon({ url: server.url, key: 'trsk_wrong', log });
  const reply = await bad.waitForHandshake();
  expect(
    reply.type === 'error' && (reply.payload as { code: string }).code === 'UNAUTHORIZED',
    `got ${reply.type}`,
  );
  const closed = await bad.waitForClose();
  expect(closed.code === 4003, `close code ${closed.code}`);
});

await step('offline device → MACHINE_UNREACHABLE fast', async () => {
  const t0 = Date.now();
  const r = await gateway.dispatch(
    { appId: app.appId },
    { tool: 'read-file', arguments: { filePath: '/x' } },
  );
  expect(r.error?.code === 'MACHINE_UNREACHABLE', `got ${r.error?.code}`);
  expect(Date.now() - t0 < 100, 'did not fail fast');
  expect(r.error?.hint?.includes('teros-remote reconnect'), 'hint missing reconnect guidance');
});

const daemon = new FakeDaemon({
  url: server.url,
  key,
  hostname: 'smoke-host',
  execEnabled: true,
  allowedRoots: ['/tmp/smoke'],
  log,
  onToolCall: (call) => {
    const { tool, arguments: args } = call.payload;
    if (tool === 'list-roots')
      return { success: true, result: { roots: ['/tmp/smoke'] }, duration: 1 };
    if (tool === 'bash')
      return {
        success: true,
        result: {
          stdout: `ran: ${(args as { command: string }).command}\n`,
          stderr: '',
          exitCode: 0,
        },
        duration: 3,
      };
    return {
      success: false,
      duration: 0,
      error: { code: 'TOOL_NOT_FOUND', message: `Unknown tool: ${tool}` },
    };
  },
});

await step('pair: hello → hello_ack, device online in registry', async () => {
  const ack = await daemon.waitForHandshake();
  expect(ack.type === 'hello_ack', `got ${ack.type}`);
  const rec = registry.devices.get(daemon.deviceId);
  expect(rec?.status === 'online', `registry status ${rec?.status}`);
  expect(rec?.appId === app.appId, 'registry appId');
  expect(gateway.isAppOnline(app.appId), 'gateway does not see the app online');
});

await step('round-trip: tool_call list-roots → tool_result (same id)', async () => {
  const r = await gateway.dispatch({ appId: app.appId }, { tool: 'list-roots', arguments: {} });
  expect(r.success, `error ${r.error?.code}: ${r.error?.message}`);
  expect(
    JSON.stringify(r.result) === JSON.stringify({ roots: ['/tmp/smoke'] }),
    `unexpected result ${JSON.stringify(r.result)}`,
  );
  const call = daemon.received.find((e) => e.type === 'tool_call');
  expect(
    call && (call.payload as { tool: string }).tool === 'list-roots',
    'daemon did not receive the tool_call',
  );
});

await step('round-trip: bash → stdout/exitCode', async () => {
  const r = await gateway.dispatch(
    { appId: app.appId },
    { tool: 'bash', arguments: { command: 'id -un', description: 'who am i' } },
  );
  expect(r.success, `error ${r.error?.code}`);
  expect((r.result as { exitCode: number }).exitCode === 0, 'exitCode');
});

await step('keepalive: daemon ping → gateway pong', async () => {
  daemon.send({
    id: 'smoke-ping',
    type: 'ping',
    timestamp: new Date().toISOString(),
    version: '1.0',
    payload: { seq: 1 },
  });
  const pong = await daemon.waitFor((e) => e.type === 'pong' && e.id === 'smoke-ping');
  expect(pong.id === 'smoke-ping', 'pong id');
});

await step('disconnect → offline + MACHINE_UNREACHABLE', async () => {
  daemon.close();
  await daemon.waitForClose();
  await new Promise((r) => setTimeout(r, 50));
  expect(registry.devices.get(daemon.deviceId)?.status === 'offline', 'registry not offline');
  const r = await gateway.dispatch({ appId: app.appId }, { tool: 'list-roots', arguments: {} });
  expect(r.error?.code === 'MACHINE_UNREACHABLE', `got ${r.error?.code}`);
});

await gateway.close();
await server.close();
console.log(failures === 0 ? 'SMOKE OK' : `SMOKE FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
