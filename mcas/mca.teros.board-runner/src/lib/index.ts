import { createWebSocketClient, type McaWebSocketClient } from '@teros/mca-sdk';

// =============================================================================
// CONFIGURATION
// =============================================================================

export const CURRENT_CHANNEL_ID = process.env.MCA_CHANNEL_ID || null;
export const SENDER_AGENT_ID = process.env.MCA_AGENT_ID || null;
export const OWNER_ID = process.env.MCA_OWNER_ID || null;
export const OWNER_TYPE = process.env.MCA_OWNER_TYPE || null;
/** Workspace ID — only set when ownerType is 'workspace' */
export const WORKSPACE_ID = OWNER_TYPE === 'workspace' ? OWNER_ID : null;

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
