/**
 * SSRF guard (S1) — adversarial. Mirrors core/src/llm/ImagePipeline.ssrf.test.ts
 * but for the DENYLIST + DNS model: arbitrary public hosts allowed, internal /
 * private / metadata destinations blocked, redirects re-validated per hop.
 *
 * DNS is driven through the `resolveHost` test seam (no real network, no module
 * mocking → no global leak). safeFetch's `fetch` boundary is mocked with REAL
 * Response objects (status + native Headers) and restored in finally.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import {
  assertPublicUrl,
  BlockedUrlError,
  isPrivateAddress,
  isPrivateHostLiteral,
  navigateSafely,
  safeFetch,
} from '../src/url-validation';

/** A resolveHost that maps a host to fixed addresses (DNS rebinding under test). */
const resolveTo = (map: Record<string, string[]>) => async (host: string) => {
  const addrs = map[host];
  if (!addrs) throw new Error(`NXDOMAIN ${host}`);
  return addrs.map((address) => ({ address }));
};
const publicDns = resolveTo({ 'good.example': ['93.184.216.34'] });

describe('isPrivateAddress', () => {
  it('flags loopback / RFC1918 / link-local / metadata / ULA', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1']) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
  });
  it('passes genuine public addresses', () => {
    for (const ip of ['93.184.216.34', '8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:2800:220:1:248:1893:25c8:1946']) {
      expect(isPrivateAddress(ip)).toBe(false);
    }
  });
  it('treats a non-IP string as unsafe (fail closed)', () => {
    expect(isPrivateAddress('not-an-ip')).toBe(true);
    expect(isPrivateAddress('')).toBe(true);
  });
});

describe('assertPublicUrl — scheme / port', () => {
  it('rejects non-http(s) schemes', async () => {
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow(/^\[BLOCKED_SCHEME\]/);
    await expect(assertPublicUrl('ftp://good.example/x', { resolveHost: publicDns })).rejects.toThrow(/^\[BLOCKED_SCHEME\]/);
    await expect(assertPublicUrl('javascript:alert(1)')).rejects.toThrow(/^\[BLOCKED_SCHEME\]/);
  });
  it('rejects a non-default port', async () => {
    await expect(assertPublicUrl('http://good.example:8080/x', { resolveHost: publicDns })).rejects.toThrow(/^\[BLOCKED_PORT\]/);
  });
  it('rejects garbage that is not a URL', async () => {
    await expect(assertPublicUrl('not a url')).rejects.toThrow(/^\[BLOCKED_URL\]/);
  });
});

