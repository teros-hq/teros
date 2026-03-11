/**
 * ClaudeCodeCredentials - Load OAuth credentials from Claude Code CLI
 *
 * Claude Code stores OAuth tokens in various locations depending on the OS.
 * This module attempts to load those credentials so they can be used
 * with the Anthropic API without requiring a separate API key.
 *
 * Locations checked:
 * - Linux/macOS: ~/.claude/.credentials.json
 * - Linux/macOS: ~/.config/claude-code/credentials.json
 * - Windows: %LOCALAPPDATA%/claude-code/credentials.json
 * - XDG: $XDG_CONFIG_HOME/claude-code/credentials.json
 *
 * The OAuth flow uses:
 * - access_token: Short-lived token for API requests
 * - refresh_token: Long-lived token to get new access tokens
 *
 * @see https://github.com/hongkongkiwi/claude-code-oai-proxy for reference implementation
 */

import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { log } from '../logger';

const MODULE = 'ClaudeCodeCredentials';

/**
 * Claude Code credentials structure
 */
export interface ClaudeCodeCredentials {
  /** OAuth access token for API requests */
  accessToken: string;
  /** OAuth refresh token (optional, for token renewal) */
  refreshToken?: string;
  /** Token expiration timestamp (optional) */
  expiresAt?: number;
  /** Organization ID (optional) */
  organizationId?: string;
}

/**
 * Raw credentials file format (as stored by Claude Code)
 */
interface RawCredentialsFile {
  // Format 1: Direct tokens
  access_token?: string;
  accessToken?: string;
  refresh_token?: string;
  refreshToken?: string;
  expires_at?: number;
  expiresAt?: number;
  organization_id?: string;
  organizationId?: string;

  // Format 2: Nested under 'oauth' key
  oauth?: {
    access_token?: string;
    accessToken?: string;
    refresh_token?: string;
    refreshToken?: string;
    expires_at?: number;
    expiresAt?: number;
  };

  // Format 3: Nested under 'credentials' key
  credentials?: {
    access_token?: string;
    accessToken?: string;
    refresh_token?: string;
    refreshToken?: string;
    expires_at?: number;
    expiresAt?: number;
  };

  // Format 4: Claude Max subscription tokens
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number | string;
  };
}

/**
 * Get all possible credential file paths
 */
function getCredentialPaths(): string[] {
  const home = homedir();
  const paths: string[] = [];

  // Primary location: ~/.claude/.credentials.json (Claude Code default)
  paths.push(join(home, '.claude', '.credentials.json'));
  paths.push(join(home, '.claude', 'credentials.json'));

  // Alternative: ~/.config/claude-code/
  paths.push(join(home, '.config', 'claude-code', 'credentials.json'));
  paths.push(join(home, '.config', 'claude-code', '.credentials.json'));

  // XDG config location
  const xdgConfig = process.env.XDG_CONFIG_HOME;
  if (xdgConfig) {
    paths.push(join(xdgConfig, 'claude-code', 'credentials.json'));
    paths.push(join(xdgConfig, 'claude-code', '.credentials.json'));
    paths.push(join(xdgConfig, 'claude', 'credentials.json'));
  }

  // Windows location
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    paths.push(join(localAppData, 'claude-code', 'credentials.json'));
    paths.push(join(localAppData, 'Claude', 'credentials.json'));
  }

  // Alternative Windows path
  if (process.platform === 'win32') {
    paths.push(join(home, 'AppData', 'Local', 'claude-code', 'credentials.json'));
    paths.push(join(home, 'AppData', 'Local', 'Claude', 'credentials.json'));
  }

  return paths;
}

/**
 * Parse credentials from raw file content
 */
function parseCredentials(raw: RawCredentialsFile): ClaudeCodeCredentials | null {
  // Try different formats

  // Format 1: Direct tokens (snake_case or camelCase)
  let accessToken = raw.access_token || raw.accessToken;
  let refreshToken = raw.refresh_token || raw.refreshToken;
  let expiresAt = raw.expires_at || raw.expiresAt;

  // Format 2: Nested under 'oauth'
  if (!accessToken && raw.oauth) {
    accessToken = raw.oauth.access_token || raw.oauth.accessToken;
    refreshToken = raw.oauth.refresh_token || raw.oauth.refreshToken;
    expiresAt = raw.oauth.expires_at || raw.oauth.expiresAt;
  }

  // Format 3: Nested under 'credentials'
  if (!accessToken && raw.credentials) {
    accessToken = raw.credentials.access_token || raw.credentials.accessToken;
    refreshToken = raw.credentials.refresh_token || raw.credentials.refreshToken;
    expiresAt = raw.credentials.expires_at || raw.credentials.expiresAt;
  }

  // Format 4: Claude Max subscription (claudeAiOauth)
  if (!accessToken && raw.claudeAiOauth) {
    accessToken = raw.claudeAiOauth.accessToken;
    refreshToken = raw.claudeAiOauth.refreshToken;
    const rawExpires = raw.claudeAiOauth.expiresAt;
    expiresAt = typeof rawExpires === 'string' ? parseInt(rawExpires, 10) : rawExpires;
  }

  if (!accessToken) {
    return null;
  }

  return {
    accessToken,
    refreshToken,
    expiresAt,
    organizationId: raw.organization_id || raw.organizationId,
  };
}

