/**
 * Browser command bridge — renderer side (Teros Desktop F3, task
 * tn_Q9fbZS5wwxWiYRPl).
 *
 * The agent's browser.* commands arrive as `ui_command` events on the UI
 * channel (same WebSocket the SPA already uses — decision Pablo 31-oct: no
 * MCA, no pairing, no tunnel). Unlike every other ui_command they are
 * REQUEST-RESPONSE: the envelope carries a `correlationId`, and the agent's
 * tool call is parked in the backend until THIS client answers.
 *
 * This module:
 *   1. Detects browser.* commands in the ui_command stream (uiSync/index.ts
 *      forwards every event here; anything without a correlationId is left
 *      to the regular fire-and-forget executor).
 *   2. Forwards them to the Electron MAIN process through the preload bridge
 *      `window.terosDesktop.executeBrowserCommand` — the main process owns
 *      the WebContentsView of the tab and runs CDP on it (executor from the
 *      spike: attach('1.3'), getFullAXTree + DOM.getBoxModel, Input.*,
 *      capturePage). In a plain web browser (no preload) the commands are
 *      answered with browser_unavailable — the agent gets a clean error,
 *      never a hang.
 *   3. Sends the executor's outcome back with `ui.command-result`
 *      (correlationId + ok/code/message/result).
 *
 * Dedup: the regular executor's commandId dedup does NOT apply here — the
 * backend delivers a browser command to exactly ONE session once, and the
 * reply is single-shot. A duplicate delivery (resubscribed session) would
 * find the correlationId already answered; we answer again with the same
 * outcome (idempotent for the backend: the second answer is dropped as a
 * duplicate) — simpler and safer than tracking.
 *
 * Robustness: NOTHING here can throw into the ui_command handler — every
 * failure path answers the command (browser_unavailable, executor error,
 * timeout) so the agent's tool call always resolves.
 */

import { getTerosClient } from "../terosClientSingleton"
import { getActiveWorkspaceId } from "../../store/workspaceStoreRef"

/** The preload surface the Electron shell injects (F1/F2 contract). */
export interface TerosDesktopBridge {
  /**
   * Execute ONE browser command in the main process.
   * Returns the executor's outcome: { ok, result?, code?, message? }.
   * The main process owns consent (user toggle, OFF by default) and the
   * take-over fence — it refuses input commands with agent_control_disabled
   * / human_has_control without executing anything.
   */
  executeBrowserCommand(command: Record<string, unknown>): Promise<{
    ok: boolean
    result?: Record<string, unknown>
    code?: string
    message?: string
  }>
}

/** window.terosDesktop — present only inside the Teros desktop app. */
export function getDesktopBridge(): TerosDesktopBridge | null {
  const w = globalThis as { terosDesktop?: TerosDesktopBridge }
  return w.terosDesktop ?? null
}

/** True when the command envelope is a correlated browser command. */
export function isBrowserCommand(command: unknown): command is Record<string, unknown> {
  if (typeof command !== "object" || command === null) return false
  const kind = (command as { command?: unknown }).command
  return typeof kind === "string" && kind.startsWith("browser.")
}

/** How long the renderer waits for the main process before answering timeout. */
const EXECUTOR_TIMEOUT_MS = 22_000 // < backend's 25s pending timeout

/**
 * Handle ONE ui_command event that isBrowserCommand(): forward to the main
 * process and answer via ui.command-result. Returns a short outcome string
 * for logs. Never throws.
 */
export async function handleBrowserCommand(event: unknown): Promise<"forwarded" | "skipped"> {
  try {
    const envelope = (event as { command?: Record<string, unknown> })?.command
    if (!isBrowserCommand(envelope)) return "skipped"
    const correlationId = readString(envelope, "correlationId")
    const commandKind = readString(envelope, "command")
    if (!correlationId || !commandKind) {
      // Malformed browser command — nothing to correlate, nothing to answer.
      console.warn("[uiSync:browser] browser command without correlationId — ignored", envelope)
      return "skipped"
    }

    const workspaceId = getActiveWorkspaceId()
    if (!workspaceId) {
      console.warn("[uiSync:browser] no active workspace — cannot answer browser command")
      return "skipped"
    }

    const bridge = getDesktopBridge()
    let outcome: { ok: boolean; result?: Record<string, unknown>; code?: string; message?: string }

    if (!bridge) {
      // Plain web browser (or an older shell without the preload): answer
      // cleanly — the agent learns the desktop app is required, no hang.
      outcome = {
        ok: false,
        code: "browser_unavailable",
        message:
          "This client is not the Teros desktop app — browser tabs can only be driven from the desktop app " +
          "(a browser tab is a native window there). Ask the user to open Teros on the desktop app.",
      }
    } else {
      outcome = await withTimeout(
        bridge.executeBrowserCommand(envelope),
        EXECUTOR_TIMEOUT_MS,
        {
          ok: false,
          code: "browser_executor_timeout",
          message: `The desktop executor did not finish ${commandKind} in time — the tab may be busy or navigating.`,
        },
      )
    }

    await sendCommandResult(workspaceId, correlationId, outcome)
    console.log(
      `[uiSync:browser] ${commandKind} correlation=${correlationId} ok=${outcome.ok} code=${outcome.code ?? "-"}`,
    )
    return "forwarded"
  } catch (err) {
    // Absolute last resort: answer with an internal error so the agent's
    // call resolves instead of timing out opaquely.
    try {
      const envelope = (event as { command?: Record<string, unknown> })?.command
      const correlationId = envelope ? readString(envelope, "correlationId") : null
      const workspaceId = getActiveWorkspaceId()
      if (correlationId && workspaceId) {
        await sendCommandResult(workspaceId, correlationId, {
          ok: false,
          code: "browser_bridge_error",
          message: `Renderer bridge failed: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
    } catch {
      // Even the error path failed (transport down) — the backend's 25s
      // pending timeout is the backstop; nothing more to do here.
    }
    console.error("[uiSync:browser] error handling browser command:", err)
    return "skipped"
  }
}

/** Send the executor's answer to the backend (ui.command-result). */
async function sendCommandResult(
  workspaceId: string,
  correlationId: string,
  outcome: { ok: boolean; result?: Record<string, unknown>; code?: string; message?: string },
): Promise<void> {
  const client = getTerosClient()
  await client.transport.request("ui.command-result", {
    workspaceId,
    correlationId,
    ok: outcome.ok,
    ...(outcome.result !== undefined ? { result: outcome.result } : {}),
    ...(outcome.code !== undefined ? { code: outcome.code } : {}),
    ...(outcome.message !== undefined ? { message: outcome.message } : {}),
  })
}

/** Race a promise against a timeout; on timeout return the fallback outcome. */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        // The main process rejected (IPC error, executor crash): shape it as
        // an outcome so the agent sees the reason.
        resolve({
          ...(fallback as { ok: boolean }),
          ok: false,
          code: "browser_executor_error",
          message: err instanceof Error ? err.message : String(err),
        } as unknown as T)
      },
    )
  })
}

/** Read a non-empty string field from a record. */
function readString(record: Record<string, unknown>, key: string): string | null {
  const v = record[key]
  return typeof v === "string" && v.length > 0 ? v : null
}