describe('assertPublicUrl — internal hostnames + literal IPs', () => {
  it('rejects internal hostnames without DNS', async () => {
    for (const h of ['http://localhost/x', 'http://host.docker.internal/x', 'http://db.internal/x', 'http://printer.local/x']) {
      await expect(assertPublicUrl(h)).rejects.toThrow(/^\[BLOCKED_PRIVATE\]/);
    }
  });
  it('rejects literal private / metadata IPs', async () => {
    for (const h of ['http://127.0.0.1/x', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.5/x', 'http://192.168.1.1/x', 'http://[::1]/x']) {
      await expect(assertPublicUrl(h)).rejects.toThrow(/^\[BLOCKED_PRIVATE\]/);
    }
  });
  it('accepts a literal public IP', async () => {
    await expect(assertPublicUrl('https://93.184.216.34/x')).resolves.toBeUndefined();
  });
});

describe('assertPublicUrl — DNS resolution (rebinding)', () => {
  it('rejects a public hostname that resolves to a private IP', async () => {
    const dns = resolveTo({ 'evil.example': ['127.0.0.1'] });
    await expect(assertPublicUrl('https://evil.example/x', { resolveHost: dns })).rejects.toThrow(
      /^\[BLOCKED_PRIVATE\].*127\.0\.0\.1/,
    );
  });
  it('rejects when ANY resolved address is private (mixed records)', async () => {
    const dns = resolveTo({ 'mixed.example': ['93.184.216.34', '10.1.2.3'] });
    await expect(assertPublicUrl('https://mixed.example/x', { resolveHost: dns })).rejects.toThrow(/^\[BLOCKED_PRIVATE\]/);
  });
  it('accepts a hostname that resolves to only public IPs', async () => {
    await expect(assertPublicUrl('https://good.example/x', { resolveHost: publicDns })).resolves.toBeUndefined();
  });
  it('rejects an unresolvable host', async () => {
    await expect(assertPublicUrl('https://nope.example/x', { resolveHost: resolveTo({}) })).rejects.toThrow(
      /^\[BLOCKED_PRIVATE\] could not resolve/,
    );
  });
});

describe('isPrivateHostLiteral', () => {
  it('is true for literal private IPs / internal names, false for public hosts', () => {
    expect(isPrivateHostLiteral('http://169.254.169.254/x')).toBe(true);
    expect(isPrivateHostLiteral('http://127.0.0.1/x')).toBe(true);
    expect(isPrivateHostLiteral('http://localhost/x')).toBe(true);
    expect(isPrivateHostLiteral('https://example.com/x')).toBe(false); // hostname, not re-resolved here
    expect(isPrivateHostLiteral('https://93.184.216.34/x')).toBe(false);
  });
});

describe('safeFetch — per-hop redirect re-validation', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  function withFetch(fn: (url: string) => Response): string[] {
    const calls: string[] = [];
    globalThis.fetch = ((url: any) => {
      calls.push(String(url));
      return Promise.resolve(fn(String(url)));
    }) as any;
    return calls;
  }
  const ok = () => new Response('hi', { status: 200 });
  const redirectTo = (location: string, status = 302) => new Response(null, { status, headers: { location } });

  it('blocks a redirect from a public host to the metadata endpoint (never fetched)', async () => {
    const calls = withFetch((url) =>
      url === 'https://good.example/' ? redirectTo('http://169.254.169.254/latest/meta-data/') : ok(),
    );
    await expect(safeFetch('https://good.example/', {}, { resolveHost: publicDns })).rejects.toThrow(/^\[BLOCKED_PRIVATE\]/);
    expect(calls).toEqual(['https://good.example/']); // the internal hop was NEVER requested
  });

  it('returns the first non-redirect response on a direct 200', async () => {
    const calls = withFetch(() => ok());
    const res = await safeFetch('https://good.example/', {}, { resolveHost: publicDns });
    expect(res.status).toBe(200);
    expect(calls.length).toBe(1);
  });

  it('follows a redirect to another public host and re-validates it', async () => {
    const dns = resolveTo({ 'a.example': ['93.184.216.34'], 'b.example': ['8.8.8.8'] });
    const calls = withFetch((url) => (url === 'https://a.example/' ? redirectTo('https://b.example/x') : ok()));
    const res = await safeFetch('https://a.example/', {}, { resolveHost: dns });
    expect(res.status).toBe(200);
    expect(calls).toEqual(['https://a.example/', 'https://b.example/x']);
  });

  it('aborts after the redirect cap', async () => {
    const dns = resolveTo({ 'loop.example': ['93.184.216.34'] });
    const calls = withFetch(() => redirectTo('https://loop.example/next'));
    await expect(safeFetch('https://loop.example/', {}, { resolveHost: dns, maxRedirects: 3 })).rejects.toThrow(
      /^\[BLOCKED_REDIRECT\] too many redirects/,
    );
    expect(calls.length).toBe(4); // initial + 3 hops, then capped
  });

  it('rejects a redirect with no Location header', async () => {
    withFetch(() => new Response(null, { status: 302 }));
    await expect(safeFetch('https://good.example/', {}, { resolveHost: publicDns })).rejects.toThrow(
      /^\[BLOCKED_REDIRECT\].*no Location/,
    );
  });
});

