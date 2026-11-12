/**
 * Integration test: MongoRemoteDeviceRegistry against a real MongoDB.
 *
 * Bug T-REM-FIX-1 (2026-10-18): upsertOnline put `name` in both `$set` and
 * `$setOnInsert`. Real Mongo rejects the update with a path conflict, the
 * gateway swallowed the error, and remote_devices stayed stale forever.
 * The unit suite uses an in-memory fake registry, so only a real-Mongo test
 * proves the update document is actually accepted by the server.
 *
 * Covers: first hello inserts the record, a second hello (reconnect with a
 * new session and a renamed device) updates it in place without error, and
 * markOffline only flips the owning session.
 *
 * Uses MONGODB_URI (default local :27017) with a unique db name that is
 * dropped afterwards. Skips silently if Mongo is down.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type Db, MongoClient } from 'mongodb';
import {
  MongoRemoteDeviceRegistry,
  type RemoteDeviceOnlineInput,
} from '../../src/models/remote-devices';

const URI = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017';
const DB_NAME = `teros_test_remotedev_${Date.now()}`;

let client: MongoClient;
let db: Db;
let registry: MongoRemoteDeviceRegistry;
let available = false;

function input(overrides: Partial<RemoteDeviceOnlineInput> = {}): RemoteDeviceOnlineInput {
  return {
    deviceId: 'dev_it_1',
    ownerId: 'user_1',
    workspaceId: 'work_1',
    appId: 'app_1',
    tokenHash: 'b'.repeat(64),
    sessionId: 'rsess_1',
    hostname: 'raw',
    name: 'raw',
    os: 'linux',
    arch: 'x64',
    daemonVersion: '0.1.0',
    declaredAllowedRoots: ['/srv'],
    execEnabled: true,
    capabilities: ['bash'],
    ...overrides,
  };
}

beforeAll(async () => {
  try {
    client = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 3000 });
    db = client.db(DB_NAME);
    registry = new MongoRemoteDeviceRegistry(db);
    available = true;
  } catch {
    console.warn('[remote-devices registry test] Mongo unreachable — skipping');
  }
});

afterAll(async () => {
  if (available) {
    await db.dropDatabase();
    await client.close();
  }
});

describe('MongoRemoteDeviceRegistry (real Mongo)', () => {
  it('first upsertOnline inserts the record (name written via $set on insert)', async () => {
    if (!available) return;
    const doc = await registry.upsertOnline(input());

    expect(doc.deviceId).toBe('dev_it_1');
    expect(doc.name).toBe('raw');
    expect(doc.status).toBe('online');
    expect(doc.sessionId).toBe('rsess_1');
    expect(doc.createdAt).toBeInstanceOf(Date);
    expect(doc.lastSeenAt).toBeInstanceOf(Date);

    const stored = await registry.getByDeviceId('dev_it_1');
    expect(stored?.name).toBe('raw');
  });

  it('re-upsertOnline (reconnect, new session, renamed device) updates in place — no path conflict', async () => {
    if (!available) return;
    await registry.upsertOnline(input());

    const renamed = await registry.upsertOnline(
      input({ sessionId: 'rsess_2', name: "Pablo's Laptop", daemonVersion: '0.2.0' }),
    );
    expect(renamed.sessionId).toBe('rsess_2');
    expect(renamed.name).toBe("Pablo's Laptop");
    expect(renamed.daemonVersion).toBe('0.2.0');

    const stored = await registry.getByDeviceId('dev_it_1');
    expect(stored?.sessionId).toBe('rsess_2');
    expect(stored?.name).toBe("Pablo's Laptop");
    expect(stored?.status).toBe('online');
  });

  it('markOffline only flips the owning session; a stale session cannot clobber a reconnect', async () => {
    if (!available) return;
    await registry.upsertOnline(input({ sessionId: 'rsess_current' }));

    // Stale session tries to mark offline — must be a no-op.
    await registry.markOffline('dev_it_1', 'rsess_old');
    let stored = await registry.getByDeviceId('dev_it_1');
    expect(stored?.status).toBe('online');
    expect(stored?.sessionId).toBe('rsess_current');

    // Owning session marks offline — flips.
    await registry.markOffline('dev_it_1', 'rsess_current');
    stored = await registry.getByDeviceId('dev_it_1');
    expect(stored?.status).toBe('offline');
  });

  it('touch updates liveness and lastError', async () => {
    if (!available) return;
    await registry.upsertOnline(input());

    await registry.touch('dev_it_1', { lastError: 'disk full' });
    let stored = await registry.getByDeviceId('dev_it_1');
    expect(stored?.lastError).toBe('disk full');

    await registry.touch('dev_it_1', { lastError: null });
    stored = await registry.getByDeviceId('dev_it_1');
    expect(stored?.lastError).toBeNull();
  });
});
