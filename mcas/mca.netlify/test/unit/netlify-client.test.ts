/**
 * Netlify client unit tests — the pure, load-bearing helpers.
 *
 * `uploadPath` is the trickiest bit of the deploy flow: the digest declares
 * paths with a leading slash (`/css/app.css`) but the PUT upload URL must use
 * the path WITHOUT a leading slash and with each segment escaped (verified
 * against Netlify's file-digest API docs). A regression here makes every upload
 * mismatch its declared digest entry.
 */

import { describe, expect, it } from 'bun:test';
import {
  classify,
  collectPages,
  extractMessage,
  NetlifyApiError,
  NetlifyClient,
  uploadPath,
} from '../../src/lib/netlify-client';

describe('uploadPath', () => {
  it('strips the leading slash for a top-level file', () => {
    expect(uploadPath('/index.html')).toBe('index.html');
  });

  it('strips the leading slash and keeps subdirectory separators', () => {
    expect(uploadPath('/css/app.css')).toBe('css/app.css');
    expect(uploadPath('/a/b/c.js')).toBe('a/b/c.js');
  });

  it('escapes special characters per segment (spaces, #) but keeps slashes', () => {
    expect(uploadPath('/my file.html')).toBe('my%20file.html');
    expect(uploadPath('/dir/weird#.html')).toBe('dir/weird%23.html');
  });

  it('collapses multiple leading slashes', () => {
    expect(uploadPath('//foo')).toBe('foo');
    expect(uploadPath('///a/b')).toBe('a/b');
  });

  it('handles a path that has no leading slash', () => {
    expect(uploadPath('foo/bar.js')).toBe('foo/bar.js');
    expect(uploadPath('index.html')).toBe('index.html');
  });
});

describe('classify', () => {
  it('maps HTTP status codes to error codes', () => {
    expect(classify(401)).toBe('AUTH_INVALID');
    expect(classify(403)).toBe('AUTH_INVALID');
    expect(classify(404)).toBe('NOT_FOUND');
    expect(classify(422)).toBe('INVALID_REQUEST');
    expect(classify(429)).toBe('RATE_LIMITED');
    expect(classify(500)).toBe('UPSTREAM_ERROR');
    expect(classify(503)).toBe('UPSTREAM_ERROR');
    expect(classify(400)).toBe('REQUEST_FAILED');
    expect(classify(418)).toBe('REQUEST_FAILED');
  });
});

describe('collectPages', () => {
  const page = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}` }));

  it('follows pages until a short page ends the run', async () => {
    const pages = [page('a', 100), page('b', 100), page('c', 30)];
    const requested: number[] = [];
    const all = await collectPages(
      async (p) => {
        requested.push(p);
        return pages[p - 1] ?? [];
      },
      100,
      50,
    );
    expect(all).toHaveLength(230);
    expect(requested).toEqual([1, 2, 3]); // stopped after the 30-item page
  });

  it('stops immediately on an empty first page', async () => {
    let calls = 0;
    const all = await collectPages(async () => {
      calls += 1;
      return [];
    });
    expect(all).toEqual([]);
    expect(calls).toBe(1);
  });

  it('honours maxPages so a full-page server cannot loop forever', async () => {
    let calls = 0;
    const all = await collectPages(
      async (_p, perPage) => {
        calls += 1;
        return page('x', perPage); // always a full page
      },
      10,
      3,
    );
    expect(calls).toBe(3);
    expect(all).toHaveLength(30);
  });
});

describe('NetlifyClient — cancellation', () => {
  it('getDeploy throws [CANCELLED] when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const client = new NetlifyClient('tok', ac.signal);
    const err = await client.getDeploy('dep_1').catch((e) => e);
    expect(err).toBeInstanceOf(NetlifyApiError);
    expect(err.code).toBe('CANCELLED');
    expect(err.message).toMatch(/\[CANCELLED\]/);
  });
});

describe('extractMessage', () => {
  it('reads `message` from a JSON error body', () => {
    expect(extractMessage('{"code":404,"message":"Not Found"}', 'fallback')).toBe('Not Found');
  });

  it('falls back to `error` then `error_description`', () => {
    expect(extractMessage('{"error":"bad token"}', 'fallback')).toBe('bad token');
    expect(extractMessage('{"error_description":"expired"}', 'fallback')).toBe('expired');
  });

  it('returns the raw text when the body is not JSON', () => {
    expect(extractMessage('plain text error', 'fallback')).toBe('plain text error');
  });

  it('returns the fallback for an empty body', () => {
    expect(extractMessage('', 'Unauthorized')).toBe('Unauthorized');
  });

  it('ignores a null `message` field and falls back to the raw body', () => {
    // `message: null` is nullish, so it must NOT surface as the literal "null";
    // with no other usable field the raw JSON body is returned verbatim.
    expect(extractMessage('{"message":null}', 'fallback')).toBe('{"message":null}');
  });

  it('prefers a non-empty `error` when `message` is null', () => {
    expect(extractMessage('{"message":null,"error":"boom"}', 'fallback')).toBe('boom');
  });
});

describe('NetlifyApiError', () => {
  it('prefixes the message with [CODE] and preserves the upstream message', () => {
    const err = new NetlifyApiError('AUTH_INVALID', 'token is invalid', 401);
    expect(err.message).toBe('[AUTH_INVALID] token is invalid');
    expect(err.upstreamMessage).toBe('token is invalid');
    expect(err.code).toBe('AUTH_INVALID');
    expect(err.httpStatus).toBe(401);
    expect(err).toBeInstanceOf(Error);
  });
});
