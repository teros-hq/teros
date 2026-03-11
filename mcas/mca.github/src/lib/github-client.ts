import type { ToolContext } from '@teros/mca-sdk';

const BASE_URL = 'https://api.github.com';

export async function githubRequest(
  context: ToolContext,
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    body?: unknown;
    params?: Record<string, string | number | boolean | undefined>;
  } = {},
): Promise<unknown> {
  const userSecrets = await context.getUserSecrets();
  const token = userSecrets.ACCESS_TOKEN || userSecrets.access_token;

  if (!token) {
    throw new Error('GitHub account not connected. Please connect your GitHub account via OAuth.');
  }

  const { method = 'GET', body, params } = options;

  let url = path.startsWith('http') ? path : `${BASE_URL}${path}`;

  if (params) {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        searchParams.append(key, String(value));
      }
    }
    const qs = searchParams.toString();
    if (qs) url += `?${qs}`;
  }

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'Teros-MCA-GitHub',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new Error(`GitHub API error ${response.status}: ${errorText}`);
  }

  if (response.status === 204) return { success: true };

  return response.json();
}
