/**
 * browserStream — the Browser window's side of a visible tab of the Browser
 * MCA (spec docs/specs/20261104_browser-mca-visible.md, BRW-REQ-8), on top of
 * the generic MCA stream client (MCS-REQ-9).
 *
 *   1. find the workspace's Browser app (the Browser MCA installed there),
 *   2. ask it for the tab + stream: `browser-view { tabId, url, width, height }`,
 *   3. take a `stream.ticket` and attach to the returned streamId,
 *   4. frames → canvas, state → toolbar, the person's events → `in` inputs.
 */

import { StreamConnection, type StreamHandlers } from "../../services/streams/streamClient"
import type { TicketResponse } from "../../services/streams/streamProtocol"
import { getTerosClient } from "../../services/terosClientSingleton"
import type { CloudTabState } from "./cloudBrowserProtocol"

/** The Browser MCA's id (renamed to mca.teros.browser by the BRN migration). */
export const BROWSER_MCA_IDS = ["mca.teros.browser", "mca.teros.playwright"] as const

export interface BrowserApp {
  appId: string
  mcaId: string
  name: string
}

/** The workspace's Browser app, or null when the capability is off there. */
export async function findBrowserApp(workspaceId: string): Promise<BrowserApp | null> {
  const client = getTerosClient()
  const apps = await client.workspace.listWorkspaceApps(workspaceId)
  const list = Array.isArray(apps) ? apps : ((apps as { apps?: BrowserApp[] }).apps ?? [])
  for (const id of BROWSER_MCA_IDS) {
    const app = list.find((a) => a.mcaId === id)
    if (app) return { appId: app.appId, mcaId: app.mcaId, name: app.name }
  }
  return null
}

export interface ViewResult {
  streamId: string
  tabId: string
  state: CloudTabState
}

/** `browser-view`: the tab (created on first use) and the stream to attach to. */
export async function requestView(
  appId: string,
  input: { tabId: string; url?: string; width?: number; height?: number },
): Promise<ViewResult> {
  const res = await getTerosClient().executeTool<{
    ok?: boolean
    streamId?: string
    tabId?: string
    state?: CloudTabState
    message?: string
  }>(appId, "browser-view", input)
  const r = res.result
  if (!r || typeof r !== "object" || !r.streamId) {
    throw new Error(
      typeof r === "object" && r?.message ? r.message : "browser-view returned no stream",
    )
  }
  return { streamId: r.streamId, tabId: r.tabId ?? input.tabId, state: r.state as CloudTabState }
}

export async function requestSuggest(
  appId: string,
  query: string,
): Promise<{ query: string; history: unknown[]; completions: string[] } | null> {
  const res = await getTerosClient().executeTool<{
    query: string
    history: unknown[]
    completions: string[]
  }>(appId, "browser-suggest", { query })
  return res.result ?? null
}

async function requestTicket(): Promise<TicketResponse> {
  return (await getTerosClient().send("stream", "ticket", {})) as TicketResponse
}

function wsBase(): string {
  const base = getTerosClient()?.getBackendBaseUrl() ?? ""
  return base.replace(/^http/, "ws")
}

/** A StreamConnection wired to the app's main socket for tickets. */
export function createBrowserStream(handlers: StreamHandlers): StreamConnection {
  return new StreamConnection(handlers, { getTicket: requestTicket, wsBase })
}
