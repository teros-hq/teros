import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import {
  GitHubApiError,
  GitHubInvalidInputError,
  GitHubTimeoutError,
  githubRequest,
  githubRequestPacing,
  assertGitHubSegment,
  assertOwnerRepo,
} from '../../src/lib/github-client';

interface MockContext {
  getUserSecrets: () => Promise<Record<string, string>>;
  getSystemSecrets: () => Promise<Record<string, string>>;
}

// v5+ user-to-server token: the resolver returns USER_ACCESS_TOKEN directly
// without hitting the OAuth flow (same pattern as handlers.test.ts).
const ctx: MockContext = {
  getUserSecrets: async () => ({ USER_ACCESS_TOKEN: 'ghu_test_user_access_token_123' }),
  getSystemSecrets: async () => ({}),
};

interface MockResponseSpec {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

interface CallLog {
  url: string;
  init?: RequestInit;
}

let originalFetch: typeof fetch;
let originalPacing: typeof githubRequestPacing;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalPacing = { ...githubRequestPacing };
  // Shrink delays so retry tests run in milliseconds instead of seconds:
  // backoff 5ms → 10ms → 20ms (jitter off), Retry-After honored up to 60ms.
  githubRequestPacing.baseDelayMs = 5;
  githubRequestPacing.maxRetryAfterMs = 60;
  githubRequestPacing.jitter = 0;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.assign(githubRequestPacing, originalPacing);
});

/**
 * Mock fetch with a scripted response sequence. The last spec repeats if the
 * client makes more calls than scripted (useful for "always fails" cases).
 * The special spec `'hang'` simulates a stalled connection: the promise
 * never resolves and rejects with an AbortError when the request's AbortSignal
 * fires — exactly what a real fetch does on abort.
 */
function mockFetchSequence(specs: Array<MockResponseSpec | 'hang'>): { calls: () => CallLog[] } {
  let call = 0;
  const calls: CallLog[] = [];
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const spec = specs[Math.min(call, specs.length - 1)];
    call += 1;
    if (spec === 'hang') {
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }
      });
    }
    return new Response(JSON.stringify(spec.body ?? { ok: true }), {
      status: spec.status ?? 200,
      headers: { 'Content-Type': 'application/json', ...spec.headers },
    });
  }) as unknown as typeof fetch;
  return { calls: () => calls };
}

// =============================================================================
// Timeout — a stalled connection aborts instead of hanging the tool call
// =============================================================================

describe('githubRequest timeout', () => {
  it('aborts a hanging fetch and throws GitHubTimeoutError (well under 2s)', async () => {
    mockFetchSequence(['hang']);
    const start = Date.now();
    try {
      await githubRequest(ctx as never, '/user', { timeoutMs: 30 });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(GitHubTimeoutError);
      const err = e as GitHubTimeoutError;
      expect(err.message).toBe('GitHub API timeout after 30ms: https://api.github.com/user');
      expect(err.status).toBe(0);
      expect(err.timedOut).toBe(true);
      expect(err.timeoutMs).toBe(30);
    }
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(25);
    expect(elapsed).toBeLessThan(2000);
  });

  it('GitHubTimeoutError extends GitHubApiError so existing handlers keep working', () => {
    const err = new GitHubTimeoutError(30, 'https://api.github.com/user');
    expect(err).toBeInstanceOf(GitHubApiError);
    expect(err.status).toBe(0);
  });

  it('a network error (not a timeout) is thrown as-is and not retried', async () => {
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls += 1;
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    try {
      await githubRequest(ctx as never, '/user');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(TypeError);
    }
    expect(calls).toBe(1);
  });
});

// =============================================================================
// Retry policy — 429 / transient 5xx only, method-aware
// =============================================================================

