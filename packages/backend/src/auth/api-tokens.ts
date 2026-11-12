/**
 * API tokens (`api_tokens`) — long-lived tokens for devices and integrations
 * (G2 glasses, terminal, voice tablets, CLI).
 *
 * The single place that turns a raw token into its document, so every
 * transport (WS auth, voice, G2, terminal) applies the same rules.
 */

import { createHash, randomBytes } from 'crypto';
import type { Db } from 'mongodb';

/** New tokens expire after a year (SEC-4). Tokens created before have no expiry. */
const API_TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Stored form of an API token. Only the sha256 of the token is kept (SEC-4:
 * it used to be stored, listed and accepted in plaintext); the raw value is
 * shown once, when created.
 */
export interface ApiTokenDoc {
  /** sha256 hex of the raw token — the lookup key */
  tokenHash: string;
  /** Public id to list and revoke the token without knowing it */
  tokenId: string;
  /** First characters of the raw token, so a user can tell tokens apart */
  tokenPrefix: string;
  /** Absent on tokens created before expiry existed */
  expiresAt?: string;
  agentId: string;
  userId: string;
  /** Persisted channel for this token (one per token) */
  channelId?: string;
  /** Workspace this token is scoped to (multi-session mode) */
  workspaceId?: string;
  /**
   * What the token may do beyond its transport's default. `tasks:run`: the
   * Claude Code runner's token for the tasks MCP endpoint (CCR-REQ-3) — it
   * works ONE task (`nodeId`) and its subtree, as the token's agent.
   * @spec CCR-REQ-3
   */
  scope?: 'tasks:run';
  /** The task a `tasks:run` token is bound to. @spec CCR-REQ-3 */
  nodeId?: string;
  /** Friendly name, e.g. "My G2 glasses" */
  label?: string;
  createdAt: string;
  lastUsedAt?: string;
}

export function hashApiToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

/** Mint a token for a user + agent. Returns the raw token (shown once) and its stored doc. */
export async function createApiToken(
  db: Db,
  params: {
    userId: string;
    agentId: string;
    label?: string;
    /** Scoped tokens (CCR-REQ-3): the workspace and task they are bound to. */
    workspaceId?: string;
    scope?: ApiTokenDoc['scope'];
    nodeId?: string;
    /** Override the default one-year TTL (ms from now). */
    ttlMs?: number;
  },
): Promise<{ token: string; doc: ApiTokenDoc }> {
  const token = `tak_${randomBytes(24).toString('hex')}`;
  const now = Date.now();
  const doc: ApiTokenDoc = {
    tokenHash: hashApiToken(token),
    tokenId: `atok_${randomBytes(8).toString('hex')}`,
    tokenPrefix: token.slice(0, 12),
    expiresAt: new Date(now + (params.ttlMs ?? API_TOKEN_TTL_MS)).toISOString(),
    agentId: params.agentId,
    userId: params.userId,
    ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
    ...(params.scope ? { scope: params.scope } : {}),
    ...(params.nodeId ? { nodeId: params.nodeId } : {}),
    label: params.label || undefined,
    createdAt: new Date(now).toISOString(),
  };
  await db.collection<ApiTokenDoc>('api_tokens').insertOne(doc);
  return { token, doc };
}

/**
 * Resolve a raw API token to its document.
 *
 * Returns null when the token is unknown or expired, or when its user is
 * deleted or suspended (SEC-5: tokens used to outlive the account). Touches
 * lastUsedAt.
 */
export async function resolveApiToken(db: Db, rawToken: string | null | undefined): Promise<ApiTokenDoc | null> {
  if (!rawToken) return null;

  const tokens = db.collection<ApiTokenDoc>('api_tokens');
  const tokenHash = hashApiToken(rawToken);
  const tokenDoc = await tokens.findOne({ tokenHash });
  if (!tokenDoc) return null;
  if (tokenDoc.expiresAt && new Date(tokenDoc.expiresAt).getTime() <= Date.now()) return null;

  const user = await db
    .collection('users')
    .findOne({ userId: tokenDoc.userId, deletedAt: { $exists: false } }, { projection: { status: 1 } });
  if (!user || user.status === 'suspended') return null;

  // intentional: lastUsedAt is informational — a failed write must not fail auth
  tokens.updateOne({ tokenHash }, { $set: { lastUsedAt: new Date().toISOString() } }).catch(() => {});

  return tokenDoc;
}

/**
 * Delete every API token of a user (e.g. after a password change).
 * Returns how many were removed.
 */
export async function revokeUserApiTokens(db: Db, userId: string): Promise<number> {
  const result = await db.collection('api_tokens').deleteMany({ userId });
  return result.deletedCount;
}
