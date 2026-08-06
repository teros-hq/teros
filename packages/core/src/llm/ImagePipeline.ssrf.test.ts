/**
 * ImagePipeline — SSRF adversarial (TER-458).
 *
 * Ejercita `isValidUrl` (privado, accedido vía `as any`) contra vectores
 * de exfiltración. Complementa ImagePipeline.test.ts (que cubre el
 * fail-closed sin allowlist y el happy path de dominios) con los ataques:
 * substring bypass de whitelist, schemes no-http (data:/file:/javascript:/
 * ftp:), e IPs internas/metadata cuando NO están en la allowlist.
 *
 * Los dos gaps SSRF de downloadImage (redirect sin revalidar + path
 * traversal en /workspace/) se ARREGLARON en este mismo PR (TER-458):
 *   1. downloadImage sigue redirects MANUALMENTE y revalida cada hop.
 *   2. isValidUrl + downloadImage normalizan /workspace/ y rechazan `..`.
 * Smoke con MCAs reales pendiente de validación de Antonio (TER-479 queda
 * como verificación de smoke, no como fix pendiente).
 */

import { describe, expect, it, mock } from 'bun:test';
import { ImagePipeline } from './ImagePipeline';

/** Acceso directo al validador privado, con allowlist explícita. */
function validator(allowedDomains: string[] | null) {
  const pipeline = new ImagePipeline({ allowedDomains });
  return (url: string): boolean => (pipeline as any).isValidUrl(url);
}

describe('isValidUrl — scheme rejection', () => {
  const isValid = validator(['cdn.teros.ai']);

  it('rejects non-http(s) schemes even on an allowed host', () => {
    expect(isValid('ftp://cdn.teros.ai/x.png')).toBe(false);
    expect(isValid('ws://cdn.teros.ai/x')).toBe(false);
  });

  it('rejects data: URIs (inline payload smuggling)', () => {
    expect(isValid('data:image/png;base64,iVBORw0KGgo=')).toBe(false);
  });

  it('rejects file: URIs (local file read)', () => {
    expect(isValid('file:///etc/passwd')).toBe(false);
    expect(isValid('file://localhost/etc/passwd')).toBe(false);
  });

  it('rejects javascript: and other exotic schemes', () => {
    expect(isValid('javascript:alert(1)')).toBe(false);
    expect(isValid('gopher://cdn.teros.ai/x')).toBe(false);
  });

  it('rejects garbage that is not a URL at all', () => {
    expect(isValid('not a url')).toBe(false);
    expect(isValid('')).toBe(false);
    expect(isValid('http://')).toBe(false);
  });
});

describe('isValidUrl — whitelist substring bypass resistance', () => {
  const isValid = validator(['cdn.teros.ai']);

  it('accepts the exact allowed host', () => {
    expect(isValid('https://cdn.teros.ai/img.png')).toBe(true);
    expect(isValid('http://cdn.teros.ai/img.png')).toBe(true);
  });

  it('accepts a true subdomain (dot-boundary)', () => {
    expect(isValid('https://assets.cdn.teros.ai/img.png')).toBe(true);
  });

  it('rejects a suffix-append bypass (allowed host as a left label)', () => {
    expect(isValid('https://cdn.teros.ai.attacker.com/x')).toBe(false);
  });

  it('rejects a TLD-swap bypass', () => {
    expect(isValid('https://cdn.teros.ai.co/x')).toBe(false);
  });

  it('rejects a prefix-glued host with no dot boundary', () => {
    expect(isValid('https://xcdn.teros.ai/x')).toBe(false);
    expect(isValid('https://evilcdn.teros.ai/x')).toBe(false);
  });

  it('rejects the allowed host embedded in the path of another host', () => {
    expect(isValid('https://attacker.com/cdn.teros.ai/x')).toBe(false);
  });

  it('hostname comparison is case-insensitive', () => {
    expect(isValid('https://CDN.TEROS.AI/img.png')).toBe(true);
  });
});

describe('isValidUrl — internal IPs / metadata endpoints', () => {
  const isValid = validator(['cdn.teros.ai']);

  it('rejects loopback and internal ranges not on the allowlist', () => {
    expect(isValid('http://127.0.0.1/x')).toBe(false);
    expect(isValid('http://localhost/x')).toBe(false);
    expect(isValid('http://10.0.0.5/x')).toBe(false);
    expect(isValid('http://192.168.1.1/x')).toBe(false);
  });

  it('rejects the cloud metadata endpoint (169.254.169.254)', () => {
    expect(isValid('http://169.254.169.254/latest/meta-data/')).toBe(false);
  });

  it('rejects IPv6 loopback', () => {
    expect(isValid('http://[::1]/x')).toBe(false);
  });
});

describe('isValidUrl — fail-closed configuration', () => {
  it('with an empty allowlist, rejects every remote URL', () => {
    const isValid = validator([]);
    expect(isValid('https://cdn.teros.ai/img.png')).toBe(false);
    expect(isValid('http://anything/x')).toBe(false);
  });

  it('with null allowlist, rejects every remote URL', () => {
    const isValid = validator(null);
    expect(isValid('https://cdn.teros.ai/img.png')).toBe(false);
  });
});

