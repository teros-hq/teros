/**
 * Canva Connect API Client
 *
 * Stateless: secrets read from `context` every call. On 401 the access token
 * is refreshed and persisted to the backend via `context.updateUserSecrets`,
 * so subsequent requests (in this or any other worker) see the fresh token.
 */

import type { ToolContext } from '@teros/mca-sdk';
import { CanvaApiError, classifyCanvaApiError } from './_canva-error';

const CANVA_API_BASE = 'https://api.canva.com/rest/v1';

export interface CanvaRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
}

interface Credentials {
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken: string;
}

async function readCredentials(context: ToolContext): Promise<Credentials> {
  const [systemSecrets, userSecrets] = await Promise.all([
    context.getSystemSecrets(),
    context.getUserSecrets(),
  ]);
  const clientId = systemSecrets.CLIENT_ID || systemSecrets.client_id;
  const clientSecret = systemSecrets.CLIENT_SECRET || systemSecrets.client_secret;
  const accessToken = userSecrets.ACCESS_TOKEN || userSecrets.access_token;
  const refreshToken = userSecrets.REFRESH_TOKEN || userSecrets.refresh_token;

  if (!clientId || !clientSecret) {
    throw new Error('Canva system secrets missing: CLIENT_ID and CLIENT_SECRET required.');
  }
  if (!accessToken || !refreshToken) {
    throw new Error('Canva authentication required. Please connect your Canva account.');
  }

  return { clientId, clientSecret, accessToken, refreshToken };
}

async function refreshAccessToken(context: ToolContext, creds: Credentials): Promise<string> {
  const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
  const response = await fetch(`${CANVA_API_BASE}/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: creds.refreshToken,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to refresh Canva token: ${errorText}`);
  }

  const data = (await response.json()) as { access_token: string; refresh_token?: string };

  // Persist to backend so future requests see the fresh token.
  const updated: Record<string, string> = { ACCESS_TOKEN: data.access_token };
  if (data.refresh_token) updated.REFRESH_TOKEN = data.refresh_token;
  await context.updateUserSecrets(updated);

  return data.access_token;
}

export async function canvaRequest<T = unknown>(
  context: ToolContext,
  endpoint: string,
  options: CanvaRequestOptions = {},
): Promise<T> {
  const creds = await readCredentials(context);

  const fetchWith = async (token: string): Promise<Response> => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      ...options.headers,
    };
    if (options.body !== undefined && !options.headers?.['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    return fetch(`${CANVA_API_BASE}${endpoint}`, {
      method: options.method || 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  };

  let response = await fetchWith(creds.accessToken);

  if (response.status === 401) {
    const fresh = await refreshAccessToken(context, creds);
    response = await fetchWith(fresh);
  }

  if (!response.ok) {
    const errorText = await response.text();
    let parsed: unknown = errorText;
    try {
      parsed = JSON.parse(errorText);
    } catch {
      // not JSON; keep raw text for the message
    }
    const classified = classifyCanvaApiError(
      response.status,
      parsed,
      errorText || 'Canva API error',
    );
    throw new CanvaApiError(response.status, classified);
  }

  if (response.status === 204) return {} as T;
  return (await response.json()) as T;
}
