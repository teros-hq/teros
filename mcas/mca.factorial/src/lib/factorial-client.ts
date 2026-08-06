import type { McaContext } from '@teros/mca-sdk';

const API_BASE = 'https://api.factorialhr.com';
const API_VERSION = '2024-10-01';

/**
 * Make an authenticated request to the Factorial API.
 */
export async function factorialRequest(
  context: McaContext,
  endpoint: string,
  options: RequestInit = {},
): Promise<unknown> {
  const userSecrets = await context.getUserSecrets();
  const token = userSecrets.ACCESS_TOKEN as string | undefined;

  if (!token) {
    throw new Error('Factorial account not connected. Please connect via OAuth first.');
  }

  const url = endpoint.startsWith('http')
    ? endpoint
    : `${API_BASE}/api/${API_VERSION}/resources${endpoint}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  };

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => 'Unknown error');
    throw new Error(
      `Factorial API error (${response.status} ${response.statusText}): ${text}`,
    );
  }

  // Some endpoints return 204 No Content
  if (response.status === 204) {
    return null;
  }

  return response.json();
}

/**
 * Build a query string from a params object, filtering out undefined/null values.
 */
export function buildQueryString(
  params: Record<string, string | number | boolean | string[] | number[] | undefined>,
): string {
  const searchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;

    if (Array.isArray(value)) {
      for (const item of value) {
        searchParams.append(`${key}[]`, String(item));
      }
    } else {
      searchParams.append(key, String(value));
    }
  }

  const qs = searchParams.toString();
  return qs ? `?${qs}` : '';
}
