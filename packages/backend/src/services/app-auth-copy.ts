/**
 * copyAppAuth — replicate a user's app credentials from one app instance to
 * another (task tn_aGVdSrVwIJi9mfvc, Pablo 2-nov: "copiar la auth de una
 * instancia de app a otra, cross-workspace"). Shared by the agent route
 * (mca-resources-handlers → POST /resources/apps/:targetId/secrets action
 * 'copy') and the admin surface (admin-api.apps-copy-auth).
 *
 * ⚠️ CRITICAL — never clone the Mongo document directly: the credential blob
 * is encrypted per-user with a scope that includes the appId
 * (`user_credentials:${appId}`), so a cloned ciphertext can never be decrypted
 * under the target's scope. The ONLY correct path is decrypt-with-source-scope
 * → re-encrypt-with-target-scope, i.e. AuthManager.get → AuthManager.set.
 * `set` is a FULL REPLACE (never merge) — copy semantics are set semantics.
 *
 * Cross-user copies are impossible by construction: the credential store is
 * keyed by (userId, appId) and callers only ever name their own userId (the
 * agent route passes ctx.userId; the admin route resolves the source
 * workspace's owner or an explicit userId). Access to both apps is verified by
 * the route handlers before this service runs.
 *
 * Workspace IDs are REQUIRED (Pablo 2-nov, tn_hj1s2cs1t93g91xq): copy-app-auth
 * is a cross-workspace tool, and cross-workspace tools ALWAYS name the
 * workspaceId of every workspace they touch — Teros infra is being sharded by
 * workspaceId, so a tool must know which infrastructure it is hitting at all
 * times. sourceWorkspaceId/targetWorkspaceId are validated against the apps'
 * actual owner (WORKSPACE_MISMATCH on divergence).
 */

import type { Db } from 'mongodb';
import type { AuthManager } from '../auth/auth-manager';
import { maskSecret } from '@teros/shared';

export interface AppAuthCopyParams {
  /** User whose credential is copied (agent route: the caller; admin: resolved owner). */
  userId: string;
  sourceAppId: string;
  targetAppId: string;
  /** REQUIRED — cross-workspace tools always name their workspaces (infra sharded by workspaceId). */
  sourceWorkspaceId: string;
  /** REQUIRED — cross-workspace tools always name their workspaces (infra sharded by workspaceId). */
  targetWorkspaceId: string;
  /** Actor for the audit line (agentId or admin userId) — never a secret. */
  actorId?: string;
}

export interface CopiedField {
  key: string;
  maskedValue: string;
}

export interface AppAuthCopySummary {
  sourceAppId: string;
  sourceAppName: string;
  targetAppId: string;
  targetAppName: string;
  mcaId: string;
  /** Field names + masks ONLY — values never leave this module unmasked. */
  copiedFields: CopiedField[];
  fieldCount: number;
  /** True when the blob carries OAuth tokens (access/refresh) — drives the caveat note. */
  hasOAuthTokens: boolean;
}

export type AppAuthCopyOutcome =
  | { ok: true; summary: AppAuthCopySummary }
  | { ok: false; status: number; code: string; message: string; extra?: Record<string, unknown> };

const TOKEN_KEY_RE = /(access_token|refresh_token|token_type|id_token|^token$)/i;

