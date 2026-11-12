#!/usr/bin/env bun

/**
 * Messaging MCA v1.3.0
 *
 * Allows agents to send messages to users:
 * - Images
 * - Audio files
 * - Video files
 * - Documents/files
 * - HTML widgets (in-chat)
 * - Notification emails (via Resend, to the user's account email)
 * - Public share links for workspace files (share-file / unshare-file / get-share)
 *
 * Supports both:
 * - Public URLs (direct)
 * - Local file paths (uploaded via backend API)
 *
 * The tool results include a special __teros_message__ field that the backend
 * intercepts to send as a proper message to the user (not just tool output).
 *
 * The share tools are `domain_request`s over the MCA WebSocket to the backend's
 * `share.*` handlers (same ones the FileViewer UI uses) with the tool's acting
 * identity — see lib/share-bridge.ts.
 */

import { McaServer } from '@teros/mca-sdk';
import { initializeWsClient } from './lib';
import {
  getShare,
  notifyByEmail,
  sendAudio,
  sendFile,
  sendHtml,
  sendHtmlFile,
  sendImage,
  sendVideo,
  shareFile,
  unshareFile,
} from './tools';

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.teros.messaging',
  name: 'Messaging',
  version: '1.3.0',
});

// =============================================================================
// REGISTER TOOLS
// =============================================================================

server.tool('send-image', sendImage);
server.tool('send-audio', sendAudio);
server.tool('send-video', sendVideo);
server.tool('send-file', sendFile);
server.tool('send-html', sendHtml);
server.tool('send-html-file', sendHtmlFile);
server.tool('notify-by-email', notifyByEmail);

// Public share links (backend share.* domain over WS)
server.tool('share-file', shareFile);
server.tool('unshare-file', unshareFile);
server.tool('get-share', getShare);

// =============================================================================
// START SERVER
// =============================================================================

async function main(): Promise<void> {
  await initializeWsClient();
  await server.start();
  console.error('Messaging MCA running (media + share tools; shares over the backend share.* API)');
}

main().catch((error) => {
  console.error('[Messaging MCA] Fatal error:', error);
  process.exit(1);
});
