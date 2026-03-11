/**
 * ClaudeOAuth - OAuth authentication for Claude Max subscription
 *
 * This module implements the OAuth 2.0 + PKCE flow to authenticate with
 * Anthropic's Claude API using a Claude Max subscription instead of API keys.
 *
 * The flow is:
 * 1. Generate PKCE code verifier and challenge
 * 2. Open browser to claude.ai/oauth/authorize
 * 3. User logs in and authorizes
 * 4. User copies callback URL with authorization code
 * 5. Exchange code for access_token and refresh_token
 * 6. Store tokens for future use
 *
 * Token storage:
 * - Requires SECRETS_PATH environment variable
 * - Tokens stored at: $SECRETS_PATH/system/anthropic-oauth.json
 *
 * @see https://github.com/Smethan/cursor-oauth-proxy for reference
 */

import { createHash, randomBytes } from 'crypto';
import { existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { log } from '../logger';

const MODULE = 'ClaudeOAuth';

// OAuth Configuration (same as cursor-oauth-proxy)
const OAUTH_CONFIG = {
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  authUrl: 'https://claude.ai/oauth/authorize',
  tokenUrl: 'https://console.anthropic.com/v1/oauth/token',
  redirectUri: 'https://console.anthropic.com/oauth/code/callback',
  scopes: 'org:create_api_key user:profile user:inference',
};

// Required beta headers for OAuth
const REQUIRED_BETAS = [
  'oauth-2025-04-20',
  'claude-code-20250219',
  'interleaved-thinking-2025-05-14',
  'fine-grained-tool-streaming-2025-05-14',
];

/**
 * OAuth tokens structure
 */
export interface ClaudeOAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp in milliseconds
  tokenType: string;
  createdAt: number;
}

/**
 * PKCE challenge pair
 */
interface PKCEPair {
  verifier: string;
  challenge: string;
}

/**
 * Generate PKCE code verifier and challenge (S256)
 */
function generatePKCE(): PKCEPair {
  // Generate 32-byte random string, base64url encoded
  const verifier = randomBytes(32).toString('base64url').replace(/=/g, '');

  // SHA256 hash, base64url encoded, padding removed
  const challenge = createHash('sha256').update(verifier).digest('base64url').replace(/=/g, '');

  return { verifier, challenge };
}

/**
 * Get token storage path
 * Uses SECRETS_PATH env var (required) to locate .secrets/system/anthropic-oauth.json
 */
function getTokenPath(): string {
  const secretsPath = process.env.SECRETS_PATH;
  if (!secretsPath) {
    throw new Error('SECRETS_PATH environment variable is required for OAuth tokens');
  }
  return join(secretsPath, 'system', 'anthropic-oauth.json');
}

/**
 * Load OAuth tokens from storage
 */
export async function loadOAuthTokens(): Promise<ClaudeOAuthTokens | null> {
  try {
    const path = getTokenPath();

    if (!existsSync(path)) {
      log.debug(MODULE, 'OAuth tokens file not found', { path });
      return null;
    }

    const content = await readFile(path, 'utf-8');
    const raw = JSON.parse(content);

    // Handle both camelCase and snake_case
    const tokens: ClaudeOAuthTokens = {
      accessToken: raw.access_token || raw.accessToken,
      refreshToken: raw.refresh_token || raw.refreshToken,
      expiresAt: raw.expires_at || raw.expiresAt,
      tokenType: raw.token_type || raw.tokenType || 'Bearer',
      createdAt: raw.created_at || raw.createdAt || Date.now(),
    };

    if (tokens.accessToken && tokens.refreshToken) {
      log.info(MODULE, 'Loaded OAuth tokens', { path });
      return tokens;
    }

    log.debug(MODULE, 'Invalid OAuth tokens file', { path });
    return null;
  } catch (error) {
    log.debug(MODULE, 'Failed to load OAuth tokens', { error });
    return null;
  }
}

/**
 * Save OAuth tokens to storage
 * Saves to .secrets/system/anthropic-oauth.json
 */
export async function saveOAuthTokens(tokens: ClaudeOAuthTokens): Promise<void> {
  const path = getTokenPath();
  const dir = join(path, '..');

  // Save with both formats for compatibility
  const data = {
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    expires_at: tokens.expiresAt,
    token_type: tokens.tokenType,
    created_at: tokens.createdAt,
    // Also camelCase
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    tokenType: tokens.tokenType,
    createdAt: tokens.createdAt,
  };

  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }

  await writeFile(path, JSON.stringify(data, null, 2), { mode: 0o600 });
  log.info(MODULE, 'Saved OAuth tokens', { path });
}

/**
 * Check if tokens need refresh (within 5 minute buffer)
 */
export function tokensNeedRefresh(tokens: ClaudeOAuthTokens): boolean {
  const bufferMs = 5 * 60 * 1000; // 5 minutes
  return tokens.expiresAt - bufferMs < Date.now();
}

