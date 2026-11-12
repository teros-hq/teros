/**
 * What an agent driving a terminal waits for (terminal.wait), as checks for
 * PtyManager.waitUntil. They read the session's coding-agent state (hooks or
 * the screen heuristic), its foreground command and output timing, so an
 * agent never has to sleep, poll the screen or match escape codes:
 *
 *   turn   the coding agent finished its turn (done), needs an answer
 *          (blocked: permission, question), needs a login, or left
 *   ready  a coding agent is up and waiting for input (after starting it)
 *   quiet  no output for `quietMs` after the mark (the screen settled)
 *   text   the rendered screen contains `text` / matches `pattern`
 *   exit   the program in the foreground ended and the shell is back
 *
 * Every wait is relative to a mark (PtyManager.mark / lastWriteMark): a state
 * that was already current at the mark never counts as "the turn ended" —
 * the classic race of a prompt sent while the previous turn's `done` is still
 * the current state.
 */

import type { InputMark, WaitView } from "../pty-manager"
import { AGENT_COMMANDS, detectBlocked, detectMenu } from "./agent-heuristics"

export const WAIT_UNTIL = ["turn", "ready", "quiet", "text", "exit"] as const
export type WaitUntil = (typeof WAIT_UNTIL)[number]

export function isWaitUntil(v: unknown): v is WaitUntil {
  return typeof v === "string" && (WAIT_UNTIL as readonly string[]).includes(v)
}

export interface WaitOutcome {
  /** done · blocked · needs-login · exited · not-started · ready · quiet · matched · ended */
  reason: string
  /** The agent's own words (e.g. the permission it asks for), when there are some. */
  message?: string
}

const SHELLS = new Set(["bash", "sh", "zsh", "fish", "dash", "-bash", "login"])

export function isShellCommand(command: string | null): boolean {
  return command === null || command === "" || SHELLS.has(command)
}

export function isAgentCommand(command: string | null): boolean {
  return command !== null && AGENT_COMMANDS.has(command)
}

/**
 * Hook timestamps are unix seconds (old helper) or milliseconds: a state is
 * "after the mark" when its time is not before the mark minus the clock
 * granularity. Container and backend share the host clock.
 */
function stateIsAfter(at: Date, mark: InputMark): boolean {
  const t = at.getTime()
  const granularity = t % 1000 === 0 ? 1000 : 250
  return t >= mark.at - granularity
}

/** A turn's end / a ready agent is reported once its screen was quiet this long. */
export const SETTLE_MS = 500

/** turn: no sign of work this long after the prompt (and a quiet screen) → "not-started". */
export const NOT_STARTED_MS = 8000

export interface WaitCheckOptions {
  until: WaitUntil
  mark: InputMark
  /** quiet: no output for this long (default 1500 ms). */
  quietMs?: number
  /** text: the screen must contain this (case-insensitive) … */
  text?: string
  /** … or match this. */
  pattern?: RegExp
  /** Time source (tests). */
  now?: () => number
}

