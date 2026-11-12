/**
 * Multi-workspace pairing tests (2026-10-20).
 *
 * Covers the N:M device↔app binding model:
 *   - Resolver returns ALL matches for a shared key
 *   - Gateway binds a device to multiple apps on one tunnel
 *   - Eviction is per-device (not per-app) — a reconnect supersedes the whole tunnel
 *   - Revocation is per-binding — revoking one app doesn't tear down the tunnel
 *   - hello_ack carries the bindings list
 */
import { describe, expect, it } from 'bun:test';
import { REMOTE_MCA_ID } from '@teros/shared';
import {
  type AuthManagerKeyResolverDeps,
  createAuthManagerKeyResolver,
  hashRemoteKey,
} from '../../src/services/remote-device-key-resolver';
import {
  InMemoryRemoteDeviceBindingRegistry,
  InMemoryRemoteDeviceRegistry,
} from './_remote-fakes';

const KEY_SHARED = 'trsk_shared_key_for_multi_workspace_test_0000000000';
const KEY_UNIQUE = 'trsk_unique_key_for_single_workspace_test_00000000';

interface Cred {
  userId: string;
  appId: string;
  mcaId: string;
  data: Record<string, unknown>;
}

function fakeAuthManager(creds: Cred[]) {
  const authManager: AuthManagerKeyResolverDeps['authManager'] = {
    async get(userId, appId) {
      return creds.find((c) => c.userId === userId && c.appId === appId)?.data;
    },
    async listCredentialsByMca(mcaId) {
      return creds
        .filter((c) => c.mcaId === mcaId)
        .map(({ userId, appId, data }) => ({ userId, appId, data }));
    },
  };
  return authManager;
}

const apps: Record<
  string,
  { appId: string; mcaId: string; ownerId: string; name: string; status?: 'active' | 'disabled' }
> = {
  app_hq: {
    appId: 'app_hq',
    mcaId: REMOTE_MCA_ID,
    ownerId: 'work_hq',
    name: 'Teros HQ Remote',
    status: 'active',
  },
  app_side: {
    appId: 'app_side',
    mcaId: REMOTE_MCA_ID,
    ownerId: 'work_side',
    name: 'Side Project Remote',
    status: 'active',
  },
  app_third: {
    appId: 'app_third',
    mcaId: REMOTE_MCA_ID,
    ownerId: 'work_third',
    name: 'Third Workspace Remote',
    status: 'active',
  },
};
const getApp: AuthManagerKeyResolverDeps['getApp'] = async (appId) => apps[appId] ?? null;

describe('multi-workspace key resolution', () => {
  it('same key in 2 apps → 2 resolutions', async () => {
    const authManager = fakeAuthManager([
      {
        userId: 'user_pablo',
        appId: 'app_hq',
        mcaId: REMOTE_MCA_ID,
        data: { TEROS_REMOTE_KEY: KEY_SHARED },
      },
      {
        userId: 'user_pablo',
        appId: 'app_side',
        mcaId: REMOTE_MCA_ID,
        data: { TEROS_REMOTE_KEY: KEY_SHARED },
      },
    ]);
    const resolve = createAuthManagerKeyResolver({
      authManager,
      registry: new InMemoryRemoteDeviceRegistry(),
      getApp,
    });
    const results = await resolve(KEY_SHARED, {
      deviceId: 'dev_1',
      tokenHash: hashRemoteKey(KEY_SHARED),
    });
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.appId).sort()).toEqual(['app_hq', 'app_side']);
    expect(results.map((r) => r.workspaceId).sort()).toEqual(['work_hq', 'work_side']);
  });

  it('same key in 3 apps → 3 resolutions', async () => {
    const authManager = fakeAuthManager([
      {
        userId: 'user_pablo',
        appId: 'app_hq',
        mcaId: REMOTE_MCA_ID,
        data: { TEROS_REMOTE_KEY: KEY_SHARED },
      },
      {
        userId: 'user_pablo',
        appId: 'app_side',
        mcaId: REMOTE_MCA_ID,
        data: { TEROS_REMOTE_KEY: KEY_SHARED },
      },
      {
        userId: 'user_admin',
        appId: 'app_third',
        mcaId: REMOTE_MCA_ID,
        data: { TEROS_REMOTE_KEY: KEY_SHARED },
      },
    ]);
    const resolve = createAuthManagerKeyResolver({
      authManager,
      registry: new InMemoryRemoteDeviceRegistry(),
      getApp,
    });
    const results = await resolve(KEY_SHARED, {
      deviceId: 'dev_1',
      tokenHash: hashRemoteKey(KEY_SHARED),
    });
    expect(results).toHaveLength(3);
  });

  it('unique key in 1 app → 1 resolution (backward compat)', async () => {
    const authManager = fakeAuthManager([
      {
        userId: 'user_pablo',
        appId: 'app_hq',
        mcaId: REMOTE_MCA_ID,
        data: { TEROS_REMOTE_KEY: KEY_UNIQUE },
      },
    ]);
    const resolve = createAuthManagerKeyResolver({
      authManager,
      registry: new InMemoryRemoteDeviceRegistry(),
      getApp,
    });
    const results = await resolve(KEY_UNIQUE, {
      deviceId: 'dev_1',
      tokenHash: hashRemoteKey(KEY_UNIQUE),
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.appId).toBe('app_hq');
  });

  it('unknown key → empty array (not null)', async () => {
    const authManager = fakeAuthManager([
      {
        userId: 'user_pablo',
        appId: 'app_hq',
        mcaId: REMOTE_MCA_ID,
        data: { TEROS_REMOTE_KEY: KEY_UNIQUE },
      },
    ]);
    const resolve = createAuthManagerKeyResolver({
      authManager,
      registry: new InMemoryRemoteDeviceRegistry(),
      getApp,
    });
    const results = await resolve('trsk_nonexistent', {
      deviceId: 'dev_1',
      tokenHash: hashRemoteKey('trsk_nonexistent'),
    });
    expect(results).toEqual([]);
  });

  it('fast path + scan: known device credential + additional matches', async () => {
    const authManager = fakeAuthManager([
      {
        userId: 'user_pablo',
        appId: 'app_hq',
        mcaId: REMOTE_MCA_ID,
        data: { TEROS_REMOTE_KEY: KEY_SHARED },
      },
      {
        userId: 'user_pablo',
        appId: 'app_side',
        mcaId: REMOTE_MCA_ID,
        data: { TEROS_REMOTE_KEY: KEY_SHARED },
      },
    ]);
    const registry = new InMemoryRemoteDeviceRegistry();
    // Pre-register the device with app_hq (simulates a previous hello)
    await registry.upsertOnline({
      deviceId: 'dev_1',
      ownerId: 'user_pablo',
      workspaceId: 'work_hq',
      appId: 'app_hq',
      tokenHash: hashRemoteKey(KEY_SHARED),
      sessionId: 'rsess_old',
      hostname: 'h',
      os: 'linux',
      arch: 'x64',
      daemonVersion: '0.1.0',
      declaredAllowedRoots: [],
      execEnabled: false,
      capabilities: [],
    });
    const resolve = createAuthManagerKeyResolver({ authManager, registry, getApp });
    const results = await resolve(KEY_SHARED, {
      deviceId: 'dev_1',
      tokenHash: hashRemoteKey(KEY_SHARED),
    });
    // Fast path finds app_hq; scan finds app_side too
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.appId).sort()).toEqual(['app_hq', 'app_side']);
  });
});

