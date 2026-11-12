/**
 * TER-388 regression: the Sheets MCA must not refresh OAuth tokens itself.
 *
 * The backend is the only refresher (`GET /secrets/user` serves a fresh
 * access_token lazily). These tests prove that:
 *  - initializing the client performs no refreshAccessToken() call and sets
 *    only `access_token` (never `refresh_token`);
 *  - a 401 re-fetches secrets exactly once from the backend and retries;
 *  - a non-401 error is rethrown without touching the backend again.
 */

import { describe, expect, it } from 'bun:test';
import { OAuth2Client } from 'google-auth-library';
import { initializeGoogleClients, withAuthRetry } from '../src/lib/google-client';

const SYSTEM_SECRETS = { CLIENT_ID: 'client-id', CLIENT_SECRET: 'client-secret' };

function context(tokens: string[]) {
  let systemCalls = 0;
  let userCalls = 0;
  let index = 0;
  return {
    getSystemSecrets: async () => {
      systemCalls++;
      return SYSTEM_SECRETS;
    },
    getUserSecrets: async () => {
      userCalls++;
      const accessToken = tokens[Math.min(index, tokens.length - 1)];
      index++;
      return { ACCESS_TOKEN: accessToken };
    },
    counts: () => ({ systemCalls, userCalls }),
    resetCounts: () => {
      systemCalls = 0;
      userCalls = 0;
    },
  };
}

function spyOnRefresh() {
  const original = OAuth2Client.prototype.refreshAccessToken;
  let calls = 0;
  OAuth2Client.prototype.refreshAccessToken = async function () {
    calls++;
    throw new Error('refreshAccessToken must not be called by the MCA');
  };
  return {
    calls: () => calls,
    restore: () => {
      OAuth2Client.prototype.refreshAccessToken = original;
    },
  };
}

describe('Sheets OAuth credentials (TER-388)', () => {
  it('sets only access_token and never refreshes', async () => {
    const refresh = spyOnRefresh();
    try {
      const ctx = context(['drive-token']);
      const clients = await initializeGoogleClients(ctx as any, { force: true });

      expect(refresh.calls()).toBe(0);
      expect(clients.oauth2Client.credentials.access_token).toBe('drive-token');
      expect(clients.oauth2Client.credentials.refresh_token).toBeUndefined();
      expect(ctx.counts()).toEqual({ systemCalls: 1, userCalls: 1 });
    } finally {
      refresh.restore();
    }
  });

  it('401 -> re-fetches secrets once and retries with the fresh token', async () => {
    const refresh = spyOnRefresh();
    try {
      const ctx = context(['stale-token', 'fresh-token']);
      const clients = await initializeGoogleClients(ctx as any, { force: true });
      ctx.resetCounts();

      const seen: Array<string | null | undefined> = [];
      let attempts = 0;
      const result = await withAuthRetry(
        ctx as any,
        async () => {
          attempts++;
          seen.push(clients.oauth2Client.credentials.access_token);
          if (attempts === 1) {
            throw Object.assign(new Error('Invalid Credentials'), { code: 401 });
          }
          return 'ok';
        },
        'test-operation',
      );

      expect(result).toBe('ok');
      expect(attempts).toBe(2);
      expect(seen).toEqual(['stale-token', 'fresh-token']);
      expect(ctx.counts()).toEqual({ systemCalls: 1, userCalls: 1 });
      expect(refresh.calls()).toBe(0);
    } finally {
      refresh.restore();
    }
  });

  it('non-401 errors are rethrown without re-fetching secrets', async () => {
    const ctx = context(['token']);
    await initializeGoogleClients(ctx as any, { force: true });
    ctx.resetCounts();

    const error = Object.assign(new Error('boom'), { code: 500 });
    await expect(
      withAuthRetry(ctx as any, async () => Promise.reject(error), 'test-operation'),
    ).rejects.toBe(error);

    expect(ctx.counts()).toEqual({ systemCalls: 0, userCalls: 0 });
  });
});