/** Build the check for PtyManager.waitUntil. Stateful: create one per wait. */
export function makeWaitCheck(
  opts: WaitCheckOptions,
): (view: WaitView) => Promise<WaitOutcome | null> {
  const now = opts.now ?? Date.now
  const quietMs = opts.quietMs ?? 1500
  let sawWorking = false
  let sawAgent = false
  let sawNonShell = false
  let lastScreenSeq = -1
  let lastScreenAt = 0

  return async (view) => {
    if (view.ended) return { reason: "ended" }
    const state = view.agentState
    const fresh = view.stateSeq > opts.mark.stateSeq
    if (isAgentCommand(view.command)) sawAgent = true
    if (!isShellCommand(view.command)) sawNonShell = true
    if (fresh && state?.state === "working") sawWorking = true
    const msg = state?.message ? { message: state.message } : {}

    switch (opts.until) {
      case "turn": {
        if (view.needsAuth) return { reason: "needs-login" }
        if (sawAgent && !isAgentCommand(view.command) && isShellCommand(view.command))
          return { reason: "exited" }
        if (!state || !fresh || (state.state === "idle" && !sawWorking)) {
          // No agent running at all: nothing will ever end a turn.
          if (
            !isAgentCommand(view.command) &&
            now() - opts.mark.at > 3000 &&
            quietFor(view, now) > 3000
          )
            return { reason: "exited" }
          // The agent never started on it (the Enter went to a dialog, the
          // input was refused…): say so instead of waiting for nothing.
          if (now() - opts.mark.at >= NOT_STARTED_MS && quietFor(view, now) >= 3000)
            return (await pendingQuestion(view)) ?? { reason: "not-started" }
          return null
        }
        if (state.state !== "done" && state.state !== "blocked") return null
        if (!sawWorking && !stateIsAfter(state.at, opts.mark)) return null
        // Let the screen settle: the agent draws its answer (or a dialog) after the hook.
        if (quietFor(view, now) < SETTLE_MS) return null
        const question = await pendingQuestion(view)
        if (state.state === "blocked") return withScreenQuestion(state.message, question)
        return question ?? { reason: "done", ...msg }
      }
      case "ready": {
        if (view.needsAuth) return { reason: "needs-login" }
        if (!isAgentCommand(view.command)) return null
        if (state && state.state === "blocked")
          return withScreenQuestion(state.message, await pendingQuestion(view))
        // A live agent already working is ready: the session booted and is
        // productive — waiting for it to go idle again would time out on every
        // re-seat of a mid-flight session (the runner's own reminder loop can
        // legitimately resume it while the open is still waiting).
        if (state && state.state === "working" && fresh) return { reason: "ready" }
        const up =
          (state && state.state !== "working" && (fresh || stateIsAfter(state.at, opts.mark))) ||
          // Agents without hooks: up and drawn, then quiet.
          (!state && quietFor(view, now) >= 2000 && view.lastOutputAt > 0)
        if (!up || quietFor(view, now) < SETTLE_MS) return null
        return (await pendingQuestion(view)) ?? { reason: "ready" }
      }
      case "quiet":
        // Settled after the mark: its own output (an echo, a redraw) must not count as quiet.
        if (quietFor(view, now) < quietMs) return null
        return view.lastOutputAt >= opts.mark.at || now() - opts.mark.at >= quietMs
          ? { reason: "quiet" }
          : null
      case "exit":
        if (!isShellCommand(view.command)) return null
        // The foreground command is polled about once a second: a fast
        // command may come and go unseen, so a back-at-the-shell after that
        // long counts too.
        if (!sawNonShell && now() - opts.mark.at < 1500) return null
        // A shell builtin or a pure-bash loop keeps bash in the foreground:
        // the prompt must be back on screen (or, for unusual prompts, a quiet screen).
        if (quietFor(view, now) < 300) return null
        if (quietFor(view, now) >= 15_000) return { reason: "exited" }
        return (await endsOnPrompt(view)) ? { reason: "exited" } : null
      case "text": {
        if (view.outputSeq === lastScreenSeq) return null
        // At most a few captures per second while output streams.
        if (now() - lastScreenAt < 200) return null
        lastScreenSeq = view.outputSeq
        lastScreenAt = now()
        const screen = await view.screen()
        if (!screen) return null
        const joined = screen.lines.join("\n")
        if (opts.pattern?.test(joined)) return { reason: "matched" }
        if (opts.text && joined.toLowerCase().includes(opts.text.toLowerCase()))
          return { reason: "matched" }
        return null
      }
    }
  }
}

/**
 * "Done" / "ready" from a hook while the screen shows a menu or a question
 * (a dialog the agent opened without a hook of its own, e.g. Claude Code
 * offering to change its permission mode) is really "blocked": it waits for
 * an answer, and the prompt just sent may not have been taken at all.
 */
async function pendingQuestion(view: WaitView): Promise<WaitOutcome | null> {
  const screen = await view.screen().catch(() => null)
  if (!screen) return null
  const question = detectMenu(screen.lines) ?? detectBlocked(screen.lines)
  return question ? { reason: "blocked", message: question } : null
}

/** A shell prompt on the last non-empty row (`root@x:/workspace# `, `$ `, `% `, `❯ `, `➜ `, `λ `). */
const PROMPT_ROW = /[$#%>❯➜λ»]\s*$/

async function endsOnPrompt(view: WaitView): Promise<boolean> {
  const screen = await view.screen().catch(() => null)
  if (!screen) return false
  const rows = screen.lines.filter((l) => l.trim() !== "")
  return PROMPT_ROW.test(rows[rows.length - 1] ?? "")
}

/** The hook's words ("Claude needs your permission") plus what the screen asks, when it says more. */
function withScreenQuestion(hook: string | undefined, screen: WaitOutcome | null): WaitOutcome {
  const asked = screen?.message
  const message = hook && asked ? `${hook} — ${asked}` : (hook ?? asked)
  return message ? { reason: "blocked", message } : { reason: "blocked" }
}

function quietFor(view: WaitView, now: () => number): number {
  return view.lastOutputAt === 0 ? Number.POSITIVE_INFINITY : now() - view.lastOutputAt
}