describe('githubRequest retry', () => {
  it('retries a 429 with Retry-After once and succeeds', async () => {
    const { calls } = mockFetchSequence([
      {
        status: 429,
        headers: { 'Retry-After': '0' },
        body: { message: 'You have exceeded a secondary rate limit' },
      },
      { status: 200, body: { login: 'octocat' } },
    ]);
    const result = (await githubRequest(ctx as never, '/user')) as { login: string };
    expect(result.login).toBe('octocat');
    expect(calls()).toHaveLength(2);
  });

  it('honors the server-advertised Retry-After (capped) rather than plain backoff', async () => {
    // Retry-After: 60 means 60s — the pacing cap (60ms in tests) keeps the
    // agent turn alive while still waiting longer than plain backoff (5ms),
    // which proves the advertised value is what paced the retry.
    const { calls } = mockFetchSequence([
      { status: 429, headers: { 'Retry-After': '60' } },
      { status: 200, body: { login: 'octocat' } },
    ]);
    const start = Date.now();
    await githubRequest(ctx as never, '/user');
    const elapsed = Date.now() - start;
    expect(calls()).toHaveLength(2);
    expect(elapsed).toBeGreaterThanOrEqual(50);
  });

  it('retries a transient 502 on GET and succeeds', async () => {
    const { calls } = mockFetchSequence([
      { status: 502, body: 'Bad gateway' },
      { status: 200, body: { login: 'octocat' } },
    ]);
    const result = (await githubRequest(ctx as never, '/user')) as { login: string };
    expect(result.login).toBe('octocat');
    expect(calls()).toHaveLength(2);
  });

  it('gives up after 2 retries and preserves rate-limit info on the final error', async () => {
    const { calls } = mockFetchSequence([
      {
        status: 429,
        headers: {
          'Retry-After': '0',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': '1760000000',
        },
      },
    ]);
    try {
      await githubRequest(ctx as never, '/user');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(GitHubApiError);
      const err = e as GitHubApiError;
      expect(err.status).toBe(429);
      expect(err.rateLimitRemaining).toBe(0);
      expect(err.rateLimitReset).toBe(1760000000);
    }
    expect(calls()).toHaveLength(3); // 1 attempt + 2 retries
  });

  it('does NOT retry 404', async () => {
    const { calls } = mockFetchSequence([{ status: 404, body: { message: 'Not Found' } }]);
    await expect(githubRequest(ctx as never, '/user')).rejects.toThrow(GitHubApiError);
    expect(calls()).toHaveLength(1);
  });

  it('does NOT retry other 4xx (422)', async () => {
    const { calls } = mockFetchSequence([{ status: 422, body: { message: 'Validation Failed' } }]);
    await expect(githubRequest(ctx as never, '/user')).rejects.toThrow(/Validation Failed/);
    expect(calls()).toHaveLength(1);
  });

  it('does NOT retry a 5xx on POST without Retry-After (the mutation may have applied)', async () => {
    const { calls } = mockFetchSequence([{ status: 500, body: { message: 'Internal' } }]);
    await expect(
      githubRequest(ctx as never, '/repos/o/r/issues', { method: 'POST', body: { title: 'x' } }),
    ).rejects.toThrow(GitHubApiError);
    expect(calls()).toHaveLength(1);
  });

  it('retries a 503 with Retry-After even on POST (GitHub says when to come back)', async () => {
    const { calls } = mockFetchSequence([
      { status: 503, headers: { 'Retry-After': '0' }, body: { message: 'Service unavailable' } },
      { status: 201, body: { number: 1 } },
    ]);
    const result = (await githubRequest(ctx as never, '/repos/o/r/issues', {
      method: 'POST',
      body: { title: 'x' },
    })) as { number: number };
    expect(result.number).toBe(1);
    expect(calls()).toHaveLength(2);
  });

  it('does NOT retry a 500 on POST even with Retry-After (only 503 advertises a safe retry)', async () => {
    const { calls } = mockFetchSequence([{ status: 500, headers: { 'Retry-After': '0' } }]);
    await expect(
      githubRequest(ctx as never, '/repos/o/r/issues', { method: 'POST', body: { title: 'x' } }),
    ).rejects.toThrow(GitHubApiError);
    expect(calls()).toHaveLength(1);
  });
});

// =============================================================================
// Backoff pacing
// =============================================================================

describe('githubRequest backoff pacing', () => {
  it('paces retries with exponential backoff (5ms → 10ms, jitter disabled)', async () => {
    const { calls } = mockFetchSequence([{ status: 502, body: 'Bad gateway' }]);
    const start = Date.now();
    await expect(githubRequest(ctx as never, '/user')).rejects.toThrow(GitHubApiError);
    const elapsed = Date.now() - start;
    expect(calls()).toHaveLength(3); // 1 attempt + 2 retries
    // Two sleeps: 5ms + 10ms = 15ms minimum with jitter off.
    expect(elapsed).toBeGreaterThanOrEqual(14);
  });
});

