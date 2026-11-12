/**
 * Key validation for Teros Remote pairing (spec REQ-3 / § Security): the
 * daemon's key must match the TEROS_REMOTE_KEY stored for an active
 * mca.teros.remote app instance in the existing encrypted user-secret store
 * (AuthManager). No other store, no plaintext comparison.
 */
import { describe, expect, it } from 'bun:test';
import { REMOTE_MCA_ID } from '@teros/shared';
import {
  type AuthManagerKeyResolverDeps,
  createAuthManagerKeyResolver,
  hashRemoteKey,
  remoteKeysEqual,
} from '../../src/services/remote-device-key-resolver';
import { InMemoryRemoteDeviceRegistry } from './_remote-fakes';

const KEY_A = 'trsk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const KEY_B = 'trsk_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

interface Cred {
  userId: string;
  appId: string;
  mcaId: string;
  data: Record<string, unknown>;
}

function fakeAuthManager(creds: Cred[]) {
  const calls = { get: 0, list: 0 };
  const authManager: AuthManagerKeyResolverDeps['authManager'] = {
    async get(userId, appId) {
      calls.get++;
      return creds.find((c) => c.userId === userId && c.appId === appId)?.data;
    },
    async listCredentialsByMca(mcaId) {
      calls.list++;
      return creds
        .filter((c) => c.mcaId === mcaId)
        .map(({ userId, appId, data }) => ({ userId, appId, data }));
    },
  };
  return { authManager, calls };
}

const apps: Record<
  string,
  { appId: string; mcaId: string; ownerId: string; name: string; status?: 'active' | 'disabled' }
> = {
  app_a: {
    appId: 'app_a',
    mcaId: REMOTE_MCA_ID,
    ownerId: 'work_hq',
    name: 'Laptop',
    status: 'active',
  },
  app_b: { appId: 'app_b', mcaId: REMOTE_MCA_ID, ownerId: 'work_hq', name: 'Build box' },
  app_disabled: {
    appId: 'app_disabled',
    mcaId: REMOTE_MCA_ID,
    ownerId: 'work_hq',
    name: 'Old',
    status: 'disabled',
  },
  app_other: { appId: 'app_other', mcaId: 'mca.brevo', ownerId: 'work_hq', name: 'Brevo' },
};
const getApp: AuthManagerKeyResolverDeps['getApp'] = async (appId) => apps[appId] ?? null;

