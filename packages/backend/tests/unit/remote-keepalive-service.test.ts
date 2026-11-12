/**
 * RemoteKeepaliveService — keep-alive + inactivity TTL (v1.1.0).
 *
 * Covers the acceptance criteria from the task:
 *   1. Active user + connected daemon → a `keepalive` is sent when the last
 *      one is stale (daily cadence) and the connection is NEVER stopped.
 *   2. User inactive beyond the TTL → the device is marked stopped
 *      (`stoppedReason='ttl_inactive'`) and a `stop` is sent down the tunnel.
 *   3. Fresher workspace activity (channel message / session) renews the TTL —
 *      the RAW case: agents message daily, so the daemon survives a weekend
 *      even when the human never logs in.
 *   4. No live tunnel at expiry → the stop is still recorded (the diagnosis
 *      needs the cause) and nothing throws.
 *
 * Uses an in-memory Db fake (findOne/find on channels / workspace_members /
 * user_sessions) + the shared InMemoryRemoteDeviceRegistry + a recording
 * gateway double — no Mongo, no sockets.
 */
import { describe, expect, it } from 'bun:test';
import type { Db } from 'mongodb';
import { REMOTE_INACTIVITY_TTL_MS, REMOTE_KEEPALIVE_INTERVAL_MS } from '@teros/shared';
import { RemoteKeepaliveService } from '../../src/services/remote-keepalive-service';
import { InMemoryRemoteDeviceRegistry } from './_remote-fakes';
import type { RemoteDevice, RemoteDeviceRegistry } from '../../src/models/remote-devices';
import type { RemoteDeviceGateway } from '../../src/services/remote-device-gateway';

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

interface ChannelDoc { workspaceId: string; lastMessageAt?: Date | null }
interface SessionDoc { userId: string; lastActivityAt?: Date | null }
interface MemberDoc { workspaceId: string; userId: string }

/** Minimal Db double: three queried collections, latest-first semantics. */
function fakeDb(docs: {
  channels?: ChannelDoc[];
  members?: MemberDoc[];
  sessions?: SessionDoc[];
}): Db {
  const channels = [...(docs.channels ?? [])].sort((a, b) =>
    (b.lastMessageAt?.getTime() ?? 0) - (a.lastMessageAt?.getTime() ?? 0));
  const sessions = [...(docs.sessions ?? [])].sort((a, b) =>
    (b.lastActivityAt?.getTime() ?? 0) - (a.lastActivityAt?.getTime() ?? 0));
  const members = docs.members ?? [];
  // findOne-style collection (latest doc wins — matches the service's sort).
  const latestCol = (rows: Array<Record<string, unknown>>) => ({
    findOne: async () => rows[0] ?? null,
  });
  // find-style collection (members list — the service calls .find().limit().toArray()).
  // find is sync in the driver (returns a cursor) — do NOT make it async.
  const listCol = (rows: Array<Record<string, unknown>>) => ({
    find: () => ({ limit: () => ({ toArray: async () => rows }) }),
  });
  return {
    collection: (name: string) => {
      if (name === 'channels') return latestCol(channels as Array<Record<string, unknown>>);
      if (name === 'user_sessions') return latestCol(sessions as Array<Record<string, unknown>>);
      if (name === 'workspace_members') return listCol(members as Array<Record<string, unknown>>);
      return latestCol([]);
    },
  } as unknown as Db;
}

/** Gateway double: records keepalive/stop sends, optional tunnel-down mode. */
function fakeGateway(opts: { online?: boolean } = {}) {
  const sent: Array<{ type: 'keepalive' | 'stop'; deviceId: string; payload: Record<string, unknown> }> = [];
  const gateway = {
    sendKeepalive: (target: { deviceId?: string }, payload: Record<string, unknown>) => {
      if (!opts.online) return false;
      sent.push({ type: 'keepalive', deviceId: target.deviceId!, payload });
      return true;
    },
    sendStop: (target: { deviceId?: string }, payload: Record<string, unknown>) => {
      if (!opts.online) return false;
      sent.push({ type: 'stop', deviceId: target.deviceId!, payload });
      return true;
    },
  } as unknown as RemoteDeviceGateway;
  return { gateway, sent };
}

