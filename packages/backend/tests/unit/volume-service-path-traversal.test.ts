/**
 * Unit tests — path traversal protection in volume-service.ts
 *
 * Verifies that:
 *   1. `assertSafePath` (via getVolume) blocks hostPaths that escape basePath.
 *   2. `assertSafeContainerPath` (via resolveVolumeMounts) blocks container
 *      mount paths outside the allowed whitelist.
 *
 * Uses a writable temp directory under /tmp so VolumeService's constructor
 * (which calls mkdirSync) doesn't fail with EACCES.
 * The DB is fully mocked — no real MongoDB required.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { VolumeService } from '../../src/services/volume-service';
import type { Volume } from '../../src/services/volume-service';

// ---------------------------------------------------------------------------
// Shared temp basePath — writable, cleaned up after all tests
// ---------------------------------------------------------------------------

const TEST_BASE = `/tmp/teros-test-volumes-${Date.now()}`;

beforeAll(() => {
  mkdirSync(join(TEST_BASE, 'users'), { recursive: true });
  mkdirSync(join(TEST_BASE, 'workspaces'), { recursive: true });
});

afterAll(() => {
  rmSync(TEST_BASE, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Minimal MongoDB mock helpers
// ---------------------------------------------------------------------------

function makeVolume(overrides: Partial<Volume> = {}): Volume {
  return {
    volumeId: 'vol_test_001',
    type: 'user',
    name: 'Test Volume',
    hostPath: join(TEST_BASE, 'users', 'vol_test_001'),
    ownerId: 'user_alice',
    quota: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/**
 * Build a minimal VolumeService backed by an in-memory collection stub.
 * `storedVolume` is what `findOne` returns when queried.
 */
function makeService(storedVolume: Volume | null, basePath = TEST_BASE) {
  const findOne = mock(async (_query: unknown) => storedVolume);
  const updateOne = mock(async () => ({ modifiedCount: 1 }));
  const fakeCollection = {
    findOne,
    updateOne,
    find: mock(() => ({ toArray: async () => [] })),
  };
  const fakeDb = { collection: mock((_name: string) => fakeCollection) } as any;

  const service = new VolumeService(fakeDb, { basePath });
  return { service, findOne, updateOne };
}

// ---------------------------------------------------------------------------
// assertSafePath — tested via getVolume()
// ---------------------------------------------------------------------------

describe('assertSafePath (via getVolume)', () => {
  it('allows a hostPath that is exactly the basePath', async () => {
    const vol = makeVolume({ hostPath: TEST_BASE });
    const { service } = makeService(vol);
    await expect(service.getVolume('vol_test_001')).resolves.toBeDefined();
  });

  it('allows a hostPath that is a direct child of basePath', async () => {
    const vol = makeVolume({ hostPath: join(TEST_BASE, 'users', 'vol_test_001') });
    // Pre-create the directory so existsSync doesn't call mkdirSync on a blocked path
    mkdirSync(join(TEST_BASE, 'users', 'vol_test_001'), { recursive: true });
    const { service } = makeService(vol);
    await expect(service.getVolume('vol_test_001')).resolves.toBeDefined();
  });

  it('allows a deeply nested hostPath under basePath', async () => {
    const nested = join(TEST_BASE, 'workspaces', 'ws_abc', 'subdir');
    mkdirSync(nested, { recursive: true });
    const vol = makeVolume({ hostPath: nested });
    const { service } = makeService(vol);
    await expect(service.getVolume('vol_test_001')).resolves.toBeDefined();
  });

  it('blocks a hostPath with literal ../ that escapes basePath', async () => {
    // e.g. /tmp/teros-test-volumes-xxx/../etc/passwd → /etc/passwd
    const vol = makeVolume({ hostPath: join(TEST_BASE, '..', 'etc', 'passwd') });
    const { service } = makeService(vol);
    await expect(service.getVolume('vol_test_001')).rejects.toThrow('Path traversal detected');
  });

  it('blocks a hostPath that resolves to a sibling directory', async () => {
    // Sibling of basePath — starts with the same prefix but is NOT under it
    const vol = makeVolume({ hostPath: TEST_BASE + '-evil' });
    const { service } = makeService(vol);
    await expect(service.getVolume('vol_test_001')).rejects.toThrow('Path traversal detected');
  });

  it('blocks an absolute hostPath that is completely outside basePath', async () => {
    const vol = makeVolume({ hostPath: '/etc/shadow' });
    const { service } = makeService(vol);
    await expect(service.getVolume('vol_test_001')).rejects.toThrow('Path traversal detected');
  });

  it('blocks a hostPath with multiple ../ segments that escape basePath', async () => {
    // /tmp/teros-test-volumes-xxx/users/../../.. → resolves well outside TEST_BASE
    const vol = makeVolume({ hostPath: join(TEST_BASE, 'users', '..', '..', '..') });
    const { service } = makeService(vol);
    await expect(service.getVolume('vol_test_001')).rejects.toThrow('Path traversal detected');
  });
});

// ---------------------------------------------------------------------------
// assertSafeContainerPath — tested via resolveVolumeMounts()
// ---------------------------------------------------------------------------

describe('assertSafeContainerPath (via resolveVolumeMounts)', () => {
  /** Build a service where canAccess/canWrite always return true */
  function makeServiceWithAccess() {
    // Pre-create the volume directory so resolveVolumeMounts doesn't fail on mkdirSync
    const volDir = join(TEST_BASE, 'users', 'vol_test_001');
    mkdirSync(volDir, { recursive: true });

    const vol = makeVolume({ hostPath: volDir });
    const findOne = mock(async (_query: unknown) => vol);
    const updateOne = mock(async () => ({ modifiedCount: 1 }));
    const fakeCollection = {
      findOne,
      updateOne,
      find: mock(() => ({ toArray: async () => [] })),
    };
    const fakeDb = { collection: mock(() => fakeCollection) } as any;
    return new VolumeService(fakeDb, { basePath: TEST_BASE });
  }

  const ALLOWED_PATHS = [
    '/workspace',
    '/workspace/project',
    '/data',
    '/data/output/nested',
    '/files',
    '/files/uploads/img.png',
    '/home',
    '/home/user/docs',
    '/tmp',
    '/tmp/scratch',
  ];

  for (const mountPath of ALLOWED_PATHS) {
    it(`allows container path: ${mountPath}`, async () => {
      const service = makeServiceWithAccess();
      await expect(
        service.resolveVolumeMounts([{ volumeId: 'vol_test_001', mountPath }], 'user_alice'),
      ).resolves.toBeDefined();
    });
  }

  const BLOCKED_PATHS = [
    '/etc',
    '/etc/passwd',
    '/proc',
    '/proc/self/environ',
    '/sys',
    '/root',
    '/var/run/docker.sock',
    '/usr/bin',
    '/',
    '/workspace/../etc',       // resolves to /etc
    '/workspace/../../root',   // resolves to /root
    '/tmp/../etc/shadow',      // resolves to /etc/shadow
  ];

  for (const mountPath of BLOCKED_PATHS) {
    it(`blocks container path: ${mountPath}`, async () => {
      const service = makeServiceWithAccess();
      await expect(
        service.resolveVolumeMounts([{ volumeId: 'vol_test_001', mountPath }], 'user_alice'),
      ).rejects.toThrow();
    });
  }
});
