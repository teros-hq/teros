/**
 * safe-fetch — descarga SSRF-safe con revalidación de cada hop (TER-508/TER-458).
 *
 * El test de regresión central reproduce el ataque real: un host de la allowlist
 * que responde 302 → 169.254.169.254 (metadata cloud). Sin la revalidación, el
 * `fetch` con redirect:'follow' seguiría el salto y filtraría credenciales IAM.
 */

import { afterEach, describe, expect, it, mock } from 'bun:test';
import {
  MAX_DOWNLOAD_REDIRECTS,
  SsrfRedirectError,
  fetchFollowingRedirectsSafely,
} from './safe-fetch';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Allowlist de prueba: solo *.example.com. */
const isValidUrl = (u: string): boolean => {
  try {
    return new URL(u).hostname.endsWith('example.com');
  } catch {
    return false;
  }
};

/** Cola de respuestas que el fetch mock devuelve en orden, capturando las URLs. */
function queueFetch(responses: Response[]): { urls: string[] } {
  const urls: string[] = [];
  let i = 0;
  globalThis.fetch = mock(async (u: any, init: any) => {
    urls.push(String(u));
    // El helper SIEMPRE debe pedir redirect:'manual' (si no, el SSRF se cuela).
    expect(init?.redirect).toBe('manual');
    return responses[i++];
  }) as any;
  return { urls };
}

const redirectTo = (location: string, status = 302) =>
  new Response(null, { status, headers: { location } });
const okResponse = (body = 'DOC') => new Response(body, { status: 200 });

describe('fetchFollowingRedirectsSafely', () => {
  it('happy path: 200 directo devuelve la respuesta, pide solo la URL original', async () => {
    const { urls } = queueFetch([okResponse('hello')]);
    const res = await fetchFollowingRedirectsSafely('https://files.example.com/a.pdf', { isValidUrl });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello');
    expect(urls).toEqual(['https://files.example.com/a.pdf']);
  });

  it('sigue un redirect a un host ALLOWED y devuelve el destino', async () => {
    const { urls } = queueFetch([redirectTo('https://cdn.example.com/a.pdf'), okResponse('final')]);
    const res = await fetchFollowingRedirectsSafely('https://files.example.com/a.pdf', { isValidUrl });
    expect(await res.text()).toBe('final');
    expect(urls).toEqual(['https://files.example.com/a.pdf', 'https://cdn.example.com/a.pdf']);
  });

  it('REGRESIÓN SSRF: 302 → 169.254.169.254 (metadata) se BLOQUEA, nunca se pide', async () => {
    const { urls } = queueFetch([
      redirectTo('http://169.254.169.254/latest/meta-data/iam/security-credentials/'),
      okResponse('IAM_SECRET'),
    ]);
    await expect(
      fetchFollowingRedirectsSafely('https://files.example.com/a.pdf', { isValidUrl }),
    ).rejects.toBeInstanceOf(SsrfRedirectError);
    // El endpoint de metadata NUNCA llegó a pedirse.
    expect(urls).toEqual(['https://files.example.com/a.pdf']);
    expect(urls).not.toContain('http://169.254.169.254/latest/meta-data/iam/security-credentials/');
  });

  it('revalida CADA hop: allowed en el 1º, no-allowed en el 2º → bloquea', async () => {
    const { urls } = queueFetch([
      redirectTo('https://cdn.example.com/a.pdf'),
      redirectTo('http://169.254.169.254/'),
      okResponse('IAM_SECRET'),
    ]);
    await expect(
      fetchFollowingRedirectsSafely('https://files.example.com/a.pdf', { isValidUrl }),
    ).rejects.toThrow(/Blocked SSRF redirect/);
    expect(urls).toEqual(['https://files.example.com/a.pdf', 'https://cdn.example.com/a.pdf']);
  });

  it('cap de redirects: una cadena (allowed) más larga que MAX lanza', async () => {
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls++;
      return redirectTo('https://loop.example.com/next');
    }) as any;
    await expect(
      fetchFollowingRedirectsSafely('https://files.example.com/a.pdf', { isValidUrl }),
    ).rejects.toThrow(/Too many redirects/);
    // Pide la original + MAX hops, luego corta.
    expect(calls).toBe(MAX_DOWNLOAD_REDIRECTS + 1);
  });

  it('redirect sin Location header lanza', async () => {
    queueFetch([new Response(null, { status: 302 })]);
    await expect(
      fetchFollowingRedirectsSafely('https://files.example.com/a.pdf', { isValidUrl }),
    ).rejects.toThrow(/no Location header/);
  });

  it('Location relativo se resuelve contra la URL actual y se revalida', async () => {
    // Relativo a un host allowed → sigue siendo allowed.
    const { urls } = queueFetch([redirectTo('/redirected/a.pdf'), okResponse('rel')]);
    const res = await fetchFollowingRedirectsSafely('https://files.example.com/a.pdf', { isValidUrl });
    expect(await res.text()).toBe('rel');
    expect(urls[1]).toBe('https://files.example.com/redirected/a.pdf');
  });
});
