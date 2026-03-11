#!/usr/bin/env bun

/**
 * Messaging MCA v1.1.0
 *
 * Allows agents to send multimedia messages to users:
 * - Images
 * - Audio files
 * - Video files
 * - Documents/files
 * - HTML widgets
 *
 * Supports both:
 * - Public URLs (direct)
 * - Local file paths (uploaded via backend API)
 *
 * The tool results include a special __teros_message__ field that the backend
 * intercepts to send as a proper message to the user (not just tool output).
 */

import { McaServer } from '@teros/mca-sdk';
import { sendAudio, sendFile, sendHtml, sendHtmlFile, sendImage, sendVideo } from './tools';

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.teros.messaging',
  name: 'Messaging',
  version: '1.1.0',
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

// =============================================================================
// START SERVER
// =============================================================================

server.start().catch((error) => {
  console.error('[Messaging MCA] Fatal error:', error);
  process.exit(1);
});
