/**
 * Google API Client Manager
 *
 * Manages OAuth2 authentication and Google API clients for Drive, Sheets, Slides, and Docs.
 */

import type { HttpToolContext as ToolContext } from '@teros/mca-sdk';
import type { OAuth2Client } from 'google-auth-library';
import { google } from 'googleapis';

// =============================================================================
// TYPES
// =============================================================================

export interface GoogleClients {
  oauth2Client: OAuth2Client;
  drive: ReturnType<typeof google.drive>;
  sheets: ReturnType<typeof google.sheets>;
  slides: ReturnType<typeof google.slides>;
  docs: ReturnType<typeof google.docs>;
}

export interface DriveToolContext extends ToolContext {
  google: GoogleClients;
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
  // Get secrets from context
  const systemSecrets = await context.getSystemSecrets();
  const userSecrets = await context.getUserSecrets();

  // Check if we need to reinitialize (secrets changed)
  const secretsChanged =
    JSON.stringify(systemSecrets) !== JSON.stringify(cachedSystemSecrets) ||
    JSON.stringify(userSecrets) !== JSON.stringify(cachedUserSecrets);

  if (googleClients && !secretsChanged) {
    return googleClients;
  }

  // Cache secrets
  cachedSystemSecrets = systemSecrets;
  cachedUserSecrets = userSecrets;

  // Load credentials
  const clientId = systemSecrets.CLIENT_ID || systemSecrets.client_id;
  const clientSecret = systemSecrets.CLIENT_SECRET || systemSecrets.client_secret;
  const redirectUrisRaw = systemSecrets.REDIRECT_URIS || systemSecrets.redirect_uris;

  if (!clientId || !clientSecret) {
    throw new Error(
      'Google Drive OAuth credentials not found.\n' +
        'Expected: CLIENT_ID, CLIENT_SECRET in system secrets.\n' +
        'Please configure OAuth credentials for this app.',
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

  // Create API clients
  googleClients = {
    oauth2Client,
    drive: google.drive({ version: 'v3', auth: oauth2Client }),
    sheets: google.sheets({ version: 'v4', auth: oauth2Client }),
    slides: google.slides({ version: 'v1', auth: oauth2Client }),
    docs: google.docs({ version: 'v1', auth: oauth2Client }),
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
 * Ensure user is authenticated, refresh token if needed
 */
export async function ensureAuthenticated(context: ToolContext): Promise<void> {
  const clients = await initializeGoogleClients(context);
  const { oauth2Client } = clients;

  try {
    // Check if current token is valid
    await oauth2Client.getTokenInfo(oauth2Client.credentials.access_token || '');
  } catch {
    // Token is invalid, try to refresh
    if (oauth2Client.credentials.refresh_token) {
      try {
        const { credentials } = await oauth2Client.refreshAccessToken();
        oauth2Client.setCredentials(credentials);

        // Update cached secrets via backend
        if (context.backend && credentials.access_token) {
          // Note: This would need to be implemented in the backend client
          console.error('[GoogleClient] Token refreshed successfully');
        }
      } catch (refreshError) {
        throw new Error('Authentication expired. Please re-authorize the app.');
      }
    } else {
      throw new Error('Not authenticated. Please authorize the app first.');
    }
  }
}

/**
 * Wrapper that handles 401 errors by attempting token refresh
 */
export async function withAuthRetry<T>(
  context: ToolContext,
  operation: () => Promise<T>,
  operationName: string,
): Promise<T> {
  try {
    return await operation();
  } catch (error: any) {
    // Check if it's a 401 error
    const is401 =
      error?.code === 401 ||
      error?.status === 401 ||
      error?.response?.status === 401 ||
      error?.message?.includes('401') ||
      error?.message?.toLowerCase().includes('invalid credentials') ||
      error?.message?.toLowerCase().includes('token has been expired');

    if (!is401) {
      throw error;
    }

    console.error(`[GoogleClient] 401 error in ${operationName}, attempting token refresh...`);

    // Try to refresh and retry
    await ensureAuthenticated(context);
    return await operation();
  }
}
