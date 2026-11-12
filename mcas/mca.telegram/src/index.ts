/**
 * mca.telegram — Telegram via MTProto (teleproto)
 *
 * The MCA server embeds a TelegramClient directly (no external gateway).
 * Tools are exposed on port 3000; the MTProto session persists in /app-data.
 *
 * Real-time event forwarding (telegram.message.received/edited/deleted) is
 * NATIVE: it auto-starts at boot when the account is linked — no tool call
 * needed. See src/lib/events.ts (bootstrapEventForwarding).
 */
import { McaServer } from '@teros/mca-sdk';
import { isAuthorized } from './lib/client';
import { bootstrapEventForwarding, getEventStatus } from './lib/events';
import {
  authStatus,
  authSendCode,
  authSignIn,
  authDisconnect,
  listChats,
  getChatHistory,
  searchMessages,
  sendMessage,
  sendMedia,
  downloadMedia,
  editMessage,
  deleteMessages,
  createGroup,
  manageMembers,
  markAsRead,
} from './tools';

const server = new McaServer({
  id: 'mca.telegram',
  name: 'Telegram',
  version: '1.1.0',
});

// ── Health check: MTProto connectivity + auth state ──────────────────────────
// Event-forwarding state is INFORMATIONAL: it never degrades readiness. A
// linked account without forwarding (e.g. backend without MCA_CALLBACK_URL
// injection) is still a healthy, fully usable MCA.
server.setHealthCheck(async () => {
  try {
    const connected = await isAuthorized();
    if (!connected) {
      return {
        status: 'not_ready' as const,
        message: 'Telegram account not linked. Run auth-send-code + auth-sign-in to connect.',
      };
    }
    const events = getEventStatus();
    return {
      status: 'ready' as const,
      message: events.active
        ? 'Linked; real-time event forwarding active'
        : 'Linked; event forwarding inactive (informational — events require MCA_CALLBACK_URL from the backend)',
    };
  } catch (err) {
    const msg = (err as Error).message || 'unknown error';
    if (msg.includes('TELEGRAM_API_ID')) {
      return { status: 'not_ready' as const, message: msg };
    }
    return { status: 'degraded' as const, message: `MTProto connection issue: ${msg}` };
  }
});

// ── Register tools ─────────────────────────────────────────────────────────
server.tool('health-check', {
  annotations: { readOnlyHint: true },
  description: 'Internal health check. Verifies MTProto connectivity and reports link status.',
  parameters: { type: 'object', properties: {} },
  handler: async () => {
    try {
      const connected = await isAuthorized();
      return {
        success: true,
        connected,
        events: getEventStatus(),
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },
});
server.tool('auth-status', authStatus);
server.tool('auth-send-code', authSendCode);
server.tool('auth-sign-in', authSignIn);
server.tool('auth-disconnect', authDisconnect);
server.tool('list-chats', listChats);
server.tool('get-chat-history', getChatHistory);
server.tool('search-messages', searchMessages);
server.tool('send-message', sendMessage);
server.tool('send-media', sendMedia);
server.tool('download-media', downloadMedia);
server.tool('edit-message', editMessage);
server.tool('delete-messages', deleteMessages);
server.tool('create-group', createGroup);
server.tool('manage-members', manageMembers);
server.tool('mark-as-read', markAsRead);

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────

server
  .start()
  .then(async () => {
    console.error('[mca.telegram] MCA server started (MTProto embedded)');
    // Native event forwarding: no tool call required. When the backend injected
    // MCA_CALLBACK_URL and the account is linked, telegram.message.* events flow
    // from the first minute. If the account is not linked yet, auth-sign-in
    // triggers the bootstrap on success.
    await bootstrapEventForwarding();
  })
  .catch((error) => {
    console.error('[mca.telegram] Failed to start MCA server:', error);
    process.exit(1);
  });
