/**
 * CodexOAuth - OAuth Device Flow authentication for OpenAI Codex
 *
 * Implements the OAuth 2.0 Device Authorization Grant flow to authenticate
 * with OpenAI's Codex API using a ChatGPT Pro/Plus subscription.
 *
 * The flow is:
 * 1. POST to /api/accounts/deviceauth/usercode → get user_code + device_auth_id
 * 2. User visits auth.openai.com/codex/device and enters the user_code
 * 3. Backend polls /api/accounts/deviceauth/token until approved
 * 4. Exchange authorization_code for access_token + refresh_token
 * 5. Store tokens per-user in MongoDB (via callback)
 *
 * Key differences from Anthropic OAuth:
 * - Uses Device Flow (no redirect_uri needed, no local server)
 * - Tokens include an accountId (extracted from JWT claims) for org subscriptions
 * - API calls are rewritten to chatgpt.com/backend-api/codex/responses
 *
 * @see OpenCode reference: packages/opencode/src/plugin/codex.ts
 */

import { log } from '../logger';

const MODULE = 'CodexOAuth';

// OAuth configuration — uses OpenCode's registered client_id
export const CODEX_OAUTH_CONFIG = {
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  issuer: 'https://auth.openai.com',
  codexApiEndpoint: 'https://chatgpt.com/backend-api/codex/responses',
  // Polling safety margin on top of the server-provided interval
  pollingSafetyMarginMs: 3000,
};

// ============================================================================
// TYPES
// ============================================================================

export interface CodexOAuthTokens {
  accessToken: string;
  refreshToken: string;
  /** Unix timestamp in milliseconds */
  expiresAt: number;
  /** ChatGPT account/org ID extracted from JWT claims (used in ChatGPT-Account-Id header) */
  accountId?: string;
}

export interface CodexDeviceCodeResponse {
  /** Opaque ID used to poll for the token */
  deviceAuthId: string;
  /** Short code the user enters at the authorization URL (e.g. "ABC-1234") */
  userCode: string;
  /** Polling interval in seconds */
  interval: number;
  /** URL the user should visit */
  verificationUrl: string;
}

// ============================================================================
// JWT HELPERS (extract accountId from token claims)
// ============================================================================

interface IdTokenClaims {
  chatgpt_account_id?: string;
  organizations?: Array<{ id: string }>;
  'https://api.openai.com/auth'?: {
    chatgpt_account_id?: string;
  };
}

function parseJwtClaims(token: string): IdTokenClaims | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  } catch {
    return undefined;
  }
}

function extractAccountIdFromClaims(claims: IdTokenClaims): string | undefined {
  return (
    claims.chatgpt_account_id ||
    claims['https://api.openai.com/auth']?.chatgpt_account_id ||
    claims.organizations?.[0]?.id
  );
}

export function extractAccountId(tokens: { id_token?: string; access_token: string }): string | undefined {
  if (tokens.id_token) {
    const claims = parseJwtClaims(tokens.id_token);
    const accountId = claims && extractAccountIdFromClaims(claims);
    if (accountId) return accountId;
  }
  const claims = parseJwtClaims(tokens.access_token);
  return claims ? extractAccountIdFromClaims(claims) : undefined;
}

// ============================================================================
// DEVICE FLOW
// ============================================================================

/**
 * Step 1: Request a device code from OpenAI.
 * Returns the user_code to show to the user and the deviceAuthId to poll with.
 */
export async function requestDeviceCode(): Promise<CodexDeviceCodeResponse> {
  const response = await fetch(`${CODEX_OAUTH_CONFIG.issuer}/api/accounts/deviceauth/usercode`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ client_id: CODEX_OAUTH_CONFIG.clientId }),
  });

  if (!response.ok) {
    const error = await response.text();
    log.error(MODULE, 'Failed to request device code', undefined, {
      status: response.status,
      error,
    });
    throw new Error(`Failed to initiate device authorization: ${response.status}`);
  }

  const data = (await response.json()) as {
    device_auth_id: string;
    user_code: string;
    interval: string | number;
  };

  const interval = Math.max(parseInt(String(data.interval)) || 5, 1);

  log.info(MODULE, 'Device code requested', {
    userCode: data.user_code,
    interval,
  });

  return {
    deviceAuthId: data.device_auth_id,
    userCode: data.user_code,
    interval,
    verificationUrl: `${CODEX_OAUTH_CONFIG.issuer}/codex/device`,
  };
}

