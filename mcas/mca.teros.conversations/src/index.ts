#!/usr/bin/env bun

/**
 * Teros Conversations MCA v1.0
 *
 * Provides access to past conversations and messages from the database.
 * Uses WebSocket communication with backend for queries.
 *
 * Tools:
 * - search-messages: Search text across all conversations
 * - list-channels: List past conversations
 * - get-channel-messages: Get messages from a specific channel
 * - get-channel-summary: Get a quick summary of a conversation
 * - create-conversation: Create a new conversation with an agent
 * - send-message: Send a message to an existing conversation
 * - rename-channel: Rename a conversation
 */

import { HealthCheckBuilder, McaServer } from '@teros/mca-sdk';
import { CURRENT_CHANNEL_ID, disconnectWsClient, initializeWsClient, isWsConnected } from './lib';
import {
  createConversation,
  getChannelMessages,
  getChannelSummary,
  listChannels,
  renameChannel,
  searchMessages,
  sendMessage,
} from './tools';

// =============================================================================
// CONFIGURATION
// =============================================================================

const MCA_APP_ID = process.env.MCA_APP_ID || 'unknown';
const MCA_APP_NAME = process.env.MCA_APP_NAME || 'conversations';

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.teros.conversations',
  name: 'Conversations',
  version: '1.0.0',
});

// =============================================================================
// HEALTH CHECK
// =============================================================================

server.tool('-health-check', {
  description: 'Internal health check tool. Verifies WebSocket connectivity to backend.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    const builder = new HealthCheckBuilder().setVersion('1.0.0');

    if (!isWsConnected()) {
      builder.addIssue('DEPENDENCY_UNAVAILABLE', 'Not connected to backend WebSocket', {
        type: 'auto_retry',
        description: 'WebSocket connection will be established automatically',
      });
    }

    return builder.build();
  },
});

// =============================================================================
// REGISTER TOOLS
// =============================================================================

server.tool('search-messages', searchMessages);
server.tool('list-channels', listChannels);
server.tool('get-channel-messages', getChannelMessages);
server.tool('get-channel-summary', getChannelSummary);
server.tool('create-conversation', createConversation);
server.tool('send-message', sendMessage);
server.tool('rename-channel', renameChannel);

// =============================================================================
// START SERVER
// =============================================================================

async function main() {
  console.error(`🗂️ Teros Conversations MCA starting (appId: ${MCA_APP_ID}, name: ${MCA_APP_NAME})`);

  if (CURRENT_CHANNEL_ID) {
    console.error(`📍 Current channel: ${CURRENT_CHANNEL_ID} (will be excluded from results)`);
  }

  // Initialize WebSocket connection
  await initializeWsClient();

  // Start the MCA server
  await server.start();
  console.error('🔗 Teros Conversations MCA running');
}

main().catch((error) => {
  console.error('[Conversations MCA] Fatal error:', error);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.error('👋 Shutting down Teros Conversations MCA...');
  disconnectWsClient();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.error('👋 Shutting down Teros Conversations MCA...');
  disconnectWsClient();
  process.exit(0);
});
