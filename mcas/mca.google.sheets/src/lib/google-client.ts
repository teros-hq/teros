/**
 * Google Sheets API Client Manager
 *
 * Manages OAuth2 authentication and Google Sheets + Drive API clients.
 * Drive is needed for export-sheet (drive.files.export).
 *
 * TER-388: the backend is the only owner of the refresh_token and serves a
 * fresh access_token from `GET /secrets/user` (lazy refresh, rotation-safe).
 * The container authenticates with that access_token only and never refreshes
 * on its own: doing so would reintroduce the double-owner antipattern that
 * invalidated Google's refresh_token when it rotated.
 */

import type { HttpToolContext as ToolContext } from '@teros/mca-sdk';
import type { OAuth2Client } from 'google-auth-library';
import { google } from 'googleapis';

// =============================================================================
// TYPES
// =============================================================================

export interface GoogleClients {
  oauth2Client: OAuth2Client;
  sheets: ReturnType<typeof google.sheets>;
  drive: ReturnType<typeof google.drive>;
}

// =============================================================================
// SINGLETON CLIENT MANAGER
// =============================================================================

let googleClients: GoogleClients | null = null;
let cachedSystemSecrets: Record<string, string> | null = null;
let cachedUserSecrets: Record<string, string> | null = null;

/**
 * Initialize Google clients with credentials from context.
 *
 * `force` bypasses the cache so an expired access_token can be replaced with
 * the fresh one served by the backend.
 */
export async function initializeGoogleClients(
  context: ToolContext,
  options: { force?: boolean } = {},
): Promise<GoogleClients> {
  const systemSecrets = await context.getSystemSecrets();
  const userSecrets = await context.getUserSecrets();

  const secretsChanged =
    JSON.stringify(systemSecrets) !== JSON.stringify(cachedSystemSecrets) ||
    JSON.stringify(userSecrets) !== JSON.stringify(cachedUserSecrets);

  if (googleClients && !options.force && !secretsChanged) {
    return googleClients;
  }

  cachedSystemSecrets = systemSecrets;
  cachedUserSecrets = userSecrets;

  const clientId = systemSecrets.CLIENT_ID || systemSecrets.client_id;
  const clientSecret = systemSecrets.CLIENT_SECRET || systemSecrets.client_secret;
  const redirectUrisRaw = systemSecrets.REDIRECT_URIS || systemSecrets.redirect_uris;

  if (!clientId || !clientSecret) {
    throw new Error(
      'Google Sheets OAuth credentials not found.\n' +
        'Expected: CLIENT_ID, CLIENT_SECRET in system secrets.',
    );
  }

  const accessToken = userSecrets.ACCESS_TOKEN;
  if (!accessToken) {
    throw new Error('Google account not connected. Please connect your Google account.');
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

  // Only the access_token is set: googleapis will not auto-refresh, and a 401
  // means "ask the backend for a fresh token".
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  oauth2Client.setCredentials({ access_token: accessToken });

  googleClients = {
    oauth2Client,
    sheets: google.sheets({ version: 'v4', auth: oauth2Client }),
    drive: google.drive({ version: 'v3', auth: oauth2Client }),
  };

  return googleClients;
}

/**
 * Get initialized Google clients (returns null if not initialized)
 */
export function getGoogleClients(): GoogleClients | null {
  return googleClients;
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
 * Re-fetch the user's access token from the backend and apply it to the
 * existing client. Tools keep a reference to the clients returned by
 * `initializeGoogleClients`, so updating it in place keeps that reference
 * valid without rebuilding every handler.
 */
export async function refreshGoogleCredentials(context: ToolContext): Promise<GoogleClients> {
  const previous = googleClients;
  const next = await initializeGoogleClients(context, { force: true });

  if (previous && previous !== next) {
    previous.oauth2Client.setCredentials(next.oauth2Client.credentials);
  }

  return next;
}

/**
 * Wrapper that handles 401 errors: re-fetch secrets once from the backend and
 * retry. Never refreshes the token in the container (TER-388).
 */
export async function withAuthRetry<T>(
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

    console.error(`[GoogleSheets] 401 error in ${operationName}, re-fetching credentials...`);
    await refreshGoogleCredentials(context);
    return await operation();
  }
}
