/**
 * Sentry API client and helpers
 */

// =============================================================================
// TYPES
// =============================================================================

export interface SentryOrganization {
  id: string;
  slug: string;
  name: string;
  dateCreated: string;
}

export interface SentryProject {
  id: string;
  slug: string;
  name: string;
  platform: string;
  dateCreated: string;
  firstEvent: string | null;
  hasAccess: boolean;
}

export interface SentryIssue {
  id: string;
  shortId: string;
  title: string;
  culprit: string;
  level: string;
  status: string;
  count: string;
  userCount: number;
  firstSeen: string;
  lastSeen: string;
  project: { slug: string };
  platform: string;
  type: string;
  metadata: unknown;
  annotations: unknown[];
  assignedTo: unknown;
  isSubscribed: boolean;
  hasSeen: boolean;
  permalink: string;
}

export interface SentryEvent {
  eventID: string;
  id: string;
  title: string;
  message: string;
  dateCreated: string;
  user: unknown;
  tags: unknown[];
  platform: string;
  sdk: unknown;
  contexts: unknown;
  entries: Array<{
    type: string;
    data?: {
      values?: Array<{
        type: string;
        value: string;
        stacktrace?: {
          frames?: Array<{
            filename: string;
            function: string;
            lineNo: number;
            colNo: number;
            context: unknown;
            inApp: boolean;
          }>;
        };
      }>;
    };
  }>;
}

export interface ToolContext {
  getSystemSecrets: () => Promise<Record<string, string>>;
  getUserSecrets: () => Promise<Record<string, string>>;
}

// =============================================================================
// SENTRY API CLIENT
// =============================================================================

const SENTRY_BASE_URL = 'https://sentry.io';

/**
 * Get credentials from context
 */
export async function getCredentials(context: ToolContext): Promise<{
  authToken: string;
  organization: string | null;
}> {
  const secrets = await context.getSystemSecrets();
  const authToken = secrets.APIKEY || secrets.apikey || secrets.API_KEY || secrets.api_key;
  const organization = secrets.ORGANIZATION || secrets.organization || null;

  if (!authToken) {
    throw new Error('Sentry API key not configured. Please configure APIKEY in system secrets.');
  }

  return { authToken, organization };
}

/**
 * Get organization from params or default
 */
export function getOrganization(
  organization: string | undefined,
  defaultOrg: string | null,
): string {
  const org = organization || defaultOrg;
  if (!org) {
    throw new Error(
      'Organization is required.\n' +
        'Either pass it as a parameter or configure it in system secrets.',
    );
  }
  return org;
}

/**
 * Make authenticated request to Sentry API
 */
export async function sentryRequest<T>(
  authToken: string,
  endpoint: string,
  options: RequestInit = {},
): Promise<T> {
  const url = `${SENTRY_BASE_URL}/api/0${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Sentry API error: ${response.status} - ${error}`);
  }

  return response.json() as Promise<T>;
}
