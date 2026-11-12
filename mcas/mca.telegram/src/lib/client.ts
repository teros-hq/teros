/**
 * mca.telegram — Telegram via MTProto (teleproto, maintained GramJS fork)
 *
 * The MCA server embeds a TelegramClient directly (no external gateway like
 * WAHA). The MTProto session is persisted as a StringSession file in the
 * per-app data dir (/app-data, bind-mounted from the user's workspace volume
 * via appDataMount: true) so auth survives container restarts.
 *
 * Auth flow (agent-mediated, same UX model as WhatsApp pairing):
 *   1. auth-send-code  — user gives their phone number, Telegram sends a code
 *   2. auth-sign-in    — user gives the code (+ 2FA password if enabled)
 *   3. session saved   — subsequent tool calls reuse the persisted session
 */
import { Api, TelegramClient, sessions, errors } from 'teleproto';
import fs from 'fs';
import path from 'path';
import type { ToolContext } from '@teros/mca-sdk';

// ============================================================================
// Config
// ============================================================================

/** Per-app persistent data dir (bind-mounted from the user's workspace). */
export const APP_DATA_DIR = process.env.TELEGRAM_APP_DATA_DIR || '/app-data';
const SESSION_FILE = path.join(APP_DATA_DIR, 'session.txt');
const AUTH_STATE_FILE = path.join(APP_DATA_DIR, 'auth-state.json');

export function getApiCredentials(): { apiId: number; apiHash: string } {
  const apiId = parseInt(process.env.TELEGRAM_API_ID || '', 10);
  const apiHash = process.env.TELEGRAM_API_HASH || '';
  if (!apiId || !apiHash) {
    throw new Error(
      'TELEGRAM_API_ID / TELEGRAM_API_HASH not configured. ' +
        'Create API credentials at https://my.telegram.org/apps and store them ' +
        'in .secrets/mcas/mca.telegram/credentials.json.',
    );
  }
  return { apiId, apiHash };
}

// ============================================================================
// Session persistence
// ============================================================================

export function loadSavedSession(): string | null {
  try {
    return fs.readFileSync(SESSION_FILE, 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

export function saveSession(sessionString: string): void {
  fs.mkdirSync(APP_DATA_DIR, { recursive: true });
  fs.writeFileSync(SESSION_FILE, sessionString, { mode: 0o600 });
}

export function clearSession(): void {
  try {
    fs.rmSync(SESSION_FILE, { force: true });
  } catch {
    // best-effort
  }
  try {
    fs.rmSync(AUTH_STATE_FILE, { force: true });
  } catch {
    // best-effort
  }
}

/**
 * Persist the client's current session to disk. Called after every connect
 * (GramJS may rotate the auth key) and after sign-in.
 */
function persistSession(client: TelegramClient): void {
  try {
    const s = (client.session as unknown as sessions.StringSession).save() as unknown as string;
    if (s && typeof s === 'string') saveSession(s);
  } catch (err) {
    console.error('[mca.telegram] Failed to persist session:', (err as Error).message);
  }
}

// ============================================================================
// Auth state (multi-step sign-in: send-code → sign-in → 2FA)
// ============================================================================

export interface AuthState {
  phoneCodeHash: string;
  phoneNumber: string;
  createdAt: number;
}

export function loadAuthState(): AuthState | null {
  try {
    const raw = JSON.parse(fs.readFileSync(AUTH_STATE_FILE, 'utf-8')) as AuthState;
    // Codes expire after ~5 minutes per Telegram; allow 15 for slow humans.
    if (Date.now() - raw.createdAt > 15 * 60 * 1000) return null;
    return raw;
  } catch {
    return null;
  }
}

export function saveAuthState(state: AuthState): void {
  fs.mkdirSync(APP_DATA_DIR, { recursive: true });
  fs.writeFileSync(AUTH_STATE_FILE, JSON.stringify(state), { mode: 0o600 });
}

export function clearAuthState(): void {
  try {
    fs.rmSync(AUTH_STATE_FILE, { force: true });
  } catch {
    // best-effort
  }
}

// ============================================================================
// Client singleton
// ============================================================================

let clientPromise: Promise<TelegramClient> | null = null;

/**
 * Get (or create) the connected TelegramClient. Safe to call concurrently —
 * all callers await the same connection attempt.
 *
 * Does NOT require the user to be authorized: auth tools need a connected
 * client before sign-in. Use `requireAuthorizedClient` for user-scoped tools.
 */
export function getClient(): Promise<TelegramClient> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const { apiId, apiHash } = getApiCredentials();
      const saved = loadSavedSession();
      const session = new sessions.StringSession(saved || '');
      const client = new TelegramClient(session, apiId, apiHash, {
        connectionRetries: 5,
        requestRetries: 3,
        autoReconnect: true,
      });
      client.setLogLevel(process.env.TELEGRAM_LOG_LEVEL as never || 'error');
      await client.connect();
      if (saved) persistSession(client);
      return client;
    })().catch((err) => {
      clientPromise = null; // allow retry on next call
      throw err;
    });
  }
  return clientPromise;
}

