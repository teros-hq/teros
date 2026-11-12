/**
 * Backend bridge — the ONLY way this MCA touches Automate data.
 *
 * Every tool call becomes a `domain_request` over the MCA WebSocket to a
 * WsRouter action (`automate.*`, `app.list-event-topics`), with the tool's
 * execution identity (user, agent, channel) so the backend runs the handler
 * as the turn's user and records the acting agent. The manifest's
 * `backend.actions` is the allowlist the backend enforces.
 *
 * `setBridge` lets tests inject a fake transport.
 */

import { createWebSocketClient, type McaWebSocketClient, type ToolContext } from '@teros/mca-sdk';
import { AutomateError } from './errors';

export type BridgeCall = (
  action: string,
  params: Record<string, unknown>,
  actor: { userId?: string; agentId?: string; channelId?: string },
) => Promise<unknown>;

let wsClient: McaWebSocketClient | undefined;
let wsConnected = false;
let override: BridgeCall | undefined;

export function setBridge(fn: BridgeCall | undefined): void {
  override = fn;
}

export function isWsConnected(): boolean {
  return wsConnected && wsClient?.connected === true;
}

export async function initializeWsClient(): Promise<void> {
  wsClient = createWebSocketClient();
  wsClient.on('disconnected', (code, reason) => {
    console.error(`🔌 [Automate MCA] Disconnected from backend: ${code} ${reason}`);
    wsConnected = false;
  });
  wsClient.on('command', (command) => {
    if (command.command === 'shutdown') {
      console.error('📴 [Automate MCA] Shutdown command received');
      process.exit(0);
    } else if (command.command === 'health_check') {
      wsClient?.sendHealthUpdate(wsConnected ? 'ready' : 'not_ready');
    }
  });
  try {
    await wsClient.connect();
    wsConnected = true;
    wsClient.sendHealthUpdate('ready');
    console.error('🔌 [Automate MCA] Connected to backend via WebSocket');
  } catch (error) {
    wsConnected = false;
    console.error(`⚠️ [Automate MCA] WebSocket connection failed: ${error instanceof Error ? error.message : error}`);
  }
}

/** Invoke a backend domain action as the tool's acting identity. */
export async function callBackend<T = unknown>(
  context: ToolContext,
  action: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const exec = context.execution;
  const actor = { userId: exec.userId, agentId: exec.agentId, channelId: exec.channelId };
  const body = { workspaceId: exec.workspaceId, ...params };

  if (override) return (await override(action, body, actor)) as T;
  if (!wsClient || !isWsConnected()) {
    throw new AutomateError('BACKEND_UNAVAILABLE', 'Automate MCA is not connected to the backend.', 'Retry in a few seconds.');
  }
  try {
    return await wsClient.domainRequest<T>(action, body, actor);
  } catch (err) {
    const code = (err as { code?: string })?.code;
    const message = err instanceof Error ? err.message : String(err);
    if (code === 'NOT_FOUND') throw new AutomateError('NOT_FOUND', message);
    if (code === 'FORBIDDEN' || code === 'ACTION_NOT_ALLOWED') throw new AutomateError('FORBIDDEN', message);
    if (code === 'VALIDATION_ERROR' || code === 'MISSING_FIELDS') throw new AutomateError('INVALID_INPUT', message);
    throw new AutomateError('BACKEND_ERROR', message);
  }
}
