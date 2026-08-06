/**
 * Test — mapping del 401 de callback a code CALLBACK_TOKEN_INVALID (TER-389).
 *
 * Cuando el backend rechaza una llamada a /secrets/* con 401 (MCA_CALLBACK_TOKEN
 * desincronizado), el cliente debe marcar el error con code 'CALLBACK_TOKEN_INVALID'
 * para que los consumidores (p.ej. el email watcher) puedan detenerse limpiamente
 * en vez de seguir martillando el endpoint. Otros status mantienen BACKEND_ERROR.
 *
 * Boundary fiel: mockea fetch devolviendo el body real del backend.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { McaBackendClient } from '../src/backend-client';

const originalFetch = global.fetch;

function mockFetchOnce(status: number, body: unknown): void {
  global.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
}

function makeClient(): McaBackendClient {
  return new McaBackendClient({
    callbackUrl: 'http://backend.test',
    appId: 'app_test',
    mcaId: 'mca.google.gmail',
    callbackToken: 'stale-token',
  });
}

afterEach(() => {
  global.fetch = originalFetch;
});

describe('backend-client 401 → CALLBACK_TOKEN_INVALID', () => {
  it('marca code CALLBACK_TOKEN_INVALID en un 401 de /secrets/user', async () => {
    mockFetchOnce(401, { error: 'Invalid or missing MCA_CALLBACK_TOKEN' });
    let caught: any;
    try {
      await makeClient().getUserSecrets();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('CALLBACK_TOKEN_INVALID');
    expect(caught.statusCode).toBe(401);
    // El mensaje upstream del backend se preserva.
    expect(caught.message).toContain('Invalid or missing MCA_CALLBACK_TOKEN');
  });

  it('mantiene BACKEND_ERROR en errores no-401 (p.ej. 500)', async () => {
    mockFetchOnce(500, { error: 'internal' });
    let caught: any;
    try {
      await makeClient().getSystemSecrets();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('BACKEND_ERROR');
    expect(caught.statusCode).toBe(500);
  });
});
