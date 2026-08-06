/**
 * Cliente HTTP de la API de Trello — extraído move 1:1 del index.ts
 * fosilizado durante el port al SDK real (TER-507).
 *
 * Auth: key + token como query params (modelo de Trello).
 */

export interface TrelloSecrets {
  TRELLO_API_KEY?: string;
  TRELLO_TOKEN?: string;
}

/**
 * Creates a Trello API client from secrets
 */
export function createTrelloClient(secrets: TrelloSecrets) {
  const apiKey = secrets.TRELLO_API_KEY;
  const token = secrets.TRELLO_TOKEN;

  if (!apiKey || !token) {
    throw new Error('Trello credentials not configured. Missing TRELLO_API_KEY or TRELLO_TOKEN.');
  }

  return {
    apiKey,
    token,
    baseUrl: 'https://api.trello.com/1',
  };
}

/**
 * Helper function to make Trello API requests
 */
export async function trelloRequest(
  client: ReturnType<typeof createTrelloClient>,
  endpoint: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
  // biome-ignore lint/suspicious/noExplicitAny: passthrough del body al wire
  body?: any,
  // biome-ignore lint/suspicious/noExplicitAny: shape del upstream
): Promise<any> {
  const url = new URL(`${client.baseUrl}${endpoint}`);
  url.searchParams.append('key', client.apiKey);
  url.searchParams.append('token', client.token);

  const options: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
    },
  };

  if (body && method !== 'GET') {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url.toString(), options);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Trello API error: ${response.status} ${response.statusText}\n${errorText}`);
  }

  return response.json();
}
