/**
 * window.teros helpers — the robust "locator" in RN-Web (no ARIA roles).
 * State assertions go through the live client, not the DOM.
 */
import type { Page } from "@playwright/test"

/** Run a fn in the page with window.teros available. Thin typed wrapper over evaluate. */
export function evalTeros<T, A = unknown>(
  page: Page,
  fn: (arg: A) => T | Promise<T>,
  arg?: A,
): Promise<T> {
  // biome-ignore lint/suspicious/noExplicitAny: page.evaluate bridge
  return page.evaluate(fn as any, arg as any)
}

/** Live client state — source of truth for "the app loaded" (language-agnostic). */
export function getClientState(page: Page) {
  return page.evaluate(async () => {
    // biome-ignore lint/suspicious/noExplicitAny: browser global
    const t = (window as any).teros
    if (!t) return { ok: false, reason: "window.teros no expuesto" }
    try {
      const agents = (await t.agent.listAgents().catch(() => ({}))).agents || []
      const wss = (await t.listWorkspaces().catch(() => [])) || []
      return { ok: true, agents: agents.length, workspaces: wss.length }
    } catch (e) {
      return { ok: false, reason: (e as Error).message }
    }
  })
}

/**
 * Records WS events into window.__terosEvents. Install BEFORE any action that
 * fires events, otherwise the event can arrive before we subscribe (race).
 */
export async function installEventRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: browser global
    const w = window as any
    if (!w.teros || w.__terosRec) return
    w.__terosRec = true
    w.__terosEvents = []
    // Mirror the events the client forwards (client.ts setupEventForwarding) that
    // the specs assert on: conversation/streaming + the TER-304 NavBar realtime
    // domain events (agent/workspace/project/app) + board task events.
    const events = [
      "message_chunk",
      "queue_state",
      "channel_list_status",
      "channel_status",
      "message_sent",
      "agent_phase",
      "typing",
      "tool_permission_request",
      "agent.created",
      "agent.updated",
      "agent.deleted",
      "workspace.created",
      "workspace.updated",
      "workspace.archived",
      "project.created",
      "project.updated",
      "project.deleted",
      "app.installed",
      "app.updated",
      "app.uninstalled",
      "board_task_created",
      "board_task_updated",
      "board_task_deleted",
    ]
    for (const ev of events) {
      w.teros.on(ev, (data: unknown) => w.__terosEvents.push({ type: ev, data, t: Date.now() }))
    }
  })
}

/**
 * Clears the recorded event buffer. Call BEFORE a realtime action so a matching
 * event from an earlier test can't be a false positive (workers:1 → shared page,
 * buffer accumulates across tests).
 */
export async function clearEvents(page: Page): Promise<void> {
  await page.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: browser global
    const w = window as any
    if (w.__terosEvents) w.__terosEvents.length = 0
  })
}

export type EventCriteria = { type: string; [key: string]: unknown }

/**
 * Waits (auto-polling, web-first style) until a recorded event matches every
 * key in `criteria` (matched against event.data). Returns the event or null on timeout.
 */
export async function waitForEvent(
  page: Page,
  criteria: EventCriteria,
  timeoutMs = 15000,
): Promise<unknown | null> {
  try {
    const handle = await page.waitForFunction(
      (c) => {
        // biome-ignore lint/suspicious/noExplicitAny: browser global
        const evs = (window as any).__terosEvents || []
        // biome-ignore lint/suspicious/noExplicitAny: dynamic event shape
        return evs.find((e: any) => {
          if (e.type !== c.type) return false
          for (const k of Object.keys(c)) {
            if (k === "type") continue
            if (e.data?.[k] !== (c as Record<string, unknown>)[k]) return false
          }
          return true
        })
      },
      criteria,
      { timeout: timeoutMs, polling: 200 },
    )
    return await handle.jsonValue()
  } catch {
    return null
  }
}

/**
 * Resolves the ids the specs need from the LIVE client (source of truth), since
 * seed.mjs fixtures only carry userId + sharedWorkspaceId. Robust to re-seeds.
 */
