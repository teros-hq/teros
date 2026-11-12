/**
 * Remote device key resolution (docs/specs/remote/teros-remote.md REQ-3,
 * § Security).
 *
 * v1 pairing rides the existing user-API-key mechanism: the daemon generates a
 * key, the user pastes it into the Teros Remote app instance's
 * `TEROS_REMOTE_KEY` field, and the standard app-config flow stores it in the
 * encrypted `user_credentials` store (AuthManager). A `hello` carries that
 * key; this module resolves key → app instance(s) → owner + workspace.
 *
 * Multi-workspace (2026-10-20): the same key may be pasted into N app
 * instances across different workspaces. The resolver returns ALL matches
 * so the gateway can bind the device to every one of them.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { REMOTE_DEVICE_KEY_SECRET, REMOTE_MCA_ID } from '@teros/shared';
import type { AuthManager } from '../auth/auth-manager';
import { createLogger } from '../lib/logger';
import type { RemoteDeviceRegistry } from '../models/remote-devices';
import type { App } from '../types/database';

const log = createLogger('RemoteDeviceKeyResolver');

/** What a valid key resolves to — one entry per matching app instance. */
export interface RemoteKeyResolution {
  appId: string;
  appName: string;
  /** User who pasted the key (owner of the credential record) */
  ownerId: string;
  /** Workspace the app instance belongs to (`apps.ownerId`) */
  workspaceId: string;
}

/**
 * Multi-match resolver: returns ALL app instances whose stored key matches.
 * Returns an empty array when no match is found (never null — an empty array
 * is the "key not registered" signal).
 */
export type RemoteKeyResolver = (
  key: string,
  hint: { deviceId: string; tokenHash: string },
) => Promise<RemoteKeyResolution[]>;

/** sha256 hex — what `remote_devices.tokenHash` stores. The key itself is never persisted by the backend. */
export function hashRemoteKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/** Constant-time comparison of two keys (compares their digests, so length differences do not leak). */
export function remoteKeysEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a, 'utf8').digest();
  const db = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(da, db);
}

export interface AuthManagerKeyResolverDeps {
  authManager: Pick<AuthManager, 'get' | 'listCredentialsByMca'>;
  registry: Pick<RemoteDeviceRegistry, 'getByTokenHash'>;
  getApp: (
    appId: string,
  ) => Promise<Pick<App, 'appId' | 'mcaId' | 'ownerId' | 'name' | 'status'> | null>;
}

function keyFromCredentials(data: Record<string, unknown> | undefined | null): string | null {
  const value = data?.[REMOTE_DEVICE_KEY_SECRET];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Resolve a key through the app-instance secret store.
 *
 * Multi-workspace: scans ALL `mca.teros.remote` credentials and returns every
 * match. The fast path (via `remote_devices.tokenHash`) is tried first — if
 * the known device's credential still matches, that app is included; then the
 * full scan picks up any additional apps that share the same key.
 *
 * The app instance must exist, be an `mca.teros.remote` install and be active.
 */
export function createAuthManagerKeyResolver(deps: AuthManagerKeyResolverDeps): RemoteKeyResolver {
  const { authManager, registry, getApp } = deps;

  async function resolveApp(appId: string, ownerId: string): Promise<RemoteKeyResolution | null> {
    const app = await getApp(appId);
    if (!app) {
      log.warn({ appId }, 'Key matched a credential but the app instance no longer exists');
      return null;
    }
    if (app.mcaId !== REMOTE_MCA_ID) {
      log.warn(
        { appId, mcaId: app.mcaId },
        'Key matched a credential of a non-remote app — refusing',
      );
      return null;
    }
    if (app.status && app.status !== 'active') {
      log.warn({ appId, status: app.status }, 'Key matched an inactive app instance — refusing');
      return null;
    }
    return { appId: app.appId, appName: app.name, ownerId, workspaceId: app.ownerId };
  }

  return async (key, hint) => {
    const results: RemoteKeyResolution[] = [];
    const seenAppIds = new Set<string>();

    // 1. Fast path via the device registry — check the known device's credential
    const known = await registry.getByTokenHash(hint.tokenHash);
    if (known && known.status !== 'revoked') {
      try {
        const stored = keyFromCredentials(await authManager.get(known.ownerId, known.appId));
        if (stored && remoteKeysEqual(stored, key)) {
          const resolution = await resolveApp(known.appId, known.ownerId);
          if (resolution) {
            results.push(resolution);
            seenAppIds.add(resolution.appId);
          }
        }
      } catch (err) {
        log.warn(
          { err, appId: known.appId },
          'Fast-path credential read failed; falling back to scan',
        );
      }
    }

    // 2. Full scan of the MCA's credentials — pick up ALL matches (multi-workspace)
    const candidates = await authManager.listCredentialsByMca(REMOTE_MCA_ID);
    for (const candidate of candidates) {
      if (seenAppIds.has(candidate.appId)) continue; // already resolved via fast path
      const stored = keyFromCredentials(candidate.data);
      if (stored && remoteKeysEqual(stored, key)) {
        const resolution = await resolveApp(candidate.appId, candidate.userId);
        if (resolution) {
          results.push(resolution);
          seenAppIds.add(resolution.appId);
        }
      }
    }

    return results;
  };
}
