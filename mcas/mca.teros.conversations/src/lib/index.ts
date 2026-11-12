import { createWebSocketClient, type McaWebSocketClient } from '@teros/mca-sdk';

// =============================================================================
// CONFIGURATION
// =============================================================================

export const CURRENT_CHANNEL_ID = process.env.MCA_CHANNEL_ID || null;

// =============================================================================
// WEBSOCKET CLIENT SINGLETON
// =============================================================================

let wsClient: McaWebSocketClient;
let wsConnected = false;

export function getWsClient(): McaWebSocketClient {
  return wsClient;
}

export function isWsConnected(): boolean {
  return wsConnected && wsClient?.connected === true;
}

export async function initializeWsClient(): Promise<void> {
  if (!process.env.MCA_WS_URL) {
    // Degraded mode (pattern of mca.teros.core provider-bridge): the tools.json
    // generator spawns the MCA without the WS URL injected. Tools that need the
    // backend fail fast if called; the rest of the MCA must still boot so
    // listTools() works.
    console.error('⚠️ [Conversations MCA] MCA_WS_URL not set — running in degraded mode');
    wsConnected = false;
    return;
  }
  wsClient = createWebSocketClient();

  wsClient.on('disconnected', (code, reason) => {
    console.error(`🔌 Disconnected from backend: ${code} ${reason}`);
    wsConnected = false;
  });

  wsClient.on('command', (command) => {
    if (command.command === 'shutdown') {
      console.error('📴 Shutdown command received');
      process.exit(0);
    } else if (command.command === 'health_check') {
      const status = wsConnected ? 'ready' : 'not_ready';
      wsClient.sendHealthUpdate(status);
    }
  });

  try {
    await wsClient.connect();
    wsConnected = true;
    console.error('🔌 Connected to backend via WebSocket');
    wsClient.sendHealthUpdate('ready');
  } catch (error: any) {
    console.error(`⚠️ WebSocket connection failed: ${error.message}`);
    wsConnected = false;
  }
}

export function disconnectWsClient(): void {
  wsClient.disconnect();
}

// =============================================================================
// TYPES
// =============================================================================

export interface SearchMessagesResult {
  results: Array<{
    channelId: string;
    channelName: string;
    agentId: string;
    agentName: string;
    matches: Array<{
      messageId: string;
      snippet: string;
      timestamp: string;
      role: 'user' | 'assistant' | 'system';
    }>;
  }>;
  totalMatches: number;
}

export interface ListChannelsResult {
  channels: Array<{
    channelId: string;
    name: string;
    agentId: string;
    status: string;
    createdAt: string;
    updatedAt: string;
    lastMessage?: {
      content: string;
      timestamp: string;
      role: string;
    };
  }>;
  total: number;
}

export interface GetChannelMessagesResult {
  channel: {
    channelId: string;
    name: string;
    agentId: string;
    status: string;
    createdAt: string;
  };
  messages: Array<{
    messageId: string;
    role: string;
    content: any;
    timestamp: string;
  }>;
  hasMore: boolean;
}

export interface GetChannelSummaryResult {
  channelId: string;
  name: string;
  agentId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  firstMessage: {
    content: string;
    timestamp: string;
    role: string;
  } | null;
  lastMessage: {
    content: string;
    timestamp: string;
    role: string;
  } | null;
}

export interface CreateChannelResult {
  channelId: string;
  agentId: string;
  name: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface SendMessageResult {
  success: boolean;
  messageId: string;
  channelId: string;
  timestamp: string;
}

export interface RenameChannelResult {
  success: boolean;
  channelId: string;
  name: string;
}

export interface ImportAttachmentResult {
  success: boolean;
  /** Original filename of the imported attachment */
  filename: string;
  /** Path of the copied file relative to the workspace volume root */
  workspacePath: string;
  /** File size in bytes, or null if unknown */
  size: number | null;
  /** MIME type, or null if unknown */
  mime: string | null;
}
