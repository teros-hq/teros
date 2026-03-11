import type { ToolContext } from '@teros/mca-sdk';

const BASE_URL = 'https://api.intercom.io';

export async function intercomRequest(
  context: ToolContext,
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    body?: unknown;
  } = {},
): Promise<unknown> {
  const userSecrets = await context.getUserSecrets();
  const token = userSecrets.ACCESS_TOKEN || userSecrets.access_token;

  if (!token) {
    throw new Error('Intercom ACCESS_TOKEN not configured. Please connect your Intercom account.');
  }

  const { method = 'GET', body } = options;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new Error(`Intercom API error ${response.status}: ${errorText}`);
  }

  // 204 No Content
  if (response.status === 204) return { success: true };

  return response.json();
}

/** Helper to strip HTML tags from Intercom message bodies */
export function stripHtml(html: string): string {
  return html?.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() ?? '';
}