describe('remote key helpers', () => {
  it('hashRemoteKey is sha256 hex and remoteKeysEqual is exact', () => {
    expect(hashRemoteKey('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(remoteKeysEqual(KEY_A, KEY_A)).toBe(true);
    expect(remoteKeysEqual(KEY_A, KEY_B)).toBe(false);
    expect(remoteKeysEqual(KEY_A, `${KEY_A} `)).toBe(false);
    expect(remoteKeysEqual('', KEY_A)).toBe(false);
  });
});

describe('createAuthManagerKeyResolver', () => {
  it('resolves a pasted key to its app instance, owner (credential user) and workspace (app owner)', async () => {
    const { authManager } = fakeAuthManager([
      {
        userId: 'user_alice',
        appId: 'app_a',
        mcaId: REMOTE_MCA_ID,
        data: { TEROS_REMOTE_KEY: KEY_A },
      },
      {
        userId: 'user_bob',
        appId: 'app_b',
        mcaId: REMOTE_MCA_ID,
        data: { TEROS_REMOTE_KEY: KEY_B },
      },
    ]);
    const resolve = createAuthManagerKeyResolver({
      authManager,
      registry: new InMemoryRemoteDeviceRegistry(),
      getApp,
    });
    const results = await resolve(KEY_B, { deviceId: 'dev_1', tokenHash: hashRemoteKey(KEY_B) });
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      appId: 'app_b',
      appName: 'Build box',
      ownerId: 'user_bob',
      workspaceId: 'work_hq',
    });
  });

  it('rejects unknown keys, keys of other MCAs, and keys whose app instance is disabled or gone', async () => {
    const { authManager } = fakeAuthManager([
      { userId: 'u', appId: 'app_other', mcaId: 'mca.brevo', data: { BREVO_API_KEY: KEY_A } },
      { userId: 'u', appId: 'app_other', mcaId: REMOTE_MCA_ID, data: { TEROS_REMOTE_KEY: KEY_B } },
      {
        userId: 'u',
        appId: 'app_disabled',
        mcaId: REMOTE_MCA_ID,
        data: { TEROS_REMOTE_KEY: 'trsk_disabled' },
      },
      {
        userId: 'u',
        appId: 'app_missing',
        mcaId: REMOTE_MCA_ID,
        data: { TEROS_REMOTE_KEY: 'trsk_missing' },
      },
    ]);
    const resolve = createAuthManagerKeyResolver({
      authManager,
      registry: new InMemoryRemoteDeviceRegistry(),
      getApp,
    });
    const hint = { deviceId: 'dev_1', tokenHash: 'x' };
    expect(await resolve('trsk_nope', hint)).toEqual([]);
    expect(await resolve(KEY_A, hint)).toEqual([]); // only stored under another MCA's secret
    expect(await resolve(KEY_B, hint)).toEqual([]); // app is not an mca.teros.remote install
    expect(await resolve('trsk_disabled', hint)).toEqual([]);
    expect(await resolve('trsk_missing', hint)).toEqual([]);
  });

  it('ignores credentials without the TEROS_REMOTE_KEY field and empty keys', async () => {
    const { authManager } = fakeAuthManager([
      { userId: 'u', appId: 'app_a', mcaId: REMOTE_MCA_ID, data: {} },
      { userId: 'u', appId: 'app_b', mcaId: REMOTE_MCA_ID, data: { TEROS_REMOTE_KEY: '' } },
    ]);
    const resolve = createAuthManagerKeyResolver({
      authManager,
      registry: new InMemoryRemoteDeviceRegistry(),
      getApp,
    });
    expect(await resolve('', { deviceId: 'd', tokenHash: hashRemoteKey('') })).toEqual([]);
    expect(await resolve('undefined', { deviceId: 'd', tokenHash: 'x' })).toEqual([]);
  });

  it('fast path: a known tokenHash re-reads that one credential instead of scanning', async () => {
    const { authManager, calls } = fakeAuthManager([
      {
        userId: 'user_alice',
        appId: 'app_a',
        mcaId: REMOTE_MCA_ID,
        data: { TEROS_REMOTE_KEY: KEY_A },
      },
    ]);
    const registry = new InMemoryRemoteDeviceRegistry();
    await registry.upsertOnline({
      deviceId: 'dev_1',
      ownerId: 'user_alice',
      workspaceId: 'work_hq',
      appId: 'app_a',
      tokenHash: hashRemoteKey(KEY_A),
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
    const res = await resolve(KEY_A, { deviceId: 'dev_1', tokenHash: hashRemoteKey(KEY_A) });
    expect(res).toHaveLength(1);
    expect(res[0]?.appId).toBe('app_a');
    expect(calls.get).toBe(1);
    // Multi-workspace: the scan always runs to find additional matches (the fast path
    // only avoids re-resolving the known app — it no longer skips the scan entirely).
    expect(calls.list).toBe(1);
  });

  it('rotation: the stored secret wins over the remembered hash (old key rejected, new key resolves by scan)', async () => {
    const { authManager, calls } = fakeAuthManager([
      {
        userId: 'user_alice',
        appId: 'app_a',
        mcaId: REMOTE_MCA_ID,
        data: { TEROS_REMOTE_KEY: KEY_B },
      }, // rotated to B
    ]);
    const registry = new InMemoryRemoteDeviceRegistry();
    await registry.upsertOnline({
      deviceId: 'dev_1',
      ownerId: 'user_alice',
      workspaceId: 'work_hq',
      appId: 'app_a',
      tokenHash: hashRemoteKey(KEY_A),
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
    expect(await resolve(KEY_A, { deviceId: 'dev_1', tokenHash: hashRemoteKey(KEY_A) })).toEqual([]);
    expect(calls.get).toBe(1); // fast path tried, then the scan found nothing for A
    expect(calls.list).toBe(1);
    const resB = await resolve(KEY_B, { deviceId: 'dev_1', tokenHash: hashRemoteKey(KEY_B) });
    expect(resB).toHaveLength(1);
    expect(resB[0]?.appId).toBe('app_a');
  });

  it('revoked device records do not short-circuit the scan', async () => {
    const { authManager, calls } = fakeAuthManager([
      {
        userId: 'user_alice',
        appId: 'app_a',
        mcaId: REMOTE_MCA_ID,
        data: { TEROS_REMOTE_KEY: KEY_A },
      },
    ]);
    const registry = new InMemoryRemoteDeviceRegistry();
    const rec = await registry.upsertOnline({
      deviceId: 'dev_1',
      ownerId: 'user_alice',
      workspaceId: 'work_hq',
      appId: 'app_a',
      tokenHash: hashRemoteKey(KEY_A),
      sessionId: 'rsess_old',
      hostname: 'h',
      os: 'linux',
      arch: 'x64',
      daemonVersion: '0.1.0',
      declaredAllowedRoots: [],
      execEnabled: false,
      capabilities: [],
    });
    rec.status = 'revoked';
    const resolve = createAuthManagerKeyResolver({ authManager, registry, getApp });
    const resA = await resolve(KEY_A, { deviceId: 'dev_1', tokenHash: hashRemoteKey(KEY_A) });
    expect(resA).toHaveLength(1);
    expect(resA[0]?.appId).toBe('app_a');
    expect(calls.get).toBe(0);
    expect(calls.list).toBe(1);
  });
});