export function getPrimaryIds(page: Page): Promise<{
  agentId: string | null
  privateWorkspaceId: string | null
  agentCount: number
  workspaceCount: number
}> {
  return page.evaluate(async () => {
    // biome-ignore lint/suspicious/noExplicitAny: browser global
    const t = (window as any).teros
    const agents = (await t.agent.listAgents().catch(() => ({}))).agents || []
    const wss = (await t.listWorkspaces().catch(() => [])) || []
    // WorkspaceData uses `.workspaceId` + `.type` ('private'|'shared') — NOT `.id`
    // (client.ts:291 listWorkspaces returns the unwrapped WorkspaceData[]).
    // biome-ignore lint/suspicious/noExplicitAny: dynamic shape
    const priv = wss.find((w: any) => w.type === "private") || wss[0]
    return {
      agentId: agents[0]?.agentId ?? null,
      privateWorkspaceId: priv?.workspaceId ?? null,
      agentCount: agents.length,
      workspaceCount: wss.length,
    }
  })
}

/** Captured console + page + network(4xx/5xx) errors for a page (set by fixtures). */
export type CapturedErrors = { console: string[]; page: string[]; network: string[] }

/**
 * Fires a WS action and captures whether it resolved or rejected — for negative
 * authz tests. `resolved: true` means the action SUCCEEDED; in a denial case that
 * is an authz HOLE (the gate let it through) and the test must go red.
 *
 * Uses `transport.request(action, params)` directly: uniform across the six
 * domains, including skill/scheduler which have no typed sub-API on window.teros.
 * `code` is preserved by the transport (ws-transport.ts, `type === 'error'` branch);
 * `message` is the backend's literal string (no prefix).
 */
export async function attemptAction(
  page: Page,
  action: string,
  params: Record<string, unknown>,
): Promise<{ resolved: boolean; message: string | null; code: string | null }> {
  return page.evaluate(
    async ({ action, params }) => {
      // biome-ignore lint/suspicious/noExplicitAny: browser global
      const t = (window as any).teros
      try {
        await t.transport.request(action, params)
        return { resolved: true, message: null, code: null }
      } catch (e) {
        const err = e as { message?: string; code?: string }
        return { resolved: false, message: err?.message ?? String(e), code: err?.code ?? null }
      }
    },
    { action, params },
  )
}

/**
 * Fires a WS action through the page's authenticated client and returns the
 * resolved data (rejects bubble up → the test fails, which is what we want for a
 * positive path). The mirror of `attemptAction`, which swallows the rejection for
 * negative authz/validation cases. Runs the exact client → transport → backend
 * path the UI uses, so a client-side serialization bug (wrong param name) bites.
 */
export function wsRequest<T = unknown>(
  page: Page,
  action: string,
  data: Record<string, unknown> = {},
): Promise<T> {
  return page.evaluate(
    ({ action, data }) =>
      // biome-ignore lint/suspicious/noExplicitAny: browser global
      (window as any).teros.transport.request(action, data),
    { action, data },
  ) as Promise<T>
}

/**
 * Attempts an email/password auth over a THROWAWAY WebSocket (not the page's
 * authenticated client), replicating ws-transport's handshake message
 * `{type:'auth', method:'credentials', email, password}`. Returns the auth
 * outcome: `success` plus the backend's `error` string on failure
 * ('Invalid email or password' vs 'Account temporarily locked…'). Used by the
 * lockout regression (#157) to drive failed logins without touching the seed
 * sessions. The socket is closed immediately after the verdict.
 */
export async function rawWsLogin(
  page: Page,
  wsUrl: string,
  email: string,
  password: string,
): Promise<{ success: boolean; error: string | null }> {
  return page.evaluate(
    ({ wsUrl, email, password }) =>
      new Promise<{ success: boolean; error: string | null }>((resolve) => {
        const ws = new WebSocket(wsUrl)
        const done = (r: { success: boolean; error: string | null }) => {
          try {
            ws.close()
          } catch {
            /* already closing */
          }
          resolve(r)
        }
        const timer = setTimeout(() => done({ success: false, error: "TIMEOUT" }), 10000)
        ws.onopen = () =>
          ws.send(JSON.stringify({ type: "auth", method: "credentials", email, password }))
        ws.onmessage = (ev) => {
          let msg: { type?: string; error?: string }
          try {
            msg = JSON.parse(typeof ev.data === "string" ? ev.data : "")
          } catch {
            return
          }
          if (msg.type === "auth_success") {
            clearTimeout(timer)
            done({ success: true, error: null })
          } else if (msg.type === "auth_error") {
            clearTimeout(timer)
            done({ success: false, error: msg.error ?? "unknown" })
          }
        }
        ws.onerror = () => {
          clearTimeout(timer)
          done({ success: false, error: "WS_ERROR" })
        }
      }),
    { wsUrl, email, password },
  )
}
