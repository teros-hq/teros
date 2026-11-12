/**
 * MCA Request Authentication — HMAC-SHA256 request signing
 *
 * Defense-in-depth Layer B (incident-2026-08-14).
 *
 * The backend signs every tool-call request sent to an MCA container using
 * a per-container secret (the same `MCA_CALLBACK_TOKEN` already generated
 * by McaContainerManager and injected via `-e`). The MCA HTTP server
 * verifies the signature before executing any tool, so even if a request
 * reaches the wrong container (cross-tenant routing bug), the signature
 * won't match and the container rejects it.
 *
 * Signed payload: `userId:workspaceId:appId:toolCallId`
 * Algorithm: HMAC-SHA256, hex-encoded output.
 *
 * The secret is shared between backend and container — it is NOT transmitted
 * in the request. Both sides derive it from `MCA_CALLBACK_TOKEN` / the
 * per-container callback token.
 */

import { createHmac, timingSafeEqual } from 'crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Fields that participate in the HMAC signature.
 * These are the identity-binding components: who (userId), where
 * (workspaceId), which app (appId), and which specific call (toolCallId).
 */
export interface McaRequestAuthPayload {
  userId: string;
  workspaceId: string;
  appId: string;
  toolCallId: string;
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/**
 * Build the canonical string that gets signed.
 *
 * Format: `userId:workspaceId:appId:toolCallId`
 *
 * All four fields are required — if any is missing, signing fails (fail-closed).
 * This is intentional: a request without full identity context must not be
 * signable, and therefore must not be executable on the MCA side.
 */
export function buildSignaturePayload(payload: McaRequestAuthPayload): string {
  if (!payload.userId) throw new Error('[McaAuth] userId is required for signing');
  if (!payload.workspaceId) throw new Error('[McaAuth] workspaceId is required for signing');
  if (!payload.appId) throw new Error('[McaAuth] appId is required for signing');
  if (!payload.toolCallId) throw new Error('[McaAuth] toolCallId is required for signing');

  return `${payload.userId}:${payload.workspaceId}:${payload.appId}:${payload.toolCallId}`;
}

/**
 * Sign a request payload with the per-container secret using HMAC-SHA256.
 *
 * @param payload - Identity fields to bind to the signature
 * @param secret  - Per-container secret (the callback token)
 * @returns Hex-encoded HMAC-SHA256 signature
 */
export function signRequest(payload: McaRequestAuthPayload, secret: string): string {
  if (!secret) throw new Error('[McaAuth] secret is required for signing');
  const data = buildSignaturePayload(payload);
  return createHmac('sha256', secret).update(data, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Verify a request signature against the per-container secret.
 *
 * Uses `timingSafeEqual` to prevent timing attacks. Returns `true` only if:
 * 1. All four payload fields are present and non-empty.
 * 2. The secret is non-empty.
 * 3. The provided signature matches the expected HMAC exactly.
 *
 * Any missing field or mismatch → `false` (fail-closed).
 */
export function verifyRequest(
  payload: McaRequestAuthPayload,
  signature: string,
  secret: string,
): boolean {
  // Fail-closed: any missing input → reject
  if (!secret || !signature) return false;
  if (!payload.userId || !payload.workspaceId || !payload.appId || !payload.toolCallId) {
    return false;
  }

  try {
    const expected = signRequest(payload, secret);
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(signature, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