describe('isValidUrl — /workspace/ local paths (DOCUMENTED current behavior)', () => {
  const isValid = validator(['cdn.teros.ai']);

  it('accepts a clean /workspace/ path regardless of allowlist', () => {
    expect(isValid('/workspace/uploads/img.png')).toBe(true);
    expect(isValid('/workspace/a/b/c.png')).toBe(true);
  });

  it('accepts the workspace root and harmless internal "." segments', () => {
    expect(isValid('/workspace/')).toBe(true);
    expect(isValid('/workspace/./img.png')).toBe(true);
    expect(isValid('/workspace/sub/../img.png')).toBe(true); // resuelve a /workspace/img.png
  });

  it('rejects traversal that escapes the workspace root (fixed in TER-458)', () => {
    expect(isValid('/workspace/../../../etc/passwd')).toBe(false);
    expect(isValid('/workspace/../etc/passwd')).toBe(false);
    expect(isValid('/workspace/a/../../secret')).toBe(false);
  });

  it('a path that merely contains "/workspace/" mid-string is treated as a URL (rejected)', () => {
    // No empieza por /workspace/ → cae al parseo de URL → inválido.
    expect(isValid('https://attacker.com/workspace/x')).toBe(false);
    expect(isValid('/uploads/workspace/x')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// downloadImage — redirect revalidation (fixed in TER-458)
//
// fetch es el boundary; lo mockeamos con Responses REALES (status + Headers
// nativo con Location) para reproducir el comportamiento de undici/bun:
// redirect: 'manual' devuelve la respuesta 3xx con headers accesibles.
// ─────────────────────────────────────────────────────────────────────────────

describe('downloadImage — manual redirect re-validation', () => {
  const realFetch = globalThis.fetch;
  function withFetch(fn: (url: string, init: any) => Response): { calls: string[]; restore: () => void } {
    const calls: string[] = [];
    globalThis.fetch = mock((url: any, init: any) => {
      calls.push(String(url));
      return Promise.resolve(fn(String(url), init));
    }) as any;
    return { calls, restore: () => { globalThis.fetch = realFetch; } };
  }

  function redirectTo(location: string, status = 302): Response {
    return new Response(null, { status, headers: { location } });
  }
  function okImage(): Response {
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    });
  }

  function pipeline() {
    return new ImagePipeline({ allowedDomains: ['cdn.teros.ai'] });
  }

  it('blocks a redirect from an allowed host to the cloud metadata endpoint', async () => {
    const { calls, restore } = withFetch((url) =>
      url === 'https://cdn.teros.ai/img.png'
        ? redirectTo('http://169.254.169.254/latest/meta-data/')
        : okImage(),
    );
    try {
      const buffer = await (pipeline() as any).downloadImage('https://cdn.teros.ai/img.png');
      expect(buffer).toBeNull();
      // NUNCA se llegó a pedir el endpoint interno.
      expect(calls).toEqual(['https://cdn.teros.ai/img.png']);
    } finally {
      restore();
    }
  });

  it('blocks a redirect to an internal IP (127.0.0.1)', async () => {
    const { restore } = withFetch(() => redirectTo('http://127.0.0.1/x'));
    try {
      expect(await (pipeline() as any).downloadImage('https://cdn.teros.ai/img.png')).toBeNull();
    } finally {
      restore();
    }
  });

  it('follows a redirect to ANOTHER allowed host and downloads the image', async () => {
    const { calls, restore } = withFetch((url) =>
      url === 'https://cdn.teros.ai/img.png'
        ? redirectTo('https://assets.cdn.teros.ai/real.png')
        : okImage(),
    );
    try {
      const buffer = await (pipeline() as any).downloadImage('https://cdn.teros.ai/img.png');
      expect(buffer).not.toBeNull();
      expect(Array.from(buffer as Buffer)).toEqual([1, 2, 3]);
      expect(calls).toEqual([
        'https://cdn.teros.ai/img.png',
        'https://assets.cdn.teros.ai/real.png',
      ]);
    } finally {
      restore();
    }
  });

  it('aborts after exceeding the redirect cap (loop protection)', async () => {
    // Cada hop apunta a un subdominio allowed distinto → siempre válido, nunca 200.
    let n = 0;
    const { restore } = withFetch(() => redirectTo(`https://h${n++}.cdn.teros.ai/x`));
    try {
      expect(await (pipeline() as any).downloadImage('https://cdn.teros.ai/img.png')).toBeNull();
    } finally {
      restore();
    }
  });

  it('a redirect with no Location header is rejected', async () => {
    const { restore } = withFetch(() => new Response(null, { status: 302 }));
    try {
      expect(await (pipeline() as any).downloadImage('https://cdn.teros.ai/img.png')).toBeNull();
    } finally {
      restore();
    }
  });

  it('a direct 200 (no redirect) downloads normally', async () => {
    const { calls, restore } = withFetch(() => okImage());
    try {
      const buffer = await (pipeline() as any).downloadImage('https://cdn.teros.ai/img.png');
      expect(Array.from(buffer as Buffer)).toEqual([1, 2, 3]);
      expect(calls.length).toBe(1);
    } finally {
      restore();
    }
  });
});
