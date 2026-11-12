/**
 * Secret resolution — user-only (per-user accounts).
 *
 * Product decision (2026-10-26, Pablo): ElevenLabs access requires the user's
 * OWN API key. No system/shared fallback — each user brings their account.
 * Implemented as: resolve only from user secrets; the manifest declares ONLY
 * userSecrets (no systemSecrets), so the backend's getAuthStatus reports
 * needs_user_auth until the user configures their key (the generic hybrid
 * rule in mca-oauth.ts never kicks in without systemSecrets declared).
 *
 * Kept in its own module (not index.ts) so the resolution is directly
 * unit-testable — importing index.ts would start the MCA server.
 */

/**
 * First non-empty string value among `names` in a secrets record.
 * Tolerates null/undefined records (no user secrets configured) and
 * empty-string values (treated as absent, same as the previous `||` chain).
 */
function pickKey(record: Record<string, string> | null | undefined, ...names: string[]): string | undefined {
  if (!record) return undefined;
  for (const name of names) {
    const value = record[name];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/** Which source produced the key — surfaced so the health check can report per-source status. */
export type ApiKeySource = 'user' | 'none';

export interface ResolvedApiKey {
  apiKey: string;
  source: ApiKeySource;
}

/**
 * Resolve the ElevenLabs API key from the user's own secrets only.
 * Returns { apiKey: '', source: 'none' } when the user has no key —
 * callers surface the configure-your-key message (user-only model).
 */
export async function resolveApiKeyWithSource(context: any): Promise<ResolvedApiKey> {
  try {
    const userSecrets = await context.getUserSecrets();
    const userKey = pickKey(userSecrets, 'apiKey', 'API_KEY');
    if (userKey) return { apiKey: userKey, source: 'user' };
  } catch (err) {
    console.error('[mca.elevenlabs] Failed to read user secrets:', (err as Error).message);
  }
  return { apiKey: '', source: 'none' };
}

/**
 * Resolve the ElevenLabs API key: the user's own secret only (user-only
 * model). Empty string when not configured. Same signature as the original
 * inline helper (commit ca21e1776) so the 12 existing call sites stay
 * untouched.
 */
export async function resolveApiKey(context: any): Promise<string> {
  return (await resolveApiKeyWithSource(context)).apiKey;
}

/**
 * Resolve the default ConvAI agent ID: explicit argument → user AGENT_ID
 * (the user's own ElevenLabs account has its own ConvAI agents).
 * No system fallback (user-only model) and no hardcoded default: agent ids
 * are account-scoped, so a foreign default would 404 on the user's account.
 */
export async function resolveAgentId(context: any, explicit?: string): Promise<string> {
  if (explicit) return explicit;
  try {
    const userSecrets = await context.getUserSecrets();
    const userAgentId = pickKey(userSecrets, 'AGENT_ID', 'agentId');
    if (userAgentId) return userAgentId;
  } catch (err) {
    console.error('[mca.elevenlabs] Failed to read AGENT_ID from user secrets:', (err as Error).message);
  }
  return '';
}
