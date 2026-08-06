/**
 * Gmail Email Watcher
 *
 * Background polling loop that detects new unread emails and emits
 * `gmail.email.received` events via the backend MCA event system.
 *
 * Limitations (MVP):
 * - State (known message IDs) is kept in-memory only. Process restart loses
 *   state and may re-report older unread emails.
 * - Uses polling (Gmail API quota: ~1 request per 5 min). No push webhooks.
 * - Only watches the primary account associated with this MCA app process.
 *
 * @todo nira - 2026.05.20 : persist knownMessageIds to disk or backend data
 *   store so restarts don't re-emit old emails.
 */

import { McaBackendClient } from '@teros/mca-sdk';
import { OAuth2Client } from 'google-auth-library';
import { google } from 'googleapis';

// =============================================================================
// TYPES
// =============================================================================

interface GmailSecrets {
  CLIENT_ID?: string;
  CLIENT_SECRET?: string;
  REDIRECT_URIS?: string;
  ACCESS_TOKEN?: string;
  REFRESH_TOKEN?: string;
  EMAIL?: string;
  EXPIRY_DATE?: string;
}

interface WatcherState {
  intervalId: ReturnType<typeof setInterval> | null;
  lastCheckedAt: number | null;
  knownMessageIds: Set<string>;
  isActive: boolean;
  backendClient: McaBackendClient | null;
  intervalMs: number;
}

// =============================================================================
// STATE
// =============================================================================

const state: WatcherState = {
  intervalId: null,
  lastCheckedAt: null,
  knownMessageIds: new Set(),
  isActive: false,
  backendClient: null,
  intervalMs: 0,
};

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_KNOWN_IDS = 1000;
const FIRST_CHECK_HOURS_BACK = 24;

// =============================================================================
// GMAIL CLIENT FACTORY (duplicated from index.ts to keep watcher self-contained)
// =============================================================================

