/**
 * Runtime configuration — resolves the transport and the mailbox identity of
 * this installed app instance.
 *
 * System secrets (per mcaId, injected as SECRET_MCA_* env vars by the backend
 * and also reachable via context.getSystemSecrets()):
 *   STALWART_BASE_URL / STALWART_ADMIN_TOKEN  → direct transport (the only one)
 *   STALWART_MASTER_SECRET                    → derives mailbox passwords
 *
 * User secrets (per installed instance, SECRET_USER_* env + getUserSecrets()):
 *   MAIL_ACCOUNT   — the mailbox this instance IS (e.g. alice@agents.teros.ai)
 *   MAIL_PASSWORD  — only for human-chosen passwords; agents' mailboxes derive
 *   MAIL_FROM_NAME — default display name for send
 */
import { toolError } from './errors.js';
import { derivePassword } from './stalwart/passwords.js';
import { StalwartClient } from './stalwart/client.js';
import { MessageOps } from './stalwart/messages.js';
import type { TransportConfig } from './stalwart/transport.js';
import type { JmapSession } from './stalwart/types.js';

export interface SystemSecrets {
  STALWART_MASTER_SECRET?: string;
  STALWART_BASE_URL?: string;
  STALWART_ADMIN_TOKEN?: string;
}

export interface UserSecrets {
  MAIL_ACCOUNT?: string;
  MAIL_PASSWORD?: string;
  MAIL_FROM_NAME?: string;
}

export interface ResolvedTransport {
  /** Single transport: always direct (baseUrl + admin token). */
  mode: 'direct';
  client: StalwartClient;
  messages: MessageOps;
}

/** env fallbacks: backend injects SECRET_MCA_<KEY> / SECRET_USER_<KEY>. */
export function pick(secrets: Record<string, string | undefined>, key: string, envPrefix: 'SECRET_MCA' | 'SECRET_USER'): string | undefined {
  const fromSecrets = secrets[key];
  if (fromSecrets !== undefined && fromSecrets !== null && String(fromSecrets).trim() !== '') {
    return String(fromSecrets).trim();
  }
  const envKey = `${envPrefix}_${key.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const fromEnv = process.env[envKey];
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    return fromEnv.trim();
  }
  return undefined;
}

/** Resolve the direct transport from system secrets (STALWART_BASE_URL + STALWART_ADMIN_TOKEN). */
export function resolveTransport(system: Record<string, string | undefined>): ResolvedTransport {
  const cfg: TransportConfig = {
    baseUrl: pick(system, 'STALWART_BASE_URL', 'SECRET_MCA'),
    token: pick(system, 'STALWART_ADMIN_TOKEN', 'SECRET_MCA'),
  };
  if (!cfg.baseUrl || !cfg.token) {
    throw toolError(
      'NOT_CONFIGURED',
      'Direct Stalwart transport is not configured',
      'set STALWART_BASE_URL + STALWART_ADMIN_TOKEN in the system secrets of mca.teros.email (e.g. https://relay.teros.ai + its admin API key)',
    );
  }
  const client = new StalwartClient(cfg);
  return { mode: 'direct', client, messages: new MessageOps(client.transport, () => ({ mode: 'token' })) };
}

export interface MailboxIdentity {
  account: string;
  password: string;
  fromName?: string;
  passwordSource: 'user' | 'derived';
}

/**
 * Resolve the mailbox identity of this instance (spec §3.2):
 * 1. MAIL_ACCOUNT is mandatory.
 * 2. Password: MAIL_PASSWORD if present, else derivePassword(MAIL_ACCOUNT, STALWART_MASTER_SECRET).
 */
export function resolveMailbox(user: Record<string, string | undefined>, system: Record<string, string | undefined>): MailboxIdentity {
  const account = pick(user, 'MAIL_ACCOUNT', 'SECRET_USER');
  if (!account) {
    throw toolError(
      'AUTH_REQUIRED',
      'MAIL_ACCOUNT is not configured for this app instance',
      'open the app settings and set MAIL_ACCOUNT (e.g. alice@agents.teros.ai) — every instance IS one mailbox',
    );
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(account)) {
    throw toolError('INVALID_REQUEST', `MAIL_ACCOUNT is not a valid email address: ${account}`);
  }
  const explicit = pick(user, 'MAIL_PASSWORD', 'SECRET_USER');
  if (explicit) {
    return { account, password: explicit, fromName: pick(user, 'MAIL_FROM_NAME', 'SECRET_USER'), passwordSource: 'user' };
  }
  const master = pick(system, 'STALWART_MASTER_SECRET', 'SECRET_MCA');
  if (!master) {
    throw toolError(
      'AUTH_REQUIRED',
      'No mailbox password available',
      'set MAIL_PASSWORD for this instance (human-chosen mailbox) or STALWART_MASTER_SECRET in the system secrets (derived agent mailbox)',
    );
  }
  return { account, password: derivePassword(account, master), fromName: pick(user, 'MAIL_FROM_NAME', 'SECRET_USER'), passwordSource: 'derived' };
}

// ---------------------------------------------------------------------------
// Session cache — accountId per mailbox, TTL 5 min, invalidated on auth errors.
// ---------------------------------------------------------------------------

const SESSION_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  accountId: string;
  session: JmapSession;
  expiresAt: number;
}

const sessionCache = new Map<string, CacheEntry>();

/** Invalidate the cached session of a mailbox (after an auth error). */
export function invalidateSession(account: string): void {
  sessionCache.delete(account);
}

export function isAuthError(err: unknown): boolean {
  return err instanceof Error && /\[AUTH_INVALID\]|\[AUTH_REQUIRED\]|401|403|unauthor|forbidden|credential/i.test(err.message);
}

/**
 * Get the mail accountId for a mailbox (cached 5 min; re-authenticates once
 * after an auth failure).
 */
export async function getAccountId(
  rt: ResolvedTransport,
  mailbox: MailboxIdentity,
): Promise<{ accountId: string; session: JmapSession }> {
  const cached = sessionCache.get(mailbox.account);
  if (cached && cached.expiresAt > Date.now()) {
    return { accountId: cached.accountId, session: cached.session };
  }
  try {
    const session = await rt.client.session(mailbox.account, mailbox.password);
    const accountId = session.primaryAccounts?.['urn:ietf:params:jmap:mail'];
    if (!accountId) {
      throw toolError('AUTH_INVALID', `No primary mail account in JMAP session for ${mailbox.account}`);
    }
    sessionCache.set(mailbox.account, { accountId, session, expiresAt: Date.now() + SESSION_TTL_MS });
    return { accountId, session };
  } catch (err) {
    invalidateSession(mailbox.account);
    throw err;
  }
}

/**
 * One-call context for mail tools: transport + mailbox + accountId.
 * Retries once with a fresh session when the cached one went stale (auth error).
 */
export async function mailContext(
  system: Record<string, string | undefined>,
  user: Record<string, string | undefined>,
): Promise<{ rt: ResolvedTransport; mailbox: MailboxIdentity; accountId: string; session: JmapSession }> {
  const rt = resolveTransport(system);
  const mailbox = resolveMailbox(user, system);
  try {
    const { accountId, session } = await getAccountId(rt, mailbox);
    return { rt, mailbox, accountId, session };
  } catch (err) {
    if (isAuthError(err)) {
      invalidateSession(mailbox.account);
      const { accountId, session } = await getAccountId(rt, mailbox);
      return { rt, mailbox, accountId, session };
    }
    throw err;
  }
}
