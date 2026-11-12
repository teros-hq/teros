/**
 * mca.teros.ui — backend bridge
 *
 * The UI tools are a thin wrapper over the backend's ui.* domain
 * (UiStateManager + the ui.* WsRouter actions in
 * packages/backend/src/handlers/domains/ui). The backend does not expose ui.*
 * actions over the MCA HTTP callback — the supported path for an MCA is the
 * admin_request bridge on the persistent WebSocket connection
 * (McaConnectionManager.handleAdminRequest → WsRouter.dispatch, with the app
 * owner's userId resolved for authz — the same pattern as
 * mca.teros.terminal). The SDK's McaWebSocketClient.adminRequest() implements
 * the client side of that bridge.
 *
 * The bridge context carries no `actor`, so every call must pass an explicit
 * `workspaceId` (the ui domain resolves the workspace from it and checks the
 * app owner's WRITE access — a screen can show sensitive content, terminal-
 * domain precedent D6).
 *
 * `setBackendActionOverride` is a seam for unit tests: it replaces the WS
 * transport with a fake so tool handlers can be exercised without a backend.
 */

import { createWebSocketClient, type McaWebSocketClient } from "@teros/mca-sdk"

/** Fake transport for unit tests: receives (action, params), returns the result. */
export type BackendActionOverride = (
  action: string,
  params: Record<string, unknown>,
) => Promise<unknown>

let wsClient: McaWebSocketClient | undefined
let wsConnected = false
let connecting: Promise<void> | undefined
let override: BackendActionOverride | undefined

/** Unit-test seam: inject a fake backendAction transport (undefined = real one). */
export function setBackendActionOverride(fn: BackendActionOverride | undefined): void {
  override = fn
}

export function isWsConnected(): boolean {
  return wsConnected
}

export function hasWsClient(): boolean {
  return wsClient !== undefined
}

/**
 * Create the WS client lazily — never at import time, so tools/list (e.g.
 * scripts/generate-mca-tools.ts, which runs without MCA_WS_URL) keeps working.
 * Throws when MCA_WS_URL is missing.
 */
export function getWsClient(): McaWebSocketClient {
  if (!wsClient) {
    wsClient = createWebSocketClient()
    wsClient.on("connected", () => {
      wsConnected = true
    })
    wsClient.on("disconnected", () => {
      wsConnected = false
    })
  }
  return wsClient
}

/** Connect (idempotent, concurrent-safe). adminRequest also tolerates a cold-start race. */
export async function connectWsClient(): Promise<void> {
  const client = getWsClient()
  if (wsConnected) return
  if (!connecting) {
    connecting = client
      .connect()
      .then(() => {
        wsConnected = true
      })
      .finally(() => {
        connecting = undefined
      })
  }
  await connecting
}

/**
 * Call a backend WsRouter action via the admin_request bridge.
 * Handler errors arrive as Error with `.code` set to the HandlerError code
 * (e.g. FORBIDDEN_WORKSPACE_ROLE, UI_UNKNOWN_DEVICE, UI_RATE_LIMITED).
 */
export async function backendAction<T = unknown>(
  action: string,
  params: Record<string, unknown> = {},
  timeoutMs = 30_000,
): Promise<T> {
  if (override) return (await override(action, params)) as T
  await connectWsClient()
  return getWsClient().adminRequest<T>(action, params, timeoutMs)
}