function getDisplayName(email?: string): string | undefined {
  if (!email) return undefined;
  const localPart = email.split('@')[0];
  return localPart
    .split(/[._-]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

async function createGmailClient(secrets: GmailSecrets) {
  const clientId = secrets.CLIENT_ID;
  const clientSecret = secrets.CLIENT_SECRET;
  const redirectUrisRaw = secrets.REDIRECT_URIS;

  if (!clientId || !clientSecret || !redirectUrisRaw) {
    throw new Error(
      'Gmail OAuth credentials not configured. Missing CLIENT_ID, CLIENT_SECRET, or REDIRECT_URIS.',
    );
  }

  let redirectUri: string;
  try {
    const uris = JSON.parse(redirectUrisRaw);
    redirectUri = Array.isArray(uris) ? uris[0] : redirectUrisRaw;
  } catch {
    redirectUri = redirectUrisRaw;
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  // El backend es el único dueño del refresh_token y sirve siempre un
  // access_token fresco (refresh lazy en /secrets/user, rotation-safe — TER-388).
  // El watcher NO refresca por su cuenta: pasamos solo el access_token para que
  // googleapis no auto-refresque (evita el doble dueño que invalidaba el
  // refresh_token de Google al rotar). Cada poll trae un token fresco vía getSecrets.
  const accessToken = secrets.ACCESS_TOKEN;
  if (!accessToken) {
    throw new Error('Gmail account not connected. Please connect your Google account.');
  }

  oauth2Client.setCredentials({ access_token: accessToken });

  return {
    gmail: google.gmail({ version: 'v1', auth: oauth2Client }),
    email: secrets.EMAIL || 'unknown@gmail.com',
    displayName: getDisplayName(secrets.EMAIL),
  };
}

async function getSecrets(backendClient: McaBackendClient): Promise<GmailSecrets> {
  const systemSecrets = await backendClient.getSystemSecrets();
  const userSecrets = await backendClient.getUserSecrets();
  return { ...systemSecrets, ...userSecrets } as GmailSecrets;
}

// =============================================================================
// PUBLIC API
// =============================================================================

export async function startEmailWatcher(
  backendClient: McaBackendClient,
  intervalMinutes: number = 5,
): Promise<{ started: boolean; intervalMs: number; message?: string }> {
  if (state.isActive) {
    return {
      started: false,
      intervalMs: state.intervalMs,
      message: 'Watcher is already active. Stop it first to change interval.',
    };
  }

  const intervalMs = Math.max(intervalMinutes * 60 * 1000, 60 * 1000); // min 1 minute

  state.backendClient = backendClient;
  state.intervalMs = intervalMs;

  // Perform initial check immediately (with time window to avoid old emails)
  try {
    await performCheck(/* isInitial= */ true);
  } catch (error: any) {
    console.error('[EmailWatcher] Initial check failed:', error.message);
    // Don't fail startup — the interval will retry
  }

  state.intervalId = setInterval(() => {
    performCheck(/* isInitial= */ false).catch((err) => {
      // Un 401 de callback token (CALLBACK_TOKEN_INVALID) es fatal: el token del
      // contenedor ya no vale para el backend y no se recupera sin respawn.
      // Seguir poleando solo martillea el endpoint con 401 → paramos limpiamente
      // (el contenedor será reemplazado y el watcher re-arrancará fresh) (TER-389).
      if (err?.code === 'CALLBACK_TOKEN_INVALID' || err?.statusCode === 401) {
        console.error(
          '[EmailWatcher] Callback token inválido (401) — deteniendo watcher. El contenedor será reemplazado.',
        );
        stopEmailWatcher();
        return;
      }
      console.error('[EmailWatcher] Polling error:', err.message || err);
    });
  }, intervalMs);

  state.isActive = true;

  console.error(
    `[EmailWatcher] Started polling every ${intervalMs / 1000}s (${intervalMinutes} min)`,
  );

  return { started: true, intervalMs };
}

export function stopEmailWatcher(): { stopped: boolean; message?: string } {
  if (!state.isActive || !state.intervalId) {
    return { stopped: false, message: 'Watcher is not active.' };
  }

  clearInterval(state.intervalId);
  state.intervalId = null;
  state.isActive = false;
  state.backendClient = null;

  console.error('[EmailWatcher] Stopped polling');

  return { stopped: true };
}

export function getWatcherStatus(): {
  active: boolean;
  lastCheckedAt: string | null;
  knownMessageCount: number;
  intervalMs: number;
} {
  return {
    active: state.isActive,
    lastCheckedAt: state.lastCheckedAt ? new Date(state.lastCheckedAt).toISOString() : null,
    knownMessageCount: state.knownMessageIds.size,
    intervalMs: state.intervalMs,
  };
}

// =============================================================================
// INTERNAL: POLLING LOGIC
// =============================================================================

async function performCheck(isInitial: boolean): Promise<void> {
  const backendClient = state.backendClient;
  if (!backendClient) {
    throw new Error('No backend client available');
  }

  const secrets = await getSecrets(backendClient);
  const { gmail, email } = await createGmailClient(secrets);

  // Build query: unread, optionally restricted to recent messages on first check
  let query = 'is:unread';
  if (isInitial && state.knownMessageIds.size === 0) {
    const since = new Date(Date.now() - FIRST_CHECK_HOURS_BACK * 60 * 60 * 1000);
    const sinceStr = `${since.getFullYear()}/${String(since.getMonth() + 1).padStart(2, '0')}/${String(since.getDate()).padStart(2, '0')}`;
    query += ` after:${sinceStr}`;
  }

  const res = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults: 50,
  });

  const messages = res.data.messages ?? [];
  const newMessages = messages.filter((m) => m.id && !state.knownMessageIds.has(m.id));

  if (newMessages.length > 0) {
    console.error(
      `[EmailWatcher] Found ${newMessages.length} new unread message(s) for ${email}`,
    );
  }

  for (const msg of newMessages) {
    if (!msg.id) continue;

    try {
      const detail = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date'],
      });

      const headers = detail.data.payload?.headers ?? [];
      const from = headers.find((h) => h.name === 'From')?.value ?? '';
      const subject = headers.find((h) => h.name === 'Subject')?.value ?? '';
      const date = headers.find((h) => h.name === 'Date')?.value ?? '';
      const snippet = detail.data.snippet ?? '';

      await backendClient.emitEvent({
        event: 'gmail.email.received',
        payload: {
          messageId: msg.id,
          threadId: msg.threadId,
          from,
          subject,
          snippet,
          date,
          receivedAt: new Date().toISOString(),
          accountEmail: email,
        },
      });

      console.error(
        `[EmailWatcher] Emitted gmail.email.received: ${subject} from ${from}`,
      );
    } catch (emitError: any) {
      console.error(
        `[EmailWatcher] Failed to emit event for message ${msg.id}:`,
        emitError.message,
      );
      // Continue with other messages — don't let one failure stop the batch
    }

    state.knownMessageIds.add(msg.id);
  }

  // Also register seen messages so they aren't reported later
  for (const msg of messages) {
    if (msg.id) {
      state.knownMessageIds.add(msg.id);
    }
  }

  // Prune old IDs to prevent unbounded growth
  if (state.knownMessageIds.size > MAX_KNOWN_IDS) {
    const toKeep = new Set<string>();
    for (const msg of messages.slice(0, 100)) {
      if (msg.id) toKeep.add(msg.id);
    }
    state.knownMessageIds = toKeep;
  }

  state.lastCheckedAt = Date.now();
}
