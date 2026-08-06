import { describe, expect, it } from 'bun:test';

import { GitHubAppNotInstalledError } from '../../src/lib/github-app-token';
import { GitHubApiError } from '../../src/lib/github-client';
import { GitHubUserNotAuthenticatedError } from '../../src/lib/github-user-token';
import { classifyGitHubError } from '../../src/tools/_github-error';

function err(opts: {
  status: number;
  message?: string;
  errors?: Array<{ resource?: string; field?: string; code?: string; message?: string }>;
  documentationUrl?: string | null;
  rateLimitRemaining?: number | null;
  rateLimitReset?: number | null;
}) {
  return new GitHubApiError({
    status: opts.status,
    statusText: '',
    body: { message: opts.message, errors: opts.errors },
    documentationUrl: opts.documentationUrl ?? null,
    rateLimitRemaining: opts.rateLimitRemaining ?? null,
    rateLimitReset: opts.rateLimitReset ?? null,
  });
}

describe('classifyGitHubError', () => {
  it('maps 401 to AUTH_EXPIRED with install URL action', () => {
    const c = classifyGitHubError(err({ status: 401, message: 'Bad credentials' }));
    expect(c.code).toBe('AUTH_EXPIRED');
    expect(c.message).toBe('Bad credentials');
    expect(c.action.url).toContain('/apps/teros/installations/new');
  });

  it('maps GitHubAppNotInstalledError to APP_NOT_INSTALLED with install URL', () => {
    const c = classifyGitHubError(
      new GitHubAppNotInstalledError('https://github.com/apps/teros/installations/new'),
    );
    expect(c.code).toBe('APP_NOT_INSTALLED');
    expect(c.action.url).toBe('https://github.com/apps/teros/installations/new');
  });

  it('maps GitHubUserNotAuthenticatedError to USER_NOT_AUTHENTICATED with reconnect URL', () => {
    const c = classifyGitHubError(
      new GitHubUserNotAuthenticatedError('https://github.com/apps/teros/installations/new'),
    );
    expect(c.code).toBe('USER_NOT_AUTHENTICATED');
    expect(c.action.url).toBe('https://github.com/apps/teros/installations/new');
    expect(c.action.description).toMatch(/reconecta/i);
  });

  it('maps 403 with "resource not accessible by integration" to INSUFFICIENT_PERMISSIONS', () => {
    const c = classifyGitHubError(
      err({ status: 403, message: 'Resource not accessible by integration' }),
    );
    expect(c.code).toBe('INSUFFICIENT_PERMISSIONS');
    expect(c.action.description).toMatch(/permission/i);
  });

  it('maps 403 with "installation not authorized" to APP_NOT_INSTALLED', () => {
    const c = classifyGitHubError(
      err({ status: 403, message: 'This installation has been suspended' }),
    );
    expect(c.code).toBe('APP_NOT_INSTALLED');
  });

  it('maps 403 + scope literal to PERMISSION_DENIED', () => {
    const c = classifyGitHubError(err({ status: 403, message: "Resource not accessible by personal access token's scopes" }));
    expect(c.code).toBe('PERMISSION_DENIED');
    expect(c.action.description).toMatch(/scope/);
  });

  it('maps 403 + rate-limit literal to RATE_LIMITED', () => {
    const c = classifyGitHubError(
      err({ status: 403, message: 'API rate limit exceeded for user', rateLimitRemaining: 0, rateLimitReset: 1735689600 }),
    );
    expect(c.code).toBe('RATE_LIMITED');
    expect(c.rateLimitReset).toBe(1735689600);
  });

  it('maps 403 + abuse literal to SECONDARY_RATE_LIMIT', () => {
    const c = classifyGitHubError(
      err({ status: 403, message: 'You have triggered an abuse detection mechanism' }),
    );
    expect(c.code).toBe('SECONDARY_RATE_LIMIT');
  });

  it('maps 404 to NOT_FOUND', () => {
    const c = classifyGitHubError(err({ status: 404, message: 'Not Found' }));
    expect(c.code).toBe('NOT_FOUND');
    expect(c.message).toBe('Not Found');
  });

  it('maps 422 to VALIDATION and surfaces the errors[] detail', () => {
    const c = classifyGitHubError(
      err({
        status: 422,
        message: 'Validation Failed',
        errors: [{ resource: 'PullRequest', field: 'head', code: 'invalid' }],
      }),
    );
    expect(c.code).toBe('VALIDATION');
    expect(c.action.description).toMatch(/PullRequest\.head/);
  });

  it('maps 409 to CONFLICT', () => {
    const c = classifyGitHubError(err({ status: 409, message: 'Conflict' }));
    expect(c.code).toBe('CONFLICT');
  });

  it('maps 5xx to SERVER_ERROR with status URL', () => {
    const c = classifyGitHubError(err({ status: 500, message: 'Internal' }));
    expect(c.code).toBe('SERVER_ERROR');
    expect(c.action.url).toBe('https://www.githubstatus.com/');
  });

  it('falls back to UNKNOWN on unexpected status', () => {
    const c = classifyGitHubError(err({ status: 418, message: "I'm a teapot" }));
    expect(c.code).toBe('UNKNOWN');
    expect(c.message).toBe("I'm a teapot");
  });

  it('classifies plain network errors as NETWORK_ERROR', () => {
    const c = classifyGitHubError(new TypeError('fetch failed'));
    expect(c.code).toBe('NETWORK_ERROR');
  });

  it('classifies arbitrary Error as UNKNOWN preserving the literal', () => {
    const c = classifyGitHubError(new Error('boom'));
    expect(c.code).toBe('UNKNOWN');
    expect(c.message).toBe('boom');
  });

  it('preserves documentation_url', () => {
    const c = classifyGitHubError(
      err({ status: 422, message: 'Validation Failed', documentationUrl: 'https://docs.github.com/x' }),
    );
    expect(c.documentationUrl).toBe('https://docs.github.com/x');
  });
});
