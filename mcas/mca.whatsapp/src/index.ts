/**
 * mca.whatsapp — WhatsApp via WAHA (WhatsApp HTTP API)
 *
 * WAHA corre en localhost:${WAHA_PORT} dentro del mismo contenedor.
 * El MCA server expone las tools en el puerto 3000.
 *
 * Flujo de arranque:
 *   1. supervisord arranca WAHA en puerto 3001
 *   2. entrypoint.sh espera a WAHA y luego arranca este proceso (tsx src/index.ts)
 *   3. Este servidor expone las tools al backend de Teros en puerto 3000
 *   4. Al arrancar, se auto-inicializa la sesión "default" con config GOWS si no existe
 */
import { McaServer } from '@teros/mca-sdk';
import { WAHA_PORT, WAHA_BASE, ensureDefaultSession } from './lib';
import {
  healthCheck,
  sessionStatus,
  startSession,
  stopSession,
  requestPairingCode,
  sendText,
  sendImage,
  sendDocument,
  getMessages,
  getChats,
  getContacts,
  checkNumber,
  getLabels,
  getChatLabels,
  putChatLabels,
  searchChats,
  downloadMedia,
  reaction,
  readMessages,
  markUnread,
  getProfile,
  setProfileName,
  setProfileStatus,
  setProfilePicture,
  deleteProfilePicture,
  getContactProfilePicture,
  searchContacts,
  getUnreadChats,
} from './tools';

const server = new McaServer({
  id: 'mca.whatsapp',
  name: 'WhatsApp',
  version: '1.0.0',
});

// @todo pablo - 2026.06.19 : migrate WAHA_API_KEY from hardcoded manifest value
// (mca.whatsapp/manifest.json runtime.systemEnvironment) to a proper system secret
// resolved via SECRET_MCA_WAHA_API_KEY once systemEnvironment interpolation is
// confirmed to work for containerized MCAs. The current key is hardcoded and
// cannot be rotated per deployment.

// ── Health check: verifica que WAHA esté vivo ──────────────────────────────
// Use /ping which doesn't require auth (WAHA generates random credentials when
// WAHA_API_KEY is empty, so /api/health always returns 401 in that case)
server.setHealthCheck(async () => {
  try {
    const pingUrl = `http://localhost:${WAHA_PORT}/ping`;
    const res = await fetch(pingUrl, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) {
      return { status: 'degraded', message: `WAHA /ping returned HTTP ${res.status}` };
    }
    return { status: 'ready' };
  } catch (err: any) {
    return { status: 'not_ready', message: `WAHA unreachable: ${err.message}` };
  }
});

// ── Register tools ─────────────────────────────────────────────────────────
server.tool('health-check', healthCheck);
server.tool('session-status', sessionStatus);
server.tool('start-session', startSession);
server.tool('stop-session', stopSession);
// Auth is ALWAYS done via pairing code (request-pairing-code + phone number).
// QR-based auth is not supported in Teros.
server.tool('request-pairing-code', requestPairingCode);
server.tool('send-text', sendText);
server.tool('send-image', sendImage);
server.tool('send-document', sendDocument);
server.tool('get-messages', getMessages);
server.tool('get-chats', getChats);
server.tool('get-contacts', getContacts);
server.tool('check-number', checkNumber);
server.tool('get-labels', getLabels);
server.tool('get-chat-labels', getChatLabels);
server.tool('put-chat-labels', putChatLabels);
server.tool('search-chats', searchChats);
server.tool('download-media', downloadMedia);
server.tool('reaction', reaction);
server.tool('read-messages', readMessages);
server.tool('mark-unread', markUnread);
server.tool('get-profile', getProfile);
server.tool('set-profile-name', setProfileName);
server.tool('set-profile-status', setProfileStatus);
server.tool('set-profile-picture', setProfilePicture);
server.tool('delete-profile-picture', deleteProfilePicture);
server.tool('get-contact-profile-picture', getContactProfilePicture);
server.tool('search-contacts', searchContacts);
server.tool('get-unread-chats', getUnreadChats);

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────

server
  .start()
  .then(async () => {
    console.error(`[mca.whatsapp] MCA server started. WAHA at ${WAHA_BASE}`);
    // Auto-initialize the default session after the MCA server is up.
    // This is non-blocking — errors are logged but do not crash the server.
    await ensureDefaultSession();
  })
  .catch((error) => {
    console.error('[mca.whatsapp] Failed to start MCA server:', error);
    process.exit(1);
  });
