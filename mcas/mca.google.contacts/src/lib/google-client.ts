/**
 * Google People API Client Manager
 */

import type { HttpToolContext as ToolContext } from '@teros/mca-sdk';
import type { OAuth2Client } from 'google-auth-library';
import { google } from 'googleapis';

// =============================================================================
// TYPES
// =============================================================================

export interface GoogleClients {
  oauth2Client: OAuth2Client;
  people: ReturnType<typeof google.people>;
}

// =============================================================================
// SINGLETON CLIENT MANAGER
// =============================================================================

let googleClients: GoogleClients | null = null;
let cachedSystemSecrets: Record<string, string> | null = null;
let cachedUserSecrets: Record<string, string> | null = null;

/**
 * Initialize Google clients with credentials from context
 */
export async function initializeGoogleClients(context: ToolContext): Promise<GoogleClients> {
  const systemSecrets = await context.getSystemSecrets();
  const userSecrets = await context.getUserSecrets();

  // Check if we need to reinitialize
  const secretsChanged =
    JSON.stringify(systemSecrets) !== JSON.stringify(cachedSystemSecrets) ||
    JSON.stringify(userSecrets) !== JSON.stringify(cachedUserSecrets);

  if (googleClients && !secretsChanged) {
    return googleClients;
  }

  cachedSystemSecrets = systemSecrets;
  cachedUserSecrets = userSecrets;

  // Load credentials
  const clientId = systemSecrets.CLIENT_ID || systemSecrets.client_id;
  const clientSecret = systemSecrets.CLIENT_SECRET || systemSecrets.client_secret;
  const redirectUrisRaw = systemSecrets.REDIRECT_URIS || systemSecrets.redirect_uris;

  if (!clientId || !clientSecret) {
    throw new Error(
      'Google Contacts OAuth credentials not found.\n' +
        'Expected: CLIENT_ID, CLIENT_SECRET in system secrets.',
    );
  }

  // Parse redirect URI
  // Falls back to TEROS_BACKEND_URL env var, or localhost for self-hosted installs
  const backendUrl = process.env.TEROS_BACKEND_URL || 'http://localhost:3000';
  let redirectUri = `${backendUrl}/auth/callback`;
  if (redirectUrisRaw) {
    try {
      const uris = JSON.parse(redirectUrisRaw);
      redirectUri = Array.isArray(uris) ? uris[0] : redirectUrisRaw;
    } catch {
      redirectUri = redirectUrisRaw;
    }
  }

  // Create OAuth2 client
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  // Set user credentials if available
  if (userSecrets.ACCESS_TOKEN) {
    oauth2Client.setCredentials({
      access_token: userSecrets.ACCESS_TOKEN,
      refresh_token: userSecrets.REFRESH_TOKEN,
      expiry_date: userSecrets.EXPIRY_DATE ? parseInt(userSecrets.EXPIRY_DATE) : undefined,
    });
  }

  // Create API client
  googleClients = {
    oauth2Client,
    people: google.people({ version: 'v1', auth: oauth2Client }),
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
 * Ensure user is authenticated
 */
export async function ensureAuthenticated(context: ToolContext): Promise<void> {
  const clients = await initializeGoogleClients(context);
  const { oauth2Client } = clients;

  try {
    await oauth2Client.getTokenInfo(oauth2Client.credentials.access_token || '');
  } catch {
    if (oauth2Client.credentials.refresh_token) {
      try {
        const { credentials } = await oauth2Client.refreshAccessToken();
        oauth2Client.setCredentials(credentials);
      } catch {
        throw new Error('Authentication expired. Please re-authorize the app.');
      }
    } else {
      throw new Error('Not authenticated. Please authorize the app first.');
    }
  }
}

/**
 * Wrapper that handles 401 errors
 */
export async function withAuthRetry<T>(
  context: ToolContext,
  operation: () => Promise<T>,
  operationName: string,
): Promise<T> {
  try {
    return await operation();
  } catch (error: any) {
    const is401 =
      error?.code === 401 ||
      error?.status === 401 ||
      error?.response?.status === 401 ||
      error?.message?.includes('401') ||
      error?.message?.toLowerCase().includes('invalid credentials');

    if (!is401) {
      throw error;
    }

    console.error(`[GoogleContacts] 401 error in ${operationName}, attempting refresh...`);
    await ensureAuthenticated(context);
    return await operation();
  }
}
