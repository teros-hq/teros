/**
 * Real-time event forwarding (MCA → Backend).
 *
 * The embedded TelegramClient holds a persistent MTProto connection and
 * receives updates (new messages, edits, deletions, reads) in real time.
 * This module forwards them to the Teros backend via the MCA event system
 * (same pattern as gmail's email-watcher), so conversations and boards can
 * subscribe to topics like `telegram.message.received`.
 *
 * Event forwarding is NATIVE — it requires no tool call. `bootstrapEventForwarding`
 * runs at container boot (and after auth-sign-in): when the backend injected
 * MCA_CALLBACK_URL, events are delivered from the first minute. Without that
 * env var (local dev, older backends) the watcher still registers and buffers
 * nothing — events are counted but dropped, and every tool call re-attempts the
 * bootstrap via ensureEventForwarding(context.execution.callbackUrl).
 */
import { McaBackendClient } from '@teros/mca-sdk';
import type { TelegramClient } from 'teleproto';
import { NewMessage, EditedMessage, DeletedMessage } from 'teleproto/events';
import { serializeMessage, peerToChatId } from './client';

/** Canonical fields of `telegram.message.received|sent|edited` payloads. Keep in
 *  sync with manifest.json `events[].payload` — test/events-payload.test.ts
 *  fails when the emitted object and the declared catalog drift apart. */
export interface MessageEventPayload {
  messageId: number;
  chatId: string | null;
  chatTitle: string | null;
  chatType: 'user' | 'group' | 'supergroup' | 'channel' | null;
  chatUsername: string | null;
  fromId: string | null;
  fromName: string | null;
  fromUsername: string | null;
  text: string;
  hasMedia: boolean;
  mediaType: string | null;
  isOutgoing: boolean;
  replyToMsgId: number | null;
  mentioned: boolean;
  date: string | null;
  /** @deprecated legacy aliases kept for templates written against v1.0 ({{fromMe}}, {{id}}, {{isMention}}). */
  id: number;
  fromMe: boolean;
  isMention: boolean;
}

/** Resolves a Telegram peer (`fromId` / `peerId`) to its entity, or null. */
export type PeerResolver = (peer: unknown) => Promise<unknown | null>;

// ============================================================================
// State
// ============================================================================

interface EventWatcherState {
  backendClient: McaBackendClient | null;
  registered: boolean;
  startedAt: string | null;
  counters: {
    received: number;
    sent: number;
    edited: number;
    deleted: number;
    errors: number;
  };
}

const state: EventWatcherState = {
  backendClient: null,
  registered: false,
  startedAt: null,
  counters: { received: 0, sent: 0, edited: 0, deleted: 0, errors: 0 },
};

/** Topics emitted by this MCA. Conversations/boards subscribe to these. */
export const TELEGRAM_EVENT_TOPICS = [
  'telegram.message.received',
  'telegram.message.sent',
  'telegram.message.edited',
  'telegram.message.deleted',
] as const;

/**
 * Incoming and outgoing messages are different things to automate on ("someone
 * wrote to me" vs "I wrote to someone"), so they get their own topics instead
 * of one topic plus a flag the subscriber has to remember to filter on.
 */
export function messageTopic(msg: unknown): 'telegram.message.received' | 'telegram.message.sent' {
  return (msg as { out?: boolean }).out ? 'telegram.message.sent' : 'telegram.message.received';
}

function entityDisplayName(entity: unknown): string | null {
  const e = entity as { title?: string; firstName?: string; lastName?: string; username?: string } | null;
  if (!e) return null;
  if (e.title) return e.title;
  const full = [e.firstName, e.lastName].filter(Boolean).join(' ').trim();
  return full || e.username || null;
}

function entityChatType(entity: unknown): MessageEventPayload['chatType'] {
  const e = entity as { className?: string; broadcast?: boolean; megagroup?: boolean } | null;
  if (!e) return null;
  if (e.className === 'User') return 'user';
  if (e.broadcast) return 'channel';
  if (e.megagroup) return 'supergroup';
  return 'group';
}

/**
 * Build the catalog-shaped payload of a message event. Sender and chat are
 * resolved through `resolve` (a GramJS entity lookup in production, a stub in
 * tests); a failed lookup degrades to null fields, never to a dropped event.
 */
export async function buildMessageEventPayload(msg: unknown, resolve: PeerResolver): Promise<MessageEventPayload> {
  const m = msg as { fromId?: unknown; peerId?: unknown; mentioned?: boolean };
  const base = serializeMessage(msg);
  const safeResolve = async (peer: unknown) => {
    if (peer == null) return null;
    try {
      return await resolve(peer);
    } catch {
      return null;
    }
  };
  const [sender, chat] = await Promise.all([safeResolve(m.fromId), safeResolve(m.peerId)]);
  // In private chats Telegram omits fromId for incoming messages: the peer IS the sender.
  const senderEntity = sender ?? (entityChatType(chat) === 'user' && !base.fromMe ? chat : null);
  const mentioned = m.mentioned === true;
  return {
    messageId: base.id,
    chatId: base.chatId,
    chatTitle: entityDisplayName(chat),
    chatType: entityChatType(chat),
    chatUsername: ((chat as { username?: string } | null)?.username ?? null) || null,
    fromId: base.fromId ?? (senderEntity ? base.chatId : null),
    fromName: entityDisplayName(senderEntity),
    fromUsername: ((senderEntity as { username?: string } | null)?.username ?? null) || null,
    text: base.text,
    hasMedia: base.hasMedia,
    mediaType: base.mediaType,
    isOutgoing: base.fromMe,
    replyToMsgId: base.replyToMsgId,
    mentioned,
    date: base.date,
    id: base.id,
    fromMe: base.fromMe,
    isMention: mentioned,
  };
}

