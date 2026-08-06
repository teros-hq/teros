import { describe, expect, it } from 'bun:test';

import {
  GitHubAppNotInstalledError,
  __resetCacheForTests,
  getInstallUrl,
  resolveInstallationToken,
} from '../../src/lib/github-app-token';

interface MockContext {
  getSystemSecrets: () => Promise<Record<string, string>>;
  getUserSecrets: () => Promise<Record<string, string>>;
}

const baseSystemSecrets: Record<string, string> = {
  GITHUB_APP_ID: '1234567',
  GITHUB_APP_SLUG: 'teros',
  // Real RSA private key generation for the JWT path is heavy and brittle in
  // unit tests; we only exercise the no-installation path here. Full
  // signing+exchange is covered in smoke (Fase I).
  GITHUB_APP_PRIVATE_KEY: 'placeholder',
};

function ctx(opts: { systemSecrets?: Record<string, string>; userSecrets?: Record<string, string> }): MockContext {
  return {
    getSystemSecrets: async () => opts.systemSecrets ?? baseSystemSecrets,
    getUserSecrets: async () => opts.userSecrets ?? {},
  };
}

describe('resolveInstallationToken', () => {
  it('throws GitHubAppNotInstalledError when INSTALLATION_ID is missing', async () => {
    __resetCacheForTests();
    await expect(resolveInstallationToken(ctx({}) as never)).rejects.toThrow(
      GitHubAppNotInstalledError,
    );
  });

  it('the install URL embedded in the error uses the configured slug', async () => {
    __resetCacheForTests();
    try {
      await resolveInstallationToken(ctx({}) as never);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GitHubAppNotInstalledError);
      const e = err as GitHubAppNotInstalledError;
      expect(e.installUrl).toBe('https://github.com/apps/teros/installations/new');
      expect(e.code).toBe('APP_NOT_INSTALLED');
    }
  });

  it('falls back to default slug when GITHUB_APP_SLUG is missing', async () => {
    __resetCacheForTests();
    try {
      await resolveInstallationToken(
        ctx({
          systemSecrets: { GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: 'placeholder' },
        }) as never,
      );
      expect.unreachable();
    } catch (err) {
      expect((err as GitHubAppNotInstalledError).installUrl).toContain('/apps/teros/');
    }
  });
});

describe('getInstallUrl', () => {
  it('returns the slug-derived install URL', async () => {
    expect(await getInstallUrl(ctx({}) as never)).toBe(
      'https://github.com/apps/teros/installations/new',
    );
  });

  it('uses default slug when GITHUB_APP_SLUG is not in system secrets', async () => {
    expect(
      await getInstallUrl(
        ctx({
          systemSecrets: {
            GITHUB_APP_ID: '1',
            GITHUB_APP_PRIVATE_KEY: 'placeholder',
          },
        }) as never,
      ),
    ).toBe('https://github.com/apps/teros/installations/new');
  });
});