// =============================================================================
// Path/segment boundary validation — audit task_a8f981f535d6b3c3
// (parity with clone-repo's OWNER_REPO_RE)
// =============================================================================

describe('githubRequest path validation', () => {
  it('rejects a path with ".." before any fetch', async () => {
    const { calls } = mockFetchSequence([{ status: 200, body: {} }]);
    await expect(githubRequest(ctx as never, '/repos/../user')).rejects.toThrow(
      /\[GITHUB_INVALID_INPUT\].*path traversal.*"\/repos\/\.\.\/user"/,
    );
    expect(calls()).toHaveLength(0); // rejected before the network
  });

  it('rejects "." segments, "//", "?", "#", whitespace, control chars and backslash', async () => {
    const bad = [
      '/repos/./user',
      '/repos//o/r',
      '/repos/o/r?access_token=x',
      '/repos/o/r#frag',
      '/repos/o /r',
      '/repos/o\t/r',
      '/repos/o\r/r',
      '/repos\\o/r',
      'repos/o/r', // not rooted
      '', // empty
    ];
    const { calls } = mockFetchSequence([{ status: 200, body: {} }]);
    for (const p of bad) {
      await expect(githubRequest(ctx as never, p)).rejects.toThrow(GitHubInvalidInputError);
    }
    expect(calls()).toHaveLength(0);
  });

  it('rejects an absolute URL whose raw string contains ".." (URL parsing would hide it)', async () => {
    const { calls } = mockFetchSequence([{ status: 200, body: {} }]);
    await expect(
      githubRequest(ctx as never, 'https://api.github.com/repos/../user'),
    ).rejects.toThrow(/path traversal/);
    expect(calls()).toHaveLength(0);
  });

  it('accepts legitimate paths (refs with "/", encoded file paths, numeric ids)', async () => {
    const { calls } = mockFetchSequence([{ status: 200, body: {} }]);
    await githubRequest(ctx as never, '/repos/o/r/git/refs/heads/feat/x');
    await githubRequest(ctx as never, '/repos/o/r/contents/src%2Fmain.ts');
    await githubRequest(ctx as never, '/user/installations/12345/repositories');
    expect(calls()).toHaveLength(3);
    expect(calls()[0].url).toBe('https://api.github.com/repos/o/r/git/refs/heads/feat/x');
  });
});

describe('assertGitHubSegment / assertOwnerRepo', () => {
  it('rejects non-segment values with the offending field named', () => {
    expect(() => assertGitHubSegment('../../user', 'owner')).toThrow(
      /\[GITHUB_INVALID_INPUT\].*Invalid owner "\.\.\/\.\.\/user"/,
    );
    expect(() => assertGitHubSegment('x?access_token=1', 'org')).toThrow(
      /Invalid org "x\?access_token=1"/,
    );
    expect(() => assertGitHubSegment('a b', 'repo')).toThrow(/Invalid repo "a b"/);
    expect(() => assertGitHubSegment('', 'owner')).toThrow(/Invalid owner ""/);
    expect(() => assertGitHubSegment('-leading-dash', 'owner')).toThrow(/Invalid owner/);
    expect(() => assertOwnerRepo('ok', '../escape')).toThrow(/Invalid repo "\.\.\/escape"/);
  });

  it('passes undefined/null (optional parameter not provided)', () => {
    expect(() => assertGitHubSegment(undefined, 'org')).not.toThrow();
    expect(() => assertGitHubSegment(null, 'workflow_id')).not.toThrow();
    expect(() => assertOwnerRepo('o', undefined)).not.toThrow();
  });

  it('accepts legitimate identifiers (same charset as clone-repo)', () => {
    expect(() => assertOwnerRepo('octocat', 'hello-world')).not.toThrow();
    expect(() => assertOwnerRepo('Org_1', 'my.repo-2')).not.toThrow();
    expect(() => assertGitHubSegment('deploy.yml', 'workflow_id')).not.toThrow();
    expect(() => assertGitHubSegment('1234567', 'workflow_id')).not.toThrow();
  });

  it('GitHubInvalidInputError extends GitHubApiError with status 400 and the tag', () => {
    const err = new GitHubInvalidInputError('bad input');
    expect(err).toBeInstanceOf(GitHubApiError);
    expect(err.status).toBe(400);
    expect(err.message).toContain('[GITHUB_INVALID_INPUT]');
    expect(err.message).toContain('bad input');
  });
});
