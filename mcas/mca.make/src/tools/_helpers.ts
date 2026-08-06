/**
 * Shared helpers for mca.make tool handlers (account API tools only). Kept in a
 * single `_helpers.ts` so the secret/region resolution stays consistent across
 * `list-scenarios` and `run-scenario`.
 */

import type { ToolContext } from '@teros/mca-sdk';
import { MakeError } from '../lib/errors';

/** Read user secrets, tolerating a backend that hasn't provisioned any yet. */
export async function getUserSecretsSafe(context: ToolContext): Promise<Record<string, string>> {
  try {
    return (await context.getUserSecrets()) ?? {};
  } catch (err) {
    // A failure here is almost always the backend secrets callback being unreachable
    // (see TER-564: mca.make on the egress network → host INPUT chain drops the callback).
    // Log it so it is diagnosable instead of silently masquerading as AUTH_REQUIRED, then
    // return {} so downstream surfaces a clear "MAKE_API_TOKEN is not configured" only when
    // the token genuinely isn't present.
    // @fixme alice - 2026.07.02 : returning {} here still conflates "callback failed"
    // (transient/infra) with "token truly missing" (config). A follow-up should re-throw a
    // coded MakeError('DEPENDENCY_UNAVAILABLE') when getUserSecrets throws, so the LLM can
    // distinguish a retryable infra failure from a real missing-token.
    console.error(
      '[mca.make] getUserSecrets() failed — cannot read user secrets:',
      err instanceof Error ? err.message : String(err),
    );
    return {};
  }
}

/**
 * Require the account API token. Throws `[AUTH_REQUIRED]` (not a transient
 * failure) with a message that distinguishes the account API from the
 * always-available webhook trigger.
 */
export function requireApiToken(secrets: Record<string, string>): string {
  const token = secrets.MAKE_API_TOKEN ?? secrets.make_api_token;
  if (!token || token.trim().length === 0) {
    throw new MakeError(
      'AUTH_REQUIRED',
      'MAKE_API_TOKEN is not configured. Add it in user secrets to use the Make account API (scenarios). The trigger-webhook tool works without a token.',
    );
  }
  return token.trim();
}

/** Clamp an optional numeric limit into `[1, max]`, defaulting when absent/invalid. */
export function clampLimit(limit: unknown, fallback = 50, max = 100): number {
  const n = typeof limit === 'number' ? limit : Number(limit);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

/** Clamp an optional numeric offset into `[0, ∞)`, defaulting to 0 when absent/invalid. */
export function clampOffset(offset: unknown): number {
  const n = typeof offset === 'number' ? offset : Number(offset);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}