/**
 * Load Claude Code credentials from the filesystem
 *
 * Searches through known locations where Claude Code stores credentials.
 * Returns null if no valid credentials are found.
 *
 * @example
 * ```typescript
 * const credentials = await loadClaudeCodeCredentials()
 * if (credentials) {
 *   console.log('Found Claude Code credentials!')
 *   // Use credentials.accessToken with Anthropic API
 * }
 * ```
 */
export async function loadClaudeCodeCredentials(): Promise<ClaudeCodeCredentials | null> {
  const paths = getCredentialPaths();

  log.debug(MODULE, 'Searching for Claude Code credentials', {
    pathCount: paths.length,
  });

  for (const path of paths) {
    if (!existsSync(path)) {
      continue;
    }

    try {
      log.debug(MODULE, 'Found credentials file', { path });
      const content = await readFile(path, 'utf-8');
      const raw = JSON.parse(content) as RawCredentialsFile;

      const credentials = parseCredentials(raw);

      if (credentials) {
        // Check if token is expired
        if (credentials.expiresAt) {
          const now = Date.now();
          const expiresAtMs = credentials.expiresAt * 1000; // Convert to ms if in seconds

          if (expiresAtMs < now) {
            log.warn(MODULE, 'Claude Code access token is expired', {
              path,
              expiresAt: new Date(expiresAtMs).toISOString(),
              hasRefreshToken: !!credentials.refreshToken,
            });

            // If we have a refresh token, we could potentially refresh
            // For now, we still return the credentials and let the caller handle refresh
            if (!credentials.refreshToken) {
              continue; // Try next file
            }
          }
        }

        log.info(MODULE, 'Loaded Claude Code credentials', {
          path,
          hasRefreshToken: !!credentials.refreshToken,
          hasExpiry: !!credentials.expiresAt,
          hasOrgId: !!credentials.organizationId,
        });

        return credentials;
      }
    } catch (error) {
      log.debug(MODULE, 'Failed to parse credentials file', { path });
    }
  }

  log.debug(MODULE, 'No Claude Code credentials found');
  return null;
}

/**
 * Refresh an expired access token using the refresh token
 *
 * @param refreshToken - The refresh token from Claude Code
 * @returns New credentials with fresh access token, or null if refresh fails
 */
export async function refreshClaudeCodeToken(
  refreshToken: string,
): Promise<ClaudeCodeCredentials | null> {
  const OAUTH_ENDPOINT = 'https://console.anthropic.com/v1/oauth/token';

  try {
    log.info(MODULE, 'Refreshing Claude Code access token');

    const response = await fetch(OAUTH_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      log.error(MODULE, 'Failed to refresh token', undefined, {
        status: response.status,
        error: errorText,
      });
      return null;
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    const credentials: ClaudeCodeCredentials = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      expiresAt: data.expires_in ? Math.floor(Date.now() / 1000) + data.expires_in : undefined,
    };

    log.info(MODULE, 'Successfully refreshed Claude Code token', {
      hasNewRefreshToken: !!data.refresh_token,
      expiresIn: data.expires_in,
    });

    return credentials;
  } catch (error) {
    log.error(MODULE, 'Error refreshing Claude Code token', error as Error);
    return null;
  }
}

/**
 * Get a valid access token, refreshing if necessary
 *
 * This is the main function to use when you need an access token.
 * It will:
 * 1. Load credentials from disk
 * 2. Check if the token is expired
 * 3. Refresh the token if needed and possible
 * 4. Return a valid access token or null
 *
 * @example
 * ```typescript
 * const token = await getClaudeCodeAccessToken()
 * if (token) {
 *   // Use token with Anthropic API
 *   const client = new Anthropic({ apiKey: token })
 * }
 * ```
 */
export async function getClaudeCodeAccessToken(): Promise<string | null> {
  const credentials = await loadClaudeCodeCredentials();

  if (!credentials) {
    return null;
  }

  // Check if token is expired
  if (credentials.expiresAt) {
    const now = Math.floor(Date.now() / 1000);
    const bufferSeconds = 60; // Refresh 1 minute before expiry

    if (credentials.expiresAt - bufferSeconds < now) {
      // Token is expired or about to expire
      if (credentials.refreshToken) {
        const refreshed = await refreshClaudeCodeToken(credentials.refreshToken);
        if (refreshed) {
          return refreshed.accessToken;
        }
      }

      // Can't refresh, but try using the token anyway
      // (it might still work if the expiry check is off)
      log.warn(MODULE, 'Using potentially expired token (no refresh available)');
    }
  }

  return credentials.accessToken;
}

/**
 * Check if Claude Code credentials are available
 *
 * Quick check without loading the full credentials.
 * Useful for feature detection.
 */
export function hasClaudeCodeCredentials(): boolean {
  const paths = getCredentialPaths();
  return paths.some((path) => existsSync(path));
}
