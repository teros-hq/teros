/**
 * Shared WAHA API helpers for mca.whatsapp tools.
 */

export const WAHA_PORT = process.env.WAHA_PORT || '3001';
export const WAHA_BASE = `http://localhost:${WAHA_PORT}/api`;
const WAHA_KEY = process.env.WAHA_API_KEY || '';

/** Headers comunes para todas las llamadas a WAHA */
export const wahaHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (WAHA_KEY) {
    headers['X-Api-Key'] = WAHA_KEY;
  }
  return headers;
};

/** Hace fetch a WAHA con timeout configurable (30s por defecto) */
const WAHA_TIMEOUT_MS = parseInt(process.env.WAHA_TIMEOUT_MS || '30000', 10);
export async function wahaFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = path.startsWith('http') ? path : `${WAHA_BASE}${path}`;
  return fetch(url, {
    ...init,
    headers: {
      ...wahaHeaders(),
      ...(init?.headers as Record<string, string> | undefined),
    },
    signal: AbortSignal.timeout(WAHA_TIMEOUT_MS),
  });
}