/** True if the persisted session belongs to a signed-in user account. */
export async function isAuthorized(): Promise<boolean> {
  try {
    const client = await getClient();
    return await client.isUserAuthorized();
  } catch {
    return false;
  }
}

/**
 * Get the client and guarantee a signed-in user account. User-scoped tools
 * call this; it fails with a clear, agent-readable message when not linked.
 */
export async function requireAuthorizedClient(): Promise<TelegramClient> {
  const client = await getClient();
  if (!(await client.isUserAuthorized())) {
    throw new Error(
      'Telegram account not connected. Run auth-send-code with the user\'s phone ' +
        'number, then auth-sign-in with the code Telegram sent (and the 2FA ' +
        'password if enabled).',
    );
  }
  return client;
}

/** Persist + tear down the client (used by auth-disconnect). */
export async function resetClient(): Promise<void> {
  try {
    const client = await getClient();
    await client.disconnect();
  } catch {
    // client may not exist yet — nothing to reset
  }
  clientPromise = null;
}

export { persistSession };

// ============================================================================
// Entity helpers
// ============================================================================

/**
 * Resolve a user-supplied chat identifier to an entity.
 * Accepts: numeric Teros-style chat ID (e.g. "-1001234567890", "5612345678"),
 * @username, or t.me link.
 */
export async function resolveChat(client: TelegramClient, chat: string): Promise<never | Api.TypeEntityLike> {
  const trimmed = (chat || '').trim();
  if (!trimmed) throw new Error('chat is required (chat ID, @username, or t.me link)');
  // t.me links → username
  const tme = trimmed.match(/(?:t\.me\/|telegram\.me\/)(?:s\/)?@?([A-Za-z0-9_]{3,})/);
  if (tme) return client.getEntity(tme[1]);
  // @username
  if (trimmed.startsWith('@')) return client.getEntity(trimmed);
  // Numeric ID (Teros convention: -100 prefix for channels/supergroups)
  if (/^-?\d+$/.test(trimmed)) {
    const raw = trimmed.replace(/^-100/, '').replace(/^-/, '');
    try {
      return await client.getEntity(BigInt(raw).toString());
    } catch {
      // fall through to raw pass-through so GramJS raises a precise error
      return client.getInputEntity(trimmed as never);
    }
  }
  return client.getEntity(trimmed);
}

// ============================================================================
// Serialization helpers (TL objects → plain JSON for the agent)
// ============================================================================

export function peerToChatId(peer: unknown): string | null {
  if (!peer) return null;
  const p = peer as { className?: string; userId?: unknown; chatId?: unknown; channelId?: unknown };
  switch (p.className) {
    case 'PeerUser':
      return String(p.userId);
    case 'PeerChat':
      return String(p.chatId);
    case 'PeerChannel':
      // -100 prefix is the Bot-API convention for channels/supergroups
      return `-100${p.channelId}`;
    default:
      return null;
  }
}

export function serializeUser(user: unknown): Record<string, unknown> {
  const u = user as {
    id?: unknown;
    firstName?: string;
    lastName?: string;
    username?: string;
    phone?: string;
    bot?: boolean;
    premium?: boolean;
    verified?: boolean;
    photo?: { className?: string };
  };
  if (!u) return {};
  return {
    id: u.id != null ? String(u.id) : null,
    firstName: u.firstName ?? null,
    lastName: u.lastName ?? null,
    username: u.username ?? null,
    phone: u.phone ?? null,
    isBot: Boolean(u.bot),
    isPremium: Boolean(u.premium),
    isVerified: Boolean(u.verified),
    hasPhoto: Boolean(u.photo),
  };
}

