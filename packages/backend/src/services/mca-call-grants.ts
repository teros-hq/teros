import { randomBytes } from 'crypto';

export interface McaCallGrant {
  appId: string;
  userId: string;
  channelId?: string;
  workspaceId?: string;
  agentId?: string;
}

export const MCA_CALL_GRANT_PREFIX = 'call_';
const DEFAULT_TTL_MS = 15 * 60 * 1000;

const grants = new Map<string, { grant: McaCallGrant; expiresAt: number }>();

function sweep(now: number): void {
  for (const [id, entry] of grants) {
    if (entry.expiresAt <= now) grants.delete(id);
  }
}

export function issueMcaCallGrant(grant: McaCallGrant, ttlMs = DEFAULT_TTL_MS): string {
  const now = Date.now();
  sweep(now);
  const id = `${MCA_CALL_GRANT_PREFIX}${randomBytes(18).toString('base64url')}`;
  grants.set(id, { grant: { ...grant }, expiresAt: now + ttlMs });
  return id;
}

export function isMcaCallGrantId(value: string | undefined): value is string {
  return typeof value === 'string' && value.startsWith(MCA_CALL_GRANT_PREFIX);
}

export function resolveMcaCallGrant(id: string): McaCallGrant | null {
  const entry = grants.get(id);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    grants.delete(id);
    return null;
  }
  return { ...entry.grant };
}