/**
 * Refresh OAuth tokens using refresh_token
 */
export async function refreshOAuthTokens(refreshToken: string): Promise<ClaudeOAuthTokens | null> {
  try {
    log.info(MODULE, 'Refreshing OAuth tokens');

    const response = await fetch(OAUTH_CONFIG.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: OAUTH_CONFIG.clientId,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      log.error(MODULE, 'Token refresh failed', undefined, {
        status: response.status,
        error,
      });
      return null;
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      token_type: string;
    };

    const tokens: ClaudeOAuthTokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      expiresAt: Date.now() + data.expires_in * 1000,
      tokenType: data.token_type || 'Bearer',
      createdAt: Date.now(),
    };

    // Save refreshed tokens
    await saveOAuthTokens(tokens);

    log.info(MODULE, 'Tokens refreshed successfully', {
      expiresIn: data.expires_in,
    });

    return tokens;
  } catch (error) {
    log.error(MODULE, 'Error refreshing tokens', error as Error);
    return null;
  }
}

/**
 * Get a valid OAuth access token, refreshing if needed
 */
export async function getOAuthAccessToken(): Promise<string | null> {
  const tokens = await loadOAuthTokens();

  if (!tokens) {
    log.debug(MODULE, 'No OAuth tokens found');
    return null;
  }

  // Check if refresh needed
  if (tokensNeedRefresh(tokens)) {
    log.info(MODULE, 'Tokens expired or expiring soon, refreshing...');
    const refreshed = await refreshOAuthTokens(tokens.refreshToken);
    if (refreshed) {
      return refreshed.accessToken;
    }
    // Try using old token anyway
    log.warn(MODULE, 'Refresh failed, trying existing token');
  }

  return tokens.accessToken;
}

/**
 * Check if OAuth tokens are available
 */
export function hasOAuthTokens(): boolean {
  try {
    const path = getTokenPath();
    return existsSync(path);
  } catch {
    return false;
  }
}

/**
 * Generate OAuth authorization URL for interactive login
 *
 * @returns Object with URL to open and verifier to save for code exchange
 */
export function generateAuthorizationUrl(): { url: string; verifier: string } {
  const pkce = generatePKCE();

  const params = new URLSearchParams({
    code: 'true',
    client_id: OAUTH_CONFIG.clientId,
    response_type: 'code',
    redirect_uri: OAUTH_CONFIG.redirectUri,
    scope: OAUTH_CONFIG.scopes,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    state: pkce.verifier,
  });

  return {
    url: `${OAUTH_CONFIG.authUrl}?${params.toString()}`,
    verifier: pkce.verifier,
  };
}

/**
 * Exchange authorization code for tokens
 *
 * @param callbackUrl - The full callback URL from the browser or just the code
 * @param verifier - The PKCE verifier from generateAuthorizationUrl
 */
export async function exchangeCodeForTokens(
  callbackUrl: string,
  verifier: string,
): Promise<ClaudeOAuthTokens | null> {
  try {
    let code: string | null = null;
    let state: string | null = null;

    // Try to parse as URL first
    try {
      const url = new URL(callbackUrl);
      code = url.searchParams.get('code');
      state = url.searchParams.get('state');
    } catch {
      // Not a valid URL, check if it's in format "code#state" or just the code
      if (callbackUrl.includes('#')) {
        const parts = callbackUrl.split('#');
        code = parts[0];
        state = parts[1] || verifier;
      } else {
        // Assume it's just the code
        code = callbackUrl;
        state = verifier;
      }
    }

    if (!code) {
      log.error(MODULE, 'No authorization code in callback URL');
      return null;
    }

    // Use verifier as state if not provided
    if (!state) {
      state = verifier;
    }

    log.info(MODULE, 'Exchanging authorization code for tokens');

    const response = await fetch(OAUTH_CONFIG.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        state,
        redirect_uri: OAUTH_CONFIG.redirectUri,
        client_id: OAUTH_CONFIG.clientId,
        code_verifier: verifier,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      log.error(MODULE, 'Code exchange failed', undefined, {
        status: response.status,
        error,
      });
      return null;
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      token_type: string;
    };

    const tokens: ClaudeOAuthTokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
      tokenType: data.token_type || 'Bearer',
      createdAt: Date.now(),
    };

    // Save tokens
    await saveOAuthTokens(tokens);

    log.info(MODULE, 'OAuth authentication successful', {
      expiresAt: new Date(tokens.expiresAt).toISOString(),
    });

    return tokens;
  } catch (error) {
    log.error(MODULE, 'Error exchanging code for tokens', error as Error);
    return null;
  }
}

/**
 * Get required beta headers for OAuth requests
 */
export function getOAuthBetaHeaders(): string {
  return REQUIRED_BETAS.join(',');
}

/**
 * OAuth configuration (for advanced usage)
 */
export const oauthConfig = OAUTH_CONFIG;
