// =============================================================================
// TYPES
// =============================================================================

export interface HomeySecrets {
  CLIENT_ID?: string;
  CLIENT_SECRET?: string;
  ACCESS_TOKEN?: string;
  REFRESH_TOKEN?: string;
  TOKEN_TYPE?: string;
  EXPIRES_IN?: string;
}

// =============================================================================
// TOKEN REFRESH (Bug #1 fix)
// =============================================================================

const ATHOM_TOKEN_ENDPOINT = 'https://api.athom.com/oauth2/token';

/**
 * Refresh the Athom Cloud OAuth2 access token using the refresh_token grant.
 * Persists the new tokens back to user secrets via the MCA SDK so subsequent
 * calls (and process restarts) use the fresh credentials.
 *
 * Returns the updated secrets object with new ACCESS_TOKEN / REFRESH_TOKEN.
 */
export async function refreshAccessToken(
  secrets: HomeySecrets,
  context: { updateUserSecrets: (s: Record<string, string>) => Promise<void> },
): Promise<HomeySecrets> {
  const { CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN } = secrets;

  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
    throw new Error('Cannot refresh token: missing CLIENT_ID, CLIENT_SECRET, or REFRESH_TOKEN.');
  }

  console.error('[homey] Refreshing access token…');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: REFRESH_TOKEN,
  });

  const response = await fetch(ATHOM_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token refresh failed (${response.status}): ${errorText}`);
  }

  const data = await response.json();

  // Persist refreshed tokens so future process starts use them
  const updatedUserSecrets: Record<string, string> = {
    ACCESS_TOKEN: data.access_token,
    REFRESH_TOKEN: data.refresh_token ?? REFRESH_TOKEN, // keep old if not rotated
    TOKEN_TYPE: data.token_type ?? 'bearer',
    EXPIRES_IN: String(data.expires_in ?? 3600),
  };

  await context.updateUserSecrets(updatedUserSecrets);
  console.error('[homey] Access token refreshed and persisted.');

  return { ...secrets, ...updatedUserSecrets };
}

/**
 * Execute an async operation with automatic 401 retry.
 *
 * If the operation throws and the error looks like a 401 / token-expired
 * response, we refresh the access token, invalidate all caches (forcing
 * re-init with the new token), and retry the operation once.
 */
export async function withTokenRefresh<T>(
  secrets: HomeySecrets,
  context: { updateUserSecrets: (s: Record<string, string>) => Promise<void> },
  operation: (sec: HomeySecrets) => Promise<T>,
): Promise<T> {
  try {
    return await operation(secrets);
  } catch (error: any) {
    const msg = String(error?.message ?? error ?? '').toLowerCase();
    const status = error?.statusCode ?? error?.status ?? error?.code;
    const isAuthError =
      status === 401 ||
      msg.includes('401') ||
      msg.includes('unauthorized') ||
      msg.includes('token') ||
      msg.includes('invalid_grant');

    if (!isAuthError) throw error;

    console.error('[homey] Auth error detected, attempting token refresh…', msg.slice(0, 120));

    // Refresh token and invalidate caches so initHomeyApi re-authenticates
    const freshSecrets = await refreshAccessToken(secrets, context);
    invalidateAllCaches();

    // Retry once with fresh secrets
    return await operation(freshSecrets);
  }
}

// =============================================================================
// CACHE WITH TTL (Bug #2 fix)
// =============================================================================

/** Cache entry with timestamp for TTL-based expiration */
interface CacheEntry<T> {
  data: T;
  cachedAt: number; // Date.now() when cached
}

const API_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const ZONES_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes

let homeyApiCacheEntry: CacheEntry<any> | null = null;
export let homeyInstanceCache: any = null;
let zonesCacheEntry: CacheEntry<any> | null = null;

/** Check if a cache entry is still valid */
function isCacheValid<T>(entry: CacheEntry<T> | null, ttlMs: number): entry is CacheEntry<T> {
  if (!entry) return false;
  return Date.now() - entry.cachedAt < ttlMs;
}

/** Invalidate all caches — called on token refresh or health-check */
export function invalidateAllCaches() {
  homeyApiCacheEntry = null;
  homeyInstanceCache = null;
  zonesCacheEntry = null;
}

// =============================================================================
// HOMEY API FACTORY
// =============================================================================

/**
 * Initialize Homey API connection from secrets.
 * Creates a fresh AthomCloudAPI instance, injects the OAuth token, and
 * authenticates against the user's first Homey hub.
 */
export async function initHomeyApi(secrets: HomeySecrets) {
  const clientId = secrets.CLIENT_ID;
  const clientSecret = secrets.CLIENT_SECRET;
  const accessToken = secrets.ACCESS_TOKEN;
  const refreshToken = secrets.REFRESH_TOKEN;
  const tokenType = secrets.TOKEN_TYPE || 'bearer';
  const expiresIn = secrets.EXPIRES_IN ? parseInt(secrets.EXPIRES_IN, 10) : 3600;

  if (!clientId || !clientSecret) {
    throw new Error(
      'Homey OAuth credentials not configured. Missing CLIENT_ID or CLIENT_SECRET in system secrets.',
    );
  }

  if (!accessToken || !refreshToken) {
    throw new Error('Homey account not connected. Please connect your Homey account.');
  }

  // Dynamic import — homey-api has no TypeScript definitions
  // @ts-ignore
  const { default: AthomCloudAPI } = await import('homey-api/lib/AthomCloudAPI.js');

  const cloudApi = new AthomCloudAPI({ clientId, clientSecret });

  // Build Token instance and inject it (double underscore is the internal field)
  const Token = AthomCloudAPI.Token;
  const token = new Token({
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: tokenType,
    expires_in: expiresIn,
  });
  cloudApi.__token = token;

  // Get authenticated user and first Homey hub
  const user = await cloudApi.getAuthenticatedUser();
  const homey = await user.getFirstHomey();
  homeyInstanceCache = homey;

  // Authenticate to the local Homey instance
  const api = await homey.authenticate();

  // Store in cache with timestamp
  homeyApiCacheEntry = { data: api, cachedAt: Date.now() };
  zonesCacheEntry = null; // Reset zones cache on re-auth

  return api;
}

/**
 * Get or initialize Homey API (with TTL-based cache — 5 min)
 */
export async function getHomeyApi(secrets: HomeySecrets) {
  if (isCacheValid(homeyApiCacheEntry, API_CACHE_TTL_MS)) {
    return homeyApiCacheEntry.data;
  }
  // Cache expired or empty — re-initialize
  return await initHomeyApi(secrets);
}

/**
 * Get zones with TTL-based caching (2 min)
 */
export async function getZones(secrets: HomeySecrets) {
  if (isCacheValid(zonesCacheEntry, ZONES_CACHE_TTL_MS)) {
    return zonesCacheEntry.data;
  }
  const api = await getHomeyApi(secrets);
  const zones = await api.zones.getZones();
  zonesCacheEntry = { data: zones, cachedAt: Date.now() };
  return zones;
}

/**
 * Helper to get merged secrets from context
 */
export async function getSecrets(context: { getSystemSecrets: () => Promise<Record<string, string>>; getUserSecrets: () => Promise<Record<string, string>> }): Promise<HomeySecrets> {
  const systemSecrets = await context.getSystemSecrets();
  const userSecrets = await context.getUserSecrets();
  return { ...systemSecrets, ...userSecrets };
}