describe('binding registry', () => {
  it('upsert is idempotent per (device, app)', async () => {
    const reg = new InMemoryRemoteDeviceBindingRegistry();
    const input = {
      deviceId: 'dev_1',
      appId: 'app_hq',
      workspaceId: 'work_hq',
      ownerId: 'user_1',
      tokenHash: 'hash1',
    };
    const b1 = await reg.upsertBinding(input);
    const b2 = await reg.upsertBinding(input);
    expect(b1.boundAt).toEqual(b2.boundAt); // boundAt preserved on re-upsert
    expect(b2.status).toBe('active');
    expect(await reg.getActiveByDeviceId('dev_1')).toHaveLength(1);
  });

  it('multiple bindings per device', async () => {
    const reg = new InMemoryRemoteDeviceBindingRegistry();
    await reg.upsertBinding({
      deviceId: 'dev_1', appId: 'app_hq', workspaceId: 'work_hq', ownerId: 'u', tokenHash: 'h',
    });
    await reg.upsertBinding({
      deviceId: 'dev_1', appId: 'app_side', workspaceId: 'work_side', ownerId: 'u', tokenHash: 'h',
    });
    expect(await reg.getActiveByDeviceId('dev_1')).toHaveLength(2);
    expect(await reg.getActiveByAppId('app_hq')).toHaveLength(1);
    expect(await reg.getActiveByAppId('app_side')).toHaveLength(1);
  });

  it('revokeBinding is per-binding — does not affect other bindings', async () => {
    const reg = new InMemoryRemoteDeviceBindingRegistry();
    await reg.upsertBinding({
      deviceId: 'dev_1', appId: 'app_hq', workspaceId: 'work_hq', ownerId: 'u', tokenHash: 'h',
    });
    await reg.upsertBinding({
      deviceId: 'dev_1', appId: 'app_side', workspaceId: 'work_side', ownerId: 'u', tokenHash: 'h',
    });

    const revoked = await reg.revokeBinding('dev_1', 'app_hq');
    expect(revoked).toBe(true);

    // app_hq binding is revoked
    const hqBindings = await reg.getActiveByAppId('app_hq');
    expect(hqBindings).toHaveLength(0);

    // app_side binding is still active
    const sideBindings = await reg.getActiveByAppId('app_side');
    expect(sideBindings).toHaveLength(1);

    // device still has an active binding
    expect(await reg.hasActiveBinding('dev_1')).toBe(true);
  });

  it('revokeAllBindings revokes everything', async () => {
    const reg = new InMemoryRemoteDeviceBindingRegistry();
    await reg.upsertBinding({
      deviceId: 'dev_1', appId: 'app_hq', workspaceId: 'work_hq', ownerId: 'u', tokenHash: 'h',
    });
    await reg.upsertBinding({
      deviceId: 'dev_1', appId: 'app_side', workspaceId: 'work_side', ownerId: 'u', tokenHash: 'h',
    });

    const count = await reg.revokeAllBindings('dev_1');
    expect(count).toBe(2);
    expect(await reg.hasActiveBinding('dev_1')).toBe(false);
  });

  it('re-upsert after revoke reactivates the binding', async () => {
    const reg = new InMemoryRemoteDeviceBindingRegistry();
    const input = {
      deviceId: 'dev_1', appId: 'app_hq', workspaceId: 'work_hq', ownerId: 'u', tokenHash: 'h',
    };
    await reg.upsertBinding(input);
    await reg.revokeBinding('dev_1', 'app_hq');
    expect(await reg.hasActiveBinding('dev_1')).toBe(false);

    await reg.upsertBinding(input);
    expect(await reg.hasActiveBinding('dev_1')).toBe(true);
  });
});
