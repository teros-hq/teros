/**
 * Provider bridge — the ONLY way the provider tools touch the backend.
 *
 * Every provider tool call becomes a `domain_request` over the MCA WebSocket
 * to a WsRouter action (`provider.list` / `provider.update`), with the tool's
 * execution identity (user, agent, channel) so the backend runs the handler
 * as the turn's user and records the acting agent. The manifest's
 * `backend.actions` is the allowlist the backend enforces.
 *
 * Pattern of mca.teros.messaging's lib/share-bridge.ts.
 */

import { createWebSocketClient, type McaWebSocketClient, type ToolContext } from '@teros/mca-sdk';

let wsClient: McaWebSocketClient | undefined;
let wsConnected = false;

export function isWsConnected(): boolean {
  return wsConnected && wsClient?.connected === true;
}

export async function initializeWsClient(): Promise<void> {
  if (!process.env.MCA_WS_URL) {
    // Degraded mode: the tools.json generator (and any non-runtime context)
    // spawns the MCA without the WS URL injected. Provider tools will fail
    // fast if called; the rest of the MCA must still boot.
    console.error('⚠️ [Teros Core MCA] MCA_WS_URL not set — provider bridge in degraded mode');
    wsConnected = false;
    return;
  }
  wsClient = createWebSocketClient();
  wsClient.on('disconnected', (code, reason) => {
    console.error(`🔌 [Teros Core MCA] Disconnected from backend: ${code} ${reason}`);
    wsConnected = false;
  });
  wsClient.on('command', (command) => {
    if (command.command === 'shutdown') {
      console.error('📴 [Teros Core MCA] Shutdown command received');
      process.exit(0);
    } else if (command.command === 'health_check') {
      wsClient?.sendHealthUpdate(wsConnected ? 'ready' : 'not_ready');
    }
  });
  try {
    await wsClient.connect();
    wsConnected = true;
    wsClient.sendHealthUpdate('ready');
    console.error('🔌 [Teros Core MCA] Connected to backend via WebSocket');
  } catch (error) {
    wsConnected = false;
    console.error(
      `⚠️ [Teros Core MCA] WebSocket connection failed: ${error instanceof Error ? error.message : error}`,
    );
  }
}

/**
 * Invoke a backend provider.* domain action as the tool's acting identity.
 * The backend surfaces handler errors verbatim (MISSING_PROVIDER_ID,
 * PROVIDER_NOT_FOUND, …) — rethrown as-is so callers can map on them.
 */
export async function callProviderBackend<T = unknown>(
  context: ToolContext,
  action: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const exec = context.execution;
  const actor = { userId: exec.userId, agentId: exec.agentId, channelId: exec.channelId };

  if (!wsClient || !isWsConnected()) {
    throw new Error('[Teros Core MCA] Not connected to the backend — retry in a few seconds.');
  }
  try {
    return await wsClient.domainRequest<T>(action, params, actor);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Surface the backend's message verbatim — the domain handlers craft
    // user-facing errors (PROVIDER_NOT_FOUND, …).
    throw new Error(`provider ${action} failed: ${message}`);
  }
}
