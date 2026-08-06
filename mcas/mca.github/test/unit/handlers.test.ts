import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import { GitHubApiError } from '../../src/lib/github-client';
import {
  addLabelsToIssue,
  cancelWorkflowRun,
  compareCommits,
  createCheckRun,
  createOrUpdateFile,
  createPrReview,
  createRelease,
  dispatchEvent,
  getRateLimit,
  getWorkflowRun,
  listPrFiles,
  listReleases,
  rerunWorkflowRun,
  requestReviewers,
  searchIssues,
  updateCheckRun,
} from '../../src/tools';

interface MockContext {
  getUserSecrets: () => Promise<Record<string, string>>;
  getSystemSecrets: () => Promise<Record<string, string>>;
}

// v5+ uses user-to-server access tokens. Tests inject USER_ACCESS_TOKEN
// directly so the resolver returns it without hitting the GitHub OAuth flow.
// INSTALLATION_ID is also present (legacy + autorun fallbacks may use it).
const ctx: MockContext = {
  getUserSecrets: async () => ({
    INSTALLATION_ID: '12345',
    USER_ACCESS_TOKEN: 'ghu_test_user_access_token_123',
    USER_REFRESH_TOKEN: 'ghr_test_refresh_token',
    USER_TOKEN_EXPIRES_AT: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    USER_LOGIN: 'octocat',
  }),
  getSystemSecrets: async () => ({
    GITHUB_APP_ID: '1',
    GITHUB_APP_CLIENT_ID: 'Iv23liEXAMPLE',
    GITHUB_APP_CLIENT_SECRET: 'cs_example',
    GITHUB_APP_PRIVATE_KEY: 'placeholder',
    GITHUB_APP_SLUG: 'teros',
  }),
};

interface FakeFetchSpec {
  status?: number;
  body?: unknown;
}

let originalFetch: typeof fetch;
let lastRequest: { url: string; init?: RequestInit } | null = null;