export function serializeChatEntity(entity: unknown): Record<string, unknown> {
  const e = entity as {
    className?: string;
    id?: unknown;
    title?: string;
    username?: string;
    firstName?: string;
    lastName?: string;
    participantsCount?: number;
    broadcast?: boolean;
    megagroup?: boolean;
    verified?: boolean;
    restricted?: boolean;
    creator?: boolean;
    photo?: { className?: string };
  };
  if (!e) return {};
  const base: Record<string, unknown> = {
    id: e.id != null ? String(e.id) : null,
    type: e.className === 'User' ? 'user' : e.broadcast ? 'channel' : e.megagroup ? 'supergroup' : 'group',
    title: e.title ?? null,
    username: e.username ?? null,
    firstName: e.firstName ?? null,
    lastName: e.lastName ?? null,
    membersCount: e.participantsCount ?? null,
    isVerified: Boolean(e.verified),
    isRestricted: Boolean(e.restricted),
    isCreator: Boolean(e.creator),
    hasPhoto: Boolean(e.photo),
  };
  if (e.className === 'User') {
    base.chatId = String(e.id);
  } else if (e.className === 'Channel') {
    base.chatId = `-100${e.id}`;
  } else {
    base.chatId = String(e.id);
  }
  return base;
}

export interface SerializedMessage {
  id: number;
  chatId: string | null;
  date: string | null;
  text: string;
  fromId: string | null;
  fromMe: boolean;
  replyToMsgId: number | null;
  hasMedia: boolean;
  mediaType: string | null;
  views: number | null;
  forwards: number | null;
  editDate: string | null;
  groupedId: string | null;
}

export function serializeMessage(msg: unknown): SerializedMessage {
  const m = msg as {
    id: number;
    peerId?: unknown;
    date?: number;
    message?: string;
    text?: string;
    fromId?: unknown;
    out?: boolean;
    replyTo?: { replyToMsgId?: number } | null;
    media?: { className?: string } | null;
    views?: number;
    forwards?: number;
    editDate?: number;
    groupedId?: unknown;
  };
  const mediaType =
    m.media && m.media.className && m.media.className !== 'MessageMediaEmpty'
      ? m.media.className
      : null;
  return {
    id: m.id,
    chatId: peerToChatId(m.peerId),
    date: m.date ? new Date(m.date * 1000).toISOString() : null,
    text: (m.message ?? m.text ?? '') as string,
    fromId: peerToChatId(m.fromId),
    fromMe: Boolean(m.out),
    replyToMsgId: m.replyTo?.replyToMsgId ?? null,
    hasMedia: Boolean(mediaType),
    mediaType,
    views: m.views ?? null,
    forwards: m.forwards ?? null,
    editDate: m.editDate ? new Date(m.editDate * 1000).toISOString() : null,
    groupedId: m.groupedId != null ? String(m.groupedId) : null,
  };
}

// ============================================================================
// Error handling
// ============================================================================

/**
 * Convert a thrown error into an agent-readable plain object. Special-cases
 * FloodWait so the agent knows exactly how long to wait before retrying.
 */
export function toToolError(err: unknown): Record<string, unknown> {
  if (err instanceof errors.FloodWaitError) {
    return {
      success: false,
      error: `Telegram rate limit hit — retry in ${err.seconds} seconds`,
      retryAfterSeconds: err.seconds,
    };
  }
  if (err instanceof errors.SessionPasswordNeededError) {
    return { success: false, error: 'Two-factor authentication is enabled. Call auth-sign-in with the account password (2FA).' };
  }
  if (err instanceof errors.PhoneCodeInvalidError || err instanceof errors.PhoneCodeExpiredError) {
    return { success: false, error: 'The code is invalid or expired. Restart with auth-send-code.' };
  }
  if (err instanceof errors.PhoneNumberInvalidError) {
    return { success: false, error: 'The phone number is invalid. Use international format, e.g. "+34612345678".' };
  }
  const e = err as { errorMessage?: string; message?: string };
  return { success: false, error: e?.errorMessage || e?.message || String(err) };
}

/** Wrap a handler body so thrown errors become structured tool results. */
export async function runCatched<T>(fn: () => Promise<T>): Promise<T | Record<string, unknown>> {
  try {
    return await fn();
  } catch (err) {
    return toToolError(err);
  }
}

// ============================================================================
// Tool context typing (structural, to avoid importing SDK types in every file)
// ============================================================================

export type Ctx = ToolContext;
