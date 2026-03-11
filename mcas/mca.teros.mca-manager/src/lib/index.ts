import { createWebSocketClient, type McaWebSocketClient } from '@teros/mca-sdk';

// =============================================================================
// WEBSOCKET CLIENT SINGLETON
// =============================================================================

let wsClient: McaWebSocketClient;
let wsConnected = false;

export function getWsClient(): McaWebSocketClient {
  return wsClient;
}

export function isWsConnected(): boolean {
  return wsConnected;
}

export async function initializeWsClient(): Promise<void> {
  wsClient = createWebSocketClient();

  wsClient.on('disconnected', (code, reason) => {
    wsConnected = false;
    console.error(`🔌 Disconnected from backend: ${code} ${reason}`);
  });

  wsClient.on('command', (command) => {
    if (command.command === 'shutdown') {
      console.error('📴 Shutdown command received');
      process.exit(0);
    } else if (command.command === 'health_check') {
      wsClient.sendHealthUpdate(wsConnected ? 'ready' : 'not_ready');
    }
  });

  try {
    await wsClient.connect();
    wsConnected = true;
    console.error('🔌 Connected to backend via WebSocket');
    wsClient.sendHealthUpdate('ready');
  } catch (error: any) {
    console.error(`⚠️ WebSocket connection failed: ${error.message}`);
    wsClient.sendHealthUpdate('not_ready');
  }
}

export function disconnectWsClient(): void {
  wsClient?.disconnect();
}

// =============================================================================
// ADMIN API VIA WEBSOCKET
// =============================================================================

/**
 * Make an admin API request via WebSocket (replaces HTTP fetch to /admin/*)
 */
export async function adminRequest<T = unknown>(
  action: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  if (!wsClient || !wsConnected) {
    throw new Error('Not connected to backend WebSocket');
  }
  return wsClient.adminRequest<T>(action, params);
}
