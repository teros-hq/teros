/**
 * Google Analytics 4 client factory + TER-388 auth policy.
 *
 * The backend is the only owner of the refresh_token and serves a fresh
 * access_token from `GET /secrets/user` (lazy refresh, rotation-safe). The
 * container authenticates with that access_token only and never refreshes on
 * its own: doing so would reintroduce the double-owner antipattern that
 * invalidated Google's refresh_token when it rotated.
 */

import type { HttpToolContext as ToolContext } from '@teros/mca-sdk';
import type { OAuth2Client } from 'google-auth-library';
import { google } from 'googleapis';

export interface AnalyticsSecrets {
  CLIENT_ID?: string;
  CLIENT_SECRET?: string;
  REDIRECT_URIS?: string;
  ACCESS_TOKEN?: string;
  EMAIL?: string;
}

export interface AnalyticsClients {
  oauth2Client: OAuth2Client;
  data: ReturnType<typeof google.analyticsdata>;
  admin: ReturnType<typeof google.analyticsadmin>;
  email: string;
}

let activeOAuth2Client: OAuth2Client | null = null;

/**
 * Merge system + user secrets exactly like the handlers used to do.
 */
export async function fetchAnalyticsSecrets(context: ToolContext): Promise<AnalyticsSecrets> {
  return {
    ...(await context.getSystemSecrets()),
    ...(await context.getUserSecrets()),
  } as AnalyticsSecrets;
}

/**
 * Build GA4 clients from the given secrets. Only `access_token` is passed to
 * the OAuth2 client, so googleapis never auto-refreshes.
 */
export async function createAnalyticsClients(
  secrets: AnalyticsSecrets,
): Promise<AnalyticsClients> {
  const clientId = secrets.CLIENT_ID;
  const clientSecret = secrets.CLIENT_SECRET;
  const redirectUrisRaw = secrets.REDIRECT_URIS;

  if (!clientId || !clientSecret) {
    throw new Error(
      '[SYSTEM_CONFIG_MISSING] Google OAuth credentials not configured. Missing CLIENT_ID or CLIENT_SECRET.',
    );
  }

  if (!secrets.ACCESS_TOKEN) {
    throw new Error(
      '[AUTH_REQUIRED] Google account not connected. Please connect your Google account.',
    );
  }

  let redirectUri = 'https://be.teros.ai/auth/callback';
  if (redirectUrisRaw) {
    try {
      const uris = JSON.parse(redirectUrisRaw);
      redirectUri = Array.isArray(uris) ? uris[0] : redirectUrisRaw;
    } catch {
      redirectUri = redirectUrisRaw;
    }
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  oauth2Client.setCredentials({ access_token: secrets.ACCESS_TOKEN });
  activeOAuth2Client = oauth2Client;

  return {
    oauth2Client,
    data: google.analyticsdata({ version: 'v1beta', auth: oauth2Client }),
    admin: google.analyticsadmin({ version: 'v1beta', auth: oauth2Client }),
    email: secrets.EMAIL || 'unknown@gmail.com',
  };
}

/**
 * Fetch secrets once from the backend and build fresh clients.
 */
export async function initializeAnalyticsClients(
  context: ToolContext,
): Promise<AnalyticsClients> {
  return createAnalyticsClients(await fetchAnalyticsSecrets(context));
}

/**
 * Detect a 401 from googleapis (gaxios shapes differ by version).
 */
export function isAuthError(error: any): boolean {
  return (
    error?.code === 401 ||
    error?.status === 401 ||
    error?.response?.status === 401 ||
    error?.message?.includes('401') ||
    error?.message?.toLowerCase().includes('invalid credentials')
  );
}

/**
 * Re-fetch the user's access token from the backend and apply it to the active
 * OAuth2 client. Handlers keep the `data`/`admin` objects built on that same
 * client, so updating it in place keeps their references valid.
 */
export async function refreshAnalyticsCredentials(
  context: ToolContext,
): Promise<AnalyticsClients> {
  const secrets = await fetchAnalyticsSecrets(context);

  if (activeOAuth2Client && secrets.ACCESS_TOKEN) {
    activeOAuth2Client.setCredentials({ access_token: secrets.ACCESS_TOKEN });
    return {
      oauth2Client: activeOAuth2Client,
      data: google.analyticsdata({ version: 'v1beta', auth: activeOAuth2Client }),
      admin: google.analyticsadmin({ version: 'v1beta', auth: activeOAuth2Client }),
      email: secrets.EMAIL || 'unknown@gmail.com',
    };
  }

  return createAnalyticsClients(secrets);
}

/**
 * Wrapper that handles 401 errors: re-fetch secrets once from the backend and
 * retry. Never refreshes the token in the container (TER-388).
 */
export async function withAnalyticsAuthRetry<T>(
  context: ToolContext,
  operation: () => Promise<T>,
  operationName: string,
): Promise<T> {
  try {
    return await operation();
  } catch (error: any) {
    if (!isAuthError(error)) {
      throw error;
    }

    console.error(
      `[GoogleAnalytics] 401 error in ${operationName}, re-fetching credentials...`,
    );
    await refreshAnalyticsCredentials(context);
    return await operation();
  }
}
