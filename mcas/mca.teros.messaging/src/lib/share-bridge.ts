/**
 * Share bridge — the ONLY way the share tools touch the backend.
 *
 * Every share tool call becomes a `domain_request` over the MCA WebSocket to a
 * WsRouter action (`share.create` / `share.get` / `share.revoke`), with the
 * tool's execution identity (user, agent, channel) so the backend runs the
 * handler as the turn's user and records the acting agent. The manifest's
 * `backend.actions` is the allowlist the backend enforces.
 *
 * Pattern of mca.teros.automate's lib/bridge.ts.
 */

import { createWebSocketClient, type McaWebSocketClient, type ToolContext } from '@teros/mca-sdk';

let wsClient: McaWebSocketClient | undefined;
let wsConnected = false;

export function isWsConnected(): boolean {
  return wsConnected && wsClient?.connected === true;
}

export async function initializeWsClient(): Promise<void> {
  if (!process.env.MCA_WS_URL) {
    // Degraded mode: the generator (and any non-runtime context) spawns the MCA
    // without the WS URL injected. Share tools will fail fast if called; the
    // rest of the MCA must still boot.
    console.error('⚠️ [Messaging MCA] MCA_WS_URL not set — share bridge in degraded mode');
    wsConnected = false;
    return;
  }
  wsClient = createWebSocketClient();
  wsClient.on('disconnected', (code, reason) => {
    console.error(`🔌 [Messaging MCA] Disconnected from backend: ${code} ${reason}`);
    wsConnected = false;
  });
  wsClient.on('command', (command) => {
    if (command.command === 'shutdown') {
      console.error('📴 [Messaging MCA] Shutdown command received');
      process.exit(0);
    } else if (command.command === 'health_check') {
      wsClient?.sendHealthUpdate(wsConnected ? 'ready' : 'not_ready');
    }
  });
  try {
    await wsClient.connect();
    wsConnected = true;
    wsClient.sendHealthUpdate('ready');
    console.error('🔌 [Messaging MCA] Connected to backend via WebSocket');
  } catch (error) {
    wsConnected = false;
    console.error(`⚠️ [Messaging MCA] WebSocket connection failed: ${error instanceof Error ? error.message : error}`);
  }
}

/** Invoke a backend share.* domain action as the tool's acting identity. */
export async function callShareBackend<T = unknown>(
  context: ToolContext,
  action: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const exec = context.execution;
  const actor = { userId: exec.userId, agentId: exec.agentId, channelId: exec.channelId };
  const body = { workspaceId: exec.workspaceId, ...params };

  if (!wsClient || !isWsConnected()) {
    throw new Error('[Messaging MCA] Not connected to the backend — retry in a few seconds.');
  }
  try {
    return await wsClient.domainRequest<T>(action, body, actor);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Surface the backend's message verbatim — the domain handlers craft
    // user-facing errors (MISSING_FIELDS, SHARE_NOT_FOUND, …).
    throw new Error(`share ${action} failed: ${message}`);
  }
}