export async function copyAppAuth(
  db: Db,
  authManager: AuthManager,
  params: AppAuthCopyParams,
): Promise<AppAuthCopyOutcome> {
  const { userId, sourceAppId, targetAppId, sourceWorkspaceId, targetWorkspaceId, actorId } = params;

  // ── 1. Params ─────────────────────────────────────────────────────────────
  if (!sourceAppId || typeof sourceAppId !== 'string') {
    return { ok: false, status: 400, code: 'VALIDATION_ERROR', message: 'sourceAppId is required (the app instance to copy credentials FROM)' };
  }
  if (!targetAppId || typeof targetAppId !== 'string') {
    return { ok: false, status: 400, code: 'VALIDATION_ERROR', message: 'targetAppId is required (the app instance to copy credentials TO)' };
  }
  if (sourceAppId === targetAppId) {
    return {
      ok: false,
      status: 400,
      code: 'VALIDATION_ERROR',
      message: `sourceAppId and targetAppId are the same instance ('${sourceAppId}') — nothing to copy`,
    };
  }
  // Cross-workspace tools ALWAYS name their workspaces (tn_hj1s2cs1t93g91xq,
  // Pablo 2-nov: infra sharded by workspaceId — a tool must know which
  // infrastructure it is hitting at all times).
  if (!sourceWorkspaceId || typeof sourceWorkspaceId !== 'string') {
    return {
      ok: false,
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'sourceWorkspaceId is required — cross-workspace tools always name their workspaces (the workspace the source app lives in)',
    };
  }
  if (!targetWorkspaceId || typeof targetWorkspaceId !== 'string') {
    return {
      ok: false,
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'targetWorkspaceId is required — cross-workspace tools always name their workspaces (the workspace the target app lives in)',
    };
  }

  // ── 2. Both apps exist ────────────────────────────────────────────────────
  const [sourceApp, targetApp] = await Promise.all([
    db.collection('apps').findOne({ appId: sourceAppId }),
    db.collection('apps').findOne({ appId: targetAppId }),
  ]);
  if (!sourceApp) {
    return { ok: false, status: 404, code: 'NOT_FOUND', message: `Source app '${sourceAppId}' not found` };
  }
  if (!targetApp) {
    return { ok: false, status: 404, code: 'NOT_FOUND', message: `Target app '${targetAppId}' not found` };
  }

  // ── 3. Workspace disambiguation (REQUIRED — see header) ──────────────────
  if (sourceApp.ownerId !== sourceWorkspaceId) {
    return {
      ok: false,
      status: 400,
      code: 'WORKSPACE_MISMATCH',
      message: `Source app '${sourceAppId}' is not in workspace '${sourceWorkspaceId}' — it lives in '${sourceApp.ownerId}'`,
    };
  }
  if (targetApp.ownerId !== targetWorkspaceId) {
    return {
      ok: false,
      status: 400,
      code: 'WORKSPACE_MISMATCH',
      message: `Target app '${targetAppId}' is not in workspace '${targetWorkspaceId}' — it lives in '${targetApp.ownerId}'`,
    };
  }

  // ── 4. Same MCA — cross-type copies are meaningless ───────────────────────
  if (sourceApp.mcaId !== targetApp.mcaId) {
    return {
      ok: false,
      status: 400,
      code: 'CROSS_MCA_BLOCKED',
      message: `Cannot copy auth across app types: source is ${sourceApp.mcaId}, target is ${targetApp.mcaId}. Credentials are only meaningful between instances of the same MCA.`,
      extra: { sourceMcaId: sourceApp.mcaId, targetMcaId: targetApp.mcaId },
    };
  }

  // ── 5. Source credential exists and is not revoked ────────────────────────
  const credDoc = await authManager.getCredentialDoc(userId, sourceAppId);
  if (!credDoc) {
    return {
      ok: false,
      status: 404,
      code: 'NO_SOURCE_CREDENTIAL',
      message: `No credential stored for app '${sourceAppId}' (user ${userId}) — connect the source app first (show-app-auth) or store a secret (set-app-secret)`,
    };
  }
  if (credDoc.revokedAt) {
    return {
      ok: false,
      status: 409,
      code: 'SOURCE_REVOKED',
      message: `The credential for app '${sourceAppId}' (user ${userId}) is revoked — reconnect the source app before copying`,
    };
  }

  // ── 6. The copy: decrypt with the SOURCE scope, re-encrypt with the TARGET ─
  // AuthManager.get re-checks revocation and decrypts; AuthManager.set is a
  // full-replace write under the target's scope. NEVER merge, NEVER clone.
  const data = await authManager.get(userId, sourceAppId);
  if (data == null || typeof data !== 'object') {
    return {
      ok: false,
      status: 404,
      code: 'NO_SOURCE_CREDENTIAL',
      message: `No readable credential for app '${sourceAppId}' (user ${userId})`,
    };
  }

  await authManager.set(userId, targetAppId, targetApp.mcaId as string, data);

  // ── 7. Masked summary — field names + masks, values never exposed ─────────
  const copiedFields: CopiedField[] = Object.entries(data as Record<string, unknown>).map(([key, value]) => ({
    key,
    maskedValue: typeof value === 'string' ? maskSecret(value) : '****',
  }));

  // Audit — counts and ids only, NEVER a value (same rule as set-app-secret).
  console.log(
    `[Resources] app.copy-auth: ${copiedFields.length} credential fields of app ${sourceAppId} copied to app ${targetAppId} for user ${userId} by ${actorId ?? userId}`,
  );

  return {
    ok: true,
    summary: {
      sourceAppId,
      sourceAppName: (sourceApp.name as string | undefined) ?? sourceAppId,
      targetAppId,
      targetAppName: (targetApp.name as string | undefined) ?? targetAppId,
      mcaId: targetApp.mcaId as string,
      copiedFields,
      fieldCount: copiedFields.length,
      hasOAuthTokens: copiedFields.some((f) => TOKEN_KEY_RE.test(f.key)),
    },
  };
}