function mockFetch(spec: FakeFetchSpec) {
  const status = spec.status ?? 200;
  const body = spec.body ?? {};
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    lastRequest = { url: typeof input === 'string' ? input : input.toString(), init };
    const isError = status >= 400;
    return new Response(isError ? JSON.stringify(body) : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  lastRequest = null;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// =============================================================================
// Validation at the boundary
// =============================================================================

describe('handler-boundary validation', () => {
  it('compare-commits rejects malformed basehead', async () => {
    expect(
      compareCommits.handler({ owner: 'o', repo: 'r', basehead: 'just-a-branch' }, ctx as any),
    ).rejects.toThrow(/BASE\.\.\.HEAD/);
  });

  it('create-or-update-file rejects path traversal', async () => {
    expect(
      createOrUpdateFile.handler(
        { owner: 'o', repo: 'r', path: '../escape', message: 'msg', content: 'x' },
        ctx as any,
      ),
    ).rejects.toThrow(/\.\./);
  });

  it('create-or-update-file rejects leading slash', async () => {
    expect(
      createOrUpdateFile.handler(
        { owner: 'o', repo: 'r', path: '/abs', message: 'msg', content: 'x' },
        ctx as any,
      ),
    ).rejects.toThrow(/^.*must not start with `\/`/);
  });

  it('create-release rejects empty tag_name', async () => {
    expect(
      createRelease.handler({ owner: 'o', repo: 'r', tag_name: '   ' }, ctx as any),
    ).rejects.toThrow(/non-empty/);
  });

  it('add-labels-to-issue rejects empty array', async () => {
    expect(
      addLabelsToIssue.handler({ owner: 'o', repo: 'r', issue_number: 1, labels: [] }, ctx as any),
    ).rejects.toThrow(/non-empty/);
  });

  it('search-issues rejects empty query', async () => {
    expect(searchIssues.handler({ q: '   ' }, ctx as any)).rejects.toThrow(/non-empty/);
  });

  it('request-reviewers rejects when both lists are empty', async () => {
    expect(
      requestReviewers.handler({ owner: 'o', repo: 'r', pull_number: 1 }, ctx as any),
    ).rejects.toThrow(/At least one/);
  });

  it('create-pr-review rejects REQUEST_CHANGES without body', async () => {
    expect(
      createPrReview.handler(
        { owner: 'o', repo: 'r', pull_number: 1, event: 'REQUEST_CHANGES' },
        ctx as any,
      ),
    ).rejects.toThrow(/body.*required/);
  });
});

// =============================================================================
// Happy paths — verify URL + method + body
// =============================================================================

describe('handler URLs and methods', () => {
  it('list-pr-files hits the right endpoint', async () => {
    mockFetch({ body: [] });
    await listPrFiles.handler({ owner: 'octocat', repo: 'hello', pull_number: 7 }, ctx as any);
    expect(lastRequest?.url).toContain('/repos/octocat/hello/pulls/7/files');
    expect(lastRequest?.init?.method ?? 'GET').toBe('GET');
  });

  it('get-workflow-run hits the right endpoint', async () => {
    mockFetch({ body: { id: 99 } });
    await getWorkflowRun.handler({ owner: 'o', repo: 'r', run_id: 99 }, ctx as any);
    expect(lastRequest?.url).toContain('/repos/o/r/actions/runs/99');
  });

  it('rerun-workflow-run defaults to /rerun-failed-jobs', async () => {
    mockFetch({ status: 201, body: { ok: true } });
    await rerunWorkflowRun.handler({ owner: 'o', repo: 'r', run_id: 5 }, ctx as any);
    expect(lastRequest?.url).toContain('/rerun-failed-jobs');
    expect(lastRequest?.init?.method).toBe('POST');
  });

  it('rerun-workflow-run with mode=all hits /rerun', async () => {
    mockFetch({ status: 201, body: { ok: true } });
    await rerunWorkflowRun.handler({ owner: 'o', repo: 'r', run_id: 5, mode: 'all' }, ctx as any);
    expect(lastRequest?.url).toMatch(/\/actions\/runs\/5\/rerun$/);
  });

  it('cancel-workflow-run uses POST', async () => {
    mockFetch({ status: 202, body: {} });
    await cancelWorkflowRun.handler({ owner: 'o', repo: 'r', run_id: 5 }, ctx as any);
    expect(lastRequest?.init?.method).toBe('POST');
    expect(lastRequest?.url).toContain('/cancel');
  });

  it('list-releases serializes pagination params', async () => {
    mockFetch({ body: [] });
    await listReleases.handler({ owner: 'o', repo: 'r', per_page: 50, page: 2 }, ctx as any);
    expect(lastRequest?.url).toContain('per_page=50');
    expect(lastRequest?.url).toContain('page=2');
  });

  it('compare-commits encodes the basehead', async () => {
    mockFetch({ body: { status: 'ahead' } });
    await compareCommits.handler({ owner: 'o', repo: 'r', basehead: 'main...feat/x' }, ctx as any);
    expect(lastRequest?.url).toContain('main...feat%2Fx');
  });

  it('search-issues drops `best-match` sort to use default', async () => {
    mockFetch({ body: { total_count: 0, items: [] } });
    await searchIssues.handler({ q: 'is:open', sort: 'best-match' }, ctx as any);
    expect(lastRequest?.url).toContain('q=is%3Aopen');
    expect(lastRequest?.url).not.toContain('sort=');
  });

  it('search-issues passes through real sort values', async () => {
    mockFetch({ body: { total_count: 0, items: [] } });
    await searchIssues.handler({ q: 'is:open', sort: 'updated' }, ctx as any);
    expect(lastRequest?.url).toContain('sort=updated');
  });
});

// =============================================================================
// Error propagation — GitHubApiError preserves status + body
// =============================================================================

describe('App-native tools', () => {
  it('create-check-run requires conclusion when status is completed', async () => {
    expect(
      createCheckRun.handler(
        { owner: 'o', repo: 'r', name: 'Teros', head_sha: 'abc123', status: 'completed' },
        ctx as never,
      ),
    ).rejects.toThrow(/conclusion.*required/i);
  });

  it('create-check-run rejects empty name', async () => {
    expect(
      createCheckRun.handler(
        { owner: 'o', repo: 'r', name: '   ', head_sha: 'abc' },
        ctx as never,
      ),
    ).rejects.toThrow(/non-empty/);
  });

  it('create-check-run defaults status to queued and POSTs to /check-runs', async () => {
    mockFetch({ status: 201, body: { id: 99, name: 'Teros', head_sha: 'abc', status: 'queued' } });
    await createCheckRun.handler(
      { owner: 'o', repo: 'r', name: 'Teros', head_sha: 'abc' },
      ctx as never,
    );
    expect(lastRequest?.url).toContain('/repos/o/r/check-runs');
    expect(lastRequest?.init?.method).toBe('POST');
  });

  it('update-check-run requires conclusion when transitioning to completed', async () => {
    expect(
      updateCheckRun.handler(
        { owner: 'o', repo: 'r', check_run_id: 1, status: 'completed' },
        ctx as never,
      ),
    ).rejects.toThrow(/conclusion.*required/i);
  });

  it('update-check-run sends only the provided fields', async () => {
    mockFetch({ status: 200, body: { id: 5, status: 'completed', conclusion: 'success' } });
    await updateCheckRun.handler(
      {
        owner: 'o',
        repo: 'r',
        check_run_id: 5,
        status: 'completed',
        conclusion: 'success',
      },
      ctx as never,
    );
    expect(lastRequest?.url).toContain('/repos/o/r/check-runs/5');
    expect(lastRequest?.init?.method).toBe('PATCH');
    const body = lastRequest?.init?.body ? JSON.parse(lastRequest.init.body as string) : {};
    expect(body.status).toBe('completed');
    expect(body.conclusion).toBe('success');
    expect('name' in body).toBe(false);
  });

  it('get-rate-limit GETs /rate_limit with no params', async () => {
    mockFetch({ body: { resources: { core: { limit: 5000, remaining: 4980, used: 20, reset: 0 } } } });
    await getRateLimit.handler({}, ctx as never);
    expect(lastRequest?.url).toContain('/rate_limit');
    expect(lastRequest?.init?.method ?? 'GET').toBe('GET');
  });

  it('dispatch-event rejects empty event_type', async () => {
    expect(
      dispatchEvent.handler({ owner: 'o', repo: 'r', event_type: '' }, ctx as never),
    ).rejects.toThrow(/non-empty/);
  });

  it('dispatch-event POSTs to /dispatches with event_type + client_payload', async () => {
    mockFetch({ status: 204, body: '' });
    await dispatchEvent.handler(
      { owner: 'o', repo: 'r', event_type: 'deploy-staging', client_payload: { ref: 'v1.0' } },
      ctx as never,
    );
    expect(lastRequest?.url).toContain('/repos/o/r/dispatches');
    expect(lastRequest?.init?.method).toBe('POST');
    const body = lastRequest?.init?.body ? JSON.parse(lastRequest.init.body as string) : {};
    expect(body.event_type).toBe('deploy-staging');
    expect(body.client_payload).toEqual({ ref: 'v1.0' });
  });
});

describe('error propagation', () => {
  it('throws GitHubApiError on non-2xx, preserving the literal upstream message', async () => {
    mockFetch({ status: 422, body: { message: 'Validation Failed', errors: [{ field: 'head', code: 'invalid' }] } });
    try {
      await listPrFiles.handler({ owner: 'o', repo: 'r', pull_number: 1 }, ctx as any);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(GitHubApiError);
      const err = e as GitHubApiError;
      expect(err.status).toBe(422);
      expect(err.message).toBe('Validation Failed');
    }
  });
});