describe('safeFetch — credential + body stripping on redirect (M2)', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  // Capture each (url, init) the guard hands to fetch — M2 is about what is sent,
  // not just where, so we assert on the per-hop init, not only the URL list.
  function withFetchCapturing(fn: (url: string) => Response): Array<{ url: string; init: RequestInit }> {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = ((url: any, init: any) => {
      calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
      return Promise.resolve(fn(String(url)));
    }) as any;
    return calls;
  }
  const ok = () => new Response('hi', { status: 200 });
  const redirectTo = (location: string, status = 302) => new Response(null, { status, headers: { location } });
  const hdr = (init: RequestInit, name: string) => new Headers(init.headers as HeadersInit).get(name);
  const ab = { 'a.example': ['93.184.216.34'], 'b.example': ['8.8.8.8'] };

  it('strips Authorization/Cookie on a CROSS-ORIGIN redirect (open-redirect leak)', async () => {
    const calls = withFetchCapturing((url) => (url === 'https://a.example/' ? redirectTo('https://b.example/x') : ok()));
    await safeFetch(
      'https://a.example/',
      { headers: { Authorization: 'Bearer SECRET', Cookie: 'sid=1' } },
      { resolveHost: resolveTo(ab) },
    );
    expect(hdr(calls[0].init, 'authorization')).toBe('Bearer SECRET'); // sent to the original host
    expect(hdr(calls[1].init, 'authorization')).toBeNull(); // NOT forwarded to the attacker host
    expect(hdr(calls[1].init, 'cookie')).toBeNull();
  });

  it('KEEPS credentials on a SAME-ORIGIN redirect', async () => {
    const calls = withFetchCapturing((url) =>
      url === 'https://a.example/' ? redirectTo('https://a.example/next') : ok(),
    );
    await safeFetch('https://a.example/', { headers: { Authorization: 'Bearer SECRET' } }, { resolveHost: resolveTo(ab) });
    expect(hdr(calls[1].init, 'authorization')).toBe('Bearer SECRET'); // same origin → preserved
  });

  it('downgrades 303 to GET and drops the body', async () => {
    const calls = withFetchCapturing((url) =>
      url === 'https://a.example/' ? redirectTo('https://a.example/done', 303) : ok(),
    );
    await safeFetch('https://a.example/', { method: 'POST', body: '{"secret":"x"}' }, { resolveHost: resolveTo(ab) });
    expect(calls[1].init.method ?? 'GET').toBe('GET');
    expect(calls[1].init.body == null).toBe(true);
  });

  it('301 to a new origin: GET + no body + no credentials', async () => {
    const calls = withFetchCapturing((url) => (url === 'https://a.example/' ? redirectTo('https://b.example/x', 301) : ok()));
    await safeFetch(
      'https://a.example/',
      { method: 'POST', body: 'x', headers: { Authorization: 'Bearer S' } },
      { resolveHost: resolveTo(ab) },
    );
    expect(calls[1].init.method).toBe('GET');
    expect(calls[1].init.body == null).toBe(true);
    expect(hdr(calls[1].init, 'authorization')).toBeNull();
  });

  it('307 PRESERVES method + body + same-origin credentials', async () => {
    const calls = withFetchCapturing((url) =>
      url === 'https://a.example/' ? redirectTo('https://a.example/next', 307) : ok(),
    );
    await safeFetch(
      'https://a.example/',
      { method: 'POST', body: 'payload', headers: { Authorization: 'Bearer S' } },
      { resolveHost: resolveTo(ab) },
    );
    expect(calls[1].init.method).toBe('POST'); // 307 keeps the method
    expect(calls[1].init.body).toBe('payload'); // and the body
    expect(hdr(calls[1].init, 'authorization')).toBe('Bearer S');
  });
});

describe('navigateSafely', () => {
  it('asserts the URL before navigating and blocks internal targets', async () => {
    let navigated = false;
    const page = { goto: async () => { navigated = true; } };
    await expect(navigateSafely(page, 'http://169.254.169.254/x')).rejects.toThrow(/^\[BLOCKED_PRIVATE\]/);
    expect(navigated).toBe(false);
  });
  it('navigates a public URL and returns goto result', async () => {
    const page = { goto: async (u: string) => `ok:${u}` };
    expect(await navigateSafely(page, 'https://good.example/', { resolveHost: publicDns })).toBe('ok:https://good.example/');
  });
  it('throws BlockedUrlError (typed) for blocked input', async () => {
    const page = { goto: async () => undefined };
    await expect(navigateSafely(page, 'file:///etc/passwd')).rejects.toBeInstanceOf(BlockedUrlError);
  });
});