/**
 * Step 2: Poll for the authorization token.
 * Returns tokens once the user approves, or null if the flow should be retried later.
 * Throws on unrecoverable errors.
 *
 * @param deviceAuthId - From requestDeviceCode()
 * @param userCode - From requestDeviceCode()
 * @param intervalMs - Polling interval in milliseconds (server-provided + safety margin)
 * @param signal - AbortSignal to cancel polling
 */
export async function pollForDeviceToken(
  deviceAuthId: string,
  userCode: string,
  intervalMs: number,
  signal?: AbortSignal,
): Promise<CodexOAuthTokens> {
  log.info(MODULE, 'Starting device token polling', { intervalMs });

  while (true) {
    if (signal?.aborted) {
      throw new Error('Device flow polling cancelled');
    }

    // Wait before polling (first poll also waits to give the user time)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, intervalMs);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('Device flow polling cancelled'));
      });
    });

    if (signal?.aborted) {
      throw new Error('Device flow polling cancelled');
    }

    const response = await fetch(`${CODEX_OAUTH_CONFIG.issuer}/api/accounts/deviceauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_auth_id: deviceAuthId,
        user_code: userCode,
      }),
    });

    if (response.ok) {
      // User approved — exchange authorization_code for tokens
      const data = (await response.json()) as {
        authorization_code: string;
        code_verifier: string;
      };

      return exchangeDeviceCode(data.authorization_code, data.code_verifier);
    }

    // 403/404 = still pending, keep polling
    if (response.status === 403 || response.status === 404) {
      log.debug(MODULE, 'Device code not yet approved, continuing to poll');
      continue;
    }

    // Any other status is a terminal error
    const error = await response.text();
    log.error(MODULE, 'Device token poll failed', undefined, {
      status: response.status,
      error,
    });
    throw new Error(`Device token poll failed with status ${response.status}`);
  }
}

/**
 * Exchange the authorization_code from the device flow for access/refresh tokens.
 */
async function exchangeDeviceCode(
  authorizationCode: string,
  codeVerifier: string,
): Promise<CodexOAuthTokens> {
  const response = await fetch(`${CODEX_OAUTH_CONFIG.issuer}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authorizationCode,
      redirect_uri: `${CODEX_OAUTH_CONFIG.issuer}/deviceauth/callback`,
      client_id: CODEX_OAUTH_CONFIG.clientId,
      code_verifier: codeVerifier,
    }).toString(),
  });

  if (!response.ok) {
    const error = await response.text();
    log.error(MODULE, 'Device code exchange failed', undefined, {
      status: response.status,
      error,
    });
    throw new Error(`Token exchange failed: ${response.status}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    id_token?: string;
    expires_in?: number;
  };

  const accountId = extractAccountId({
    access_token: data.access_token,
    id_token: data.id_token,
  });

  const tokens: CodexOAuthTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    accountId,
  };

  log.info(MODULE, 'Device code exchanged successfully', {
    hasAccountId: !!accountId,
    expiresAt: new Date(tokens.expiresAt).toISOString(),
  });

  return tokens;
}

// ============================================================================
// TOKEN REFRESH
// ============================================================================

/**
 * Refresh an expired access token using the refresh_token.
 * Returns updated tokens or null if refresh fails.
 */
export async function refreshCodexTokens(
  refreshToken: string,
  currentAccountId?: string,
): Promise<CodexOAuthTokens | null> {
  try {
    log.info(MODULE, 'Refreshing Codex access token');

    const response = await fetch(`${CODEX_OAUTH_CONFIG.issuer}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CODEX_OAUTH_CONFIG.clientId,
      }).toString(),
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
      id_token?: string;
      expires_in?: number;
    };

    const accountId = extractAccountId({
      access_token: data.access_token,
      id_token: data.id_token,
    }) ?? currentAccountId;

    const tokens: CodexOAuthTokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
      accountId,
    };

    log.info(MODULE, 'Codex tokens refreshed successfully', {
      hasAccountId: !!accountId,
      expiresAt: new Date(tokens.expiresAt).toISOString(),
    });

    return tokens;
  } catch (error) {
    log.error(MODULE, 'Error refreshing Codex tokens', error as Error);
    return null;
  }
}

/**
 * Check if tokens need refresh (5 minute buffer before expiry).
 */
export function codexTokensNeedRefresh(tokens: Pick<CodexOAuthTokens, 'expiresAt'>): boolean {
  const bufferMs = 5 * 60 * 1000;
  return tokens.expiresAt - bufferMs < Date.now();
}
