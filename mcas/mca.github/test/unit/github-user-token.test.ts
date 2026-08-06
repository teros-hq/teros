import { describe, expect, it } from 'bun:test';

import {
  GitHubUserNotAuthenticatedError,
  getInstallUrl,
  resolveUserToken,
} from '../../src/lib/github-user-token';

interface MockContext {
  getSystemSecrets: () => Promise<Record<string, string>>;
  getUserSecrets: () => Promise<Record<string, string>>;
}

const baseSystemSecrets: Record<string, string> = {
  GITHUB_APP_ID: '1234567',
  GITHUB_APP_SLUG: 'teros',
  GITHUB_APP_CLIENT_ID: 'Iv23liEXAMPLE',
  GITHUB_APP_CLIENT_SECRET: 'cs_example',
  GITHUB_APP_PRIVATE_KEY: 'placeholder',
};

function ctx(opts: {
  systemSecrets?: Record<string, string>;
  userSecrets?: Record<string, string>;
}): MockContext {
  return {
    getSystemSecrets: async () => opts.systemSecrets ?? baseSystemSecrets,
    getUserSecrets: async () => opts.userSecrets ?? {},
  };
}

describe('resolveUserToken', () => {
  it('returns USER_ACCESS_TOKEN when present', async () => {
    const token = await resolveUserToken(
      ctx({ userSecrets: { USER_ACCESS_TOKEN: 'ghu_example' } }) as never,
    );
    expect(token).toBe('ghu_example');
  });

  it('throws GitHubUserNotAuthenticatedError when USER_ACCESS_TOKEN missing', async () => {
    await expect(resolveUserToken(ctx({}) as never)).rejects.toThrow(
      GitHubUserNotAuthenticatedError,
    );
  });

  it('error code is USER_NOT_AUTHENTICATED with slug-derived install URL', async () => {
    try {
      await resolveUserToken(ctx({}) as never);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GitHubUserNotAuthenticatedError);
      const e = err as GitHubUserNotAuthenticatedError;
      expect(e.code).toBe('USER_NOT_AUTHENTICATED');
      expect(e.installUrl).toBe('https://github.com/apps/teros/installations/new');
    }
  });

  it('falls back to default slug when GITHUB_APP_SLUG missing', async () => {
    try {
      await resolveUserToken(
        ctx({ systemSecrets: { GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: 'pk' } }) as never,
      );
      expect.unreachable();
    } catch (err) {
      expect((err as GitHubUserNotAuthenticatedError).installUrl).toContain('/apps/teros/');
    }
  });

  it('having only INSTALLATION_ID without USER_ACCESS_TOKEN still triggers re-auth', async () => {
    // Legacy users post-migration: INSTALLATION_ID present but no user token.
    await expect(
      resolveUserToken(ctx({ userSecrets: { INSTALLATION_ID: '130269857' } }) as never),
    ).rejects.toThrow(GitHubUserNotAuthenticatedError);
  });
});

describe('getInstallUrl', () => {
  it('returns the slug-derived install URL', async () => {
    expect(await getInstallUrl(ctx({}) as never)).toBe(
      'https://github.com/apps/teros/installations/new',
    );
  });
});