export function getEventStatus() {
  return {
    active: state.registered && state.backendClient != null,
    registered: state.registered,
    hasBackendClient: state.backendClient != null,
    startedAt: state.startedAt,
    topics: [...TELEGRAM_EVENT_TOPICS],
    counters: { ...state.counters },
  };
}

// ============================================================================
// Emission
// ============================================================================

async function emit(event: string, payload: Record<string, unknown>): Promise<void> {
  if (!state.backendClient) {
    console.error(`[mca.telegram] Event dropped (no backend client): ${event}`);
    return;
  }
  try {
    await state.backendClient.emitEvent({ event, payload });
  } catch (err) {
    state.counters.errors += 1;
    console.error(`[mca.telegram] Failed to emit ${event}:`, (err as Error).message);
  }
}

// ============================================================================
// Handler registration (idempotent — one handler set per client lifetime)
// ============================================================================

export async function startEventWatcher(client: TelegramClient): Promise<void> {
  if (state.registered) return;
  state.registered = true;
  state.startedAt = new Date().toISOString();

  const resolvePeer: PeerResolver = (peer) => client.getEntity(peer as Parameters<TelegramClient['getEntity']>[0]);

  // ── New messages: incoming → .received, our own sends → .sent ──
  client.addEventHandler(async (event) => {
    try {
      const msg = event.message;
      if (!msg) return;
      const topic = messageTopic(msg);
      if (topic === 'telegram.message.sent') state.counters.sent += 1;
      else state.counters.received += 1;
      await emit(topic, { ...(await buildMessageEventPayload(msg, resolvePeer)) });
    } catch (err) {
      state.counters.errors += 1;
      console.error('[mca.telegram] NewMessage handler error:', (err as Error).message);
    }
  }, new NewMessage({}));

  // ── Edited messages ──
  client.addEventHandler(async (event) => {
    try {
      const msg = event.message;
      if (!msg) return;
      state.counters.edited += 1;
      await emit('telegram.message.edited', {
        ...(await buildMessageEventPayload(msg, resolvePeer)),
        editedAt: new Date().toISOString(),
      });
    } catch (err) {
      state.counters.errors += 1;
      console.error('[mca.telegram] EditedMessage handler error:', (err as Error).message);
    }
  }, new EditedMessage({}));

  // ── Deleted messages ──
  client.addEventHandler(async (event) => {
    try {
      const deletedIds = (event as unknown as { deletedIds?: number[] }).deletedIds ?? [];
      if (!deletedIds.length) return;
      state.counters.deleted += 1;
      await emit('telegram.message.deleted', {
        chatId: peerToChatId((event as unknown as { peer?: unknown }).peer),
        messageIds: deletedIds,
        deletedAt: new Date().toISOString(),
      });
    } catch (err) {
      state.counters.errors += 1;
      console.error('[mca.telegram] DeletedMessage handler error:', (err as Error).message);
    }
  }, new DeletedMessage({}));

  console.error('[mca.telegram] Event watcher registered (new/edited/deleted messages)');
}

export function stopEventWatcher(): void {
  // GramJS offers no per-handler removal API; unregistering the backend client
  // stops delivery while keeping handlers harmless (they emit to null).
  state.backendClient = null;
  state.startedAt = null;
}

// ============================================================================
// Bootstrap (native auto-start — no tool call required)
// ============================================================================

/**
 * Activate event forwarding if the backend callback is known and the account
 * is linked. Safe to call multiple times (idempotent) and safe to call when
 * the account is not linked yet (no-op — auth-sign-in retries after linking).
 *
 * Called at container boot with the injected MCA_CALLBACK_URL, and from tool
 * calls with the per-execution callbackUrl (covers containers spawned before
 * the backend started injecting the env var).
 */
export async function bootstrapEventForwarding(callbackUrl?: string | null): Promise<void> {
  const url = callbackUrl || process.env.MCA_CALLBACK_URL || null;
  if (!url) {
    // No backend callback known (e.g. local dev without the env var). The
    // watcher handlers may still be registered; delivery stays off.
    console.error('[mca.telegram] Event forwarding unavailable: no MCA_CALLBACK_URL (events will not be delivered)');
    return;
  }
  if (!state.backendClient) {
    registerBackendClient(
      new McaBackendClient({
        callbackUrl: url,
        appId: process.env.MCA_APP_ID,
        mcaId: 'mca.telegram',
        callbackToken: process.env.MCA_CALLBACK_TOKEN,
      }),
    );
  }
  try {
    const { isAuthorized, getClient } = await import('./client');
    if (!(await isAuthorized())) {
      // Account not linked yet — auth-sign-in will call this again on success.
      return;
    }
    const client = await getClient();
    await startEventWatcher(client);
    console.error('[mca.telegram] Real-time event forwarding active (topics: ' + TELEGRAM_EVENT_TOPICS.join(', ') + ')');
  } catch (err) {
    console.error('[mca.telegram] Event forwarding bootstrap failed:', (err as Error).message);
  }
}

/**
 * Tool-call variant: tries the per-execution callbackUrl first (it is the
 * proven-reachable URL for this container) and falls back to the boot env.
 * Cheap no-op once forwarding is active.
 */
export async function ensureEventForwarding(executionCallbackUrl?: string | null): Promise<void> {
  if (state.registered && state.backendClient) return;
  await bootstrapEventForwarding(executionCallbackUrl || process.env.MCA_CALLBACK_URL || null);
}

function registerBackendClient(backendClient: McaBackendClient): void {
  state.backendClient = backendClient;
}