function makeDevice(overrides: Partial<RemoteDevice> = {}): RemoteDevice {
  return {
    deviceId: 'dev_1',
    name: 'raw',
    ownerId: 'user_1',
    workspaceId: 'work_1',
    appId: 'app_1',
    tokenHash: 'a'.repeat(64),
    status: 'online',
    lastSeenAt: new Date(),
    hostname: 'raw',
    os: 'linux',
    arch: 'x64',
    daemonVersion: '0.9.3',
    declaredAllowedRoots: ['/'],
    execEnabled: true,
    capabilities: ['bash'],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeService(docs: Parameters<typeof fakeDb>[0], registry: RemoteDeviceRegistry, gateway: RemoteDeviceGateway, now: Date) {
  return new RemoteKeepaliveService({
    db: fakeDb(docs),
    registry,
    gateway,
    now: () => now,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RemoteKeepaliveService — keep-alive + inactivity TTL (v1.1.0)', () => {
  it('active user + stale keepalive → sends a keepalive and never stops the daemon', async () => {
    const now = new Date('2026-10-31T12:00:00Z');
    const registry = new InMemoryRemoteDeviceRegistry();
    await registry.upsertOnline({
      deviceId: 'dev_1', ownerId: 'user_1', workspaceId: 'work_1', appId: 'app_1',
      tokenHash: 'a'.repeat(64), sessionId: 'rsess_1', hostname: 'raw', name: 'raw',
      os: 'linux', arch: 'x64', daemonVersion: '0.9.3',
      declaredAllowedRoots: ['/'], execEnabled: true, capabilities: ['bash'],
    });
    // User was active 1h ago (channel message) — well within the 72h TTL.
    const db = {
      channels: [{ workspaceId: 'work_1', lastMessageAt: new Date(now.getTime() - 3_600_000) }],
      members: [{ workspaceId: 'work_1', userId: 'user_1' }],
      sessions: [],
    };
    const { gateway, sent } = fakeGateway({ online: true });
    const service = makeService(db, registry, gateway, now);

    const result = await service.tick();

    expect(result.stopped).toBe(0);
    expect(result.kept).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.type).toBe('keepalive');
    expect(sent[0]!.payload.ttlMs).toBe(REMOTE_INACTIVITY_TTL_MS);
    // The registry recorded the renewal.
    const device = await registry.getByDeviceId('dev_1');
    expect(device?.lastKeepaliveAt).toBeDefined();
    expect(device?.stoppedReason).toBeUndefined();
  });

  it('keepalive is NOT resent before the daily cadence elapses', async () => {
    const now = new Date('2026-10-31T12:00:00Z');
    const registry = new InMemoryRemoteDeviceRegistry();
    await registry.upsertOnline({
      deviceId: 'dev_1', ownerId: 'user_1', workspaceId: 'work_1', appId: 'app_1',
      tokenHash: 'a'.repeat(64), sessionId: 'rsess_1', hostname: 'raw', name: 'raw',
      os: 'linux', arch: 'x64', daemonVersion: '0.9.3',
      declaredAllowedRoots: ['/'], execEnabled: true, capabilities: ['bash'],
    });
    // A keepalive was sent 1h ago — below the 24h cadence.
    await registry.markKeepaliveSent('dev_1');
    const stored = await registry.getByDeviceId('dev_1');
    stored!.lastKeepaliveAt = new Date(now.getTime() - 3_600_000);
    const db = {
      channels: [{ workspaceId: 'work_1', lastMessageAt: new Date(now.getTime() - 3_600_000) }],
    };
    const { gateway, sent } = fakeGateway({ online: true });
    const service = makeService(db, registry, gateway, now);

    const result = await service.tick();

    expect(result.kept).toBe(0);
    expect(sent).toHaveLength(0);
    expect(REMOTE_KEEPALIVE_INTERVAL_MS).toBe(24 * 3_600_000);
  });

  it('user inactive beyond the TTL → marks stopped_inactive and sends a clean stop', async () => {
    const now = new Date('2026-10-31T12:00:00Z');
    const registry = new InMemoryRemoteDeviceRegistry();
    await registry.upsertOnline({
      deviceId: 'dev_1', ownerId: 'user_1', workspaceId: 'work_1', appId: 'app_1',
      tokenHash: 'a'.repeat(64), sessionId: 'rsess_1', hostname: 'raw', name: 'raw',
      os: 'linux', arch: 'x64', daemonVersion: '0.9.3',
      declaredAllowedRoots: ['/'], execEnabled: true, capabilities: ['bash'],
    });
    // Last activity 80h ago — beyond the 72h TTL. No channel/session life since.
    const stale = new Date(now.getTime() - 80 * 3_600_000);
    const stored = await registry.getByDeviceId('dev_1');
    stored!.lastUserActivityAt = stale;
    stored!.lastSeenAt = stale;
    const db = {
      channels: [{ workspaceId: 'work_1', lastMessageAt: stale }],
      members: [{ workspaceId: 'work_1', userId: 'user_1' }],
      sessions: [{ userId: 'user_1', lastActivityAt: stale }],
    };
    const { gateway, sent } = fakeGateway({ online: true });
    const service = makeService(db, registry, gateway, now);

    const result = await service.tick();

    expect(result.stopped).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.type).toBe('stop');
    expect(sent[0]!.payload.reason).toBe('ttl_inactive');
    const device = await registry.getByDeviceId('dev_1');
    expect(device?.stoppedReason).toBe('ttl_inactive');
    expect(device?.stoppedAt).toBeDefined();
  });

  it('TTL expiry with no live tunnel → stop is still recorded, nothing throws', async () => {
    const now = new Date('2026-10-31T12:00:00Z');
    const registry = new InMemoryRemoteDeviceRegistry();
    await registry.upsertOnline({
      deviceId: 'dev_1', ownerId: 'user_1', workspaceId: 'work_1', appId: 'app_1',
      tokenHash: 'a'.repeat(64), sessionId: 'rsess_1', hostname: 'raw', name: 'raw',
      os: 'linux', arch: 'x64', daemonVersion: '0.9.3',
      declaredAllowedRoots: ['/'], execEnabled: true, capabilities: ['bash'],
    });
    const stale = new Date(now.getTime() - 100 * 3_600_000);
    const stored = await registry.getByDeviceId('dev_1');
    stored!.lastUserActivityAt = stale;
    const db = { channels: [{ workspaceId: 'work_1', lastMessageAt: stale }] };
    const { gateway, sent } = fakeGateway({ online: false }); // tunnel down
    const service = makeService(db, registry, gateway, now);

    const result = await service.tick();

    expect(result.stopped).toBe(1);
    expect(sent).toHaveLength(0); // nothing on the wire — daemon already gone
    const device = await registry.getByDeviceId('dev_1');
    expect(device?.stoppedReason).toBe('ttl_inactive');
  });

  it('fresher agent activity (channel message) renews the TTL — the RAW weekend case', async () => {
    const now = new Date('2026-10-31T12:00:00Z'); // Saturday
    const registry = new InMemoryRemoteDeviceRegistry();
    await registry.upsertOnline({
      deviceId: 'dev_1', ownerId: 'user_1', workspaceId: 'work_1', appId: 'app_1',
      tokenHash: 'a'.repeat(64), sessionId: 'rsess_1', hostname: 'raw', name: 'raw',
      os: 'linux', arch: 'x64', daemonVersion: '0.9.3',
      declaredAllowedRoots: ['/'], execEnabled: true, capabilities: ['bash'],
    });
    // Human last seen 80h ago (would expire)… but an agent messaged a channel
    // 2h ago — the workspace is alive, the daemon must survive.
    const humanLast = new Date(now.getTime() - 80 * 3_600_000);
    const agentMsg = new Date(now.getTime() - 2 * 3_600_000);
    const stored = await registry.getByDeviceId('dev_1');
    stored!.lastUserActivityAt = humanLast;
    const db = {
      channels: [{ workspaceId: 'work_1', lastMessageAt: agentMsg }],
      members: [{ workspaceId: 'work_1', userId: 'user_1' }],
      sessions: [{ userId: 'user_1', lastActivityAt: humanLast }],
    };
    const { gateway, sent } = fakeGateway({ online: true });
    const service = makeService(db, registry, gateway, now);

    const result = await service.tick();

    expect(result.stopped).toBe(0);
    expect(sent.map((s) => s.type)).toEqual(['keepalive']);
    const device = await registry.getByDeviceId('dev_1');
    expect(device?.lastUserActivityAt?.getTime()).toBe(agentMsg.getTime());
    expect(device?.stoppedReason).toBeUndefined();
  });

  it('session activity of a workspace member renews the TTL (human logged in)', async () => {
    const now = new Date('2026-10-31T12:00:00Z');
    const registry = new InMemoryRemoteDeviceRegistry();
    await registry.upsertOnline({
      deviceId: 'dev_1', ownerId: 'user_2', workspaceId: 'work_1', appId: 'app_1',
      tokenHash: 'a'.repeat(64), sessionId: 'rsess_1', hostname: 'raw', name: 'raw',
      os: 'linux', arch: 'x64', daemonVersion: '0.9.3',
      declaredAllowedRoots: ['/'], execEnabled: true, capabilities: ['bash'],
    });
    const stale = new Date(now.getTime() - 80 * 3_600_000);
    const loginAt = new Date(now.getTime() - 1_800_000); // 30 min ago
    const stored = await registry.getByDeviceId('dev_1');
    stored!.lastUserActivityAt = stale;
    const db = {
      channels: [{ workspaceId: 'work_1', lastMessageAt: stale }],
      members: [{ workspaceId: 'work_1', userId: 'user_9' }],
      sessions: [{ userId: 'user_9', lastActivityAt: loginAt }],
    };
    const { gateway, sent } = fakeGateway({ online: true });
    const service = makeService(db, registry, gateway, now);

    const result = await service.tick();

    expect(result.stopped).toBe(0);
    expect(sent.map((s) => s.type)).toEqual(['keepalive']);
    const device = await registry.getByDeviceId('dev_1');
    expect(device?.lastUserActivityAt?.getTime()).toBe(loginAt.getTime());
  });
});
