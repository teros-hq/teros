/**
 * Closing a terminal by hand (terminal.destroy — sessions never end on their
 * own). It closes at once, with a few seconds to undo, unless closing would
 * cut something off: a coding agent mid-turn, a program running in the
 * foreground, or someone else at the wheel. Then the window asks first.
 */

import type { TerminalSession } from "../terminalSessions"
import { isUnnamedAgent } from "./crewModel"

/** Why closing needs a confirmation (null: close at once). */
export type CloseReason =
  | { kind: "working"; agent: string }
  | { kind: "program"; command: string }
  | { kind: "driver"; name: string; agent: boolean }
  | null

const SHELLS = new Set(["bash", "-bash", "zsh", "-zsh", "sh", "dash", "fish", "login", "tmux"])
const CODING_AGENTS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "opencode",
}

/** A shell at its prompt, or nothing known in the foreground. */
export function isShellCommand(command: string | null | undefined): boolean {
  if (!command) return true
  const base = command.trim().split(/\s+/)[0]?.split("/").pop() ?? ""
  return base === "" || SHELLS.has(base)
}

export function closeReason(s: TerminalSession, me: string | undefined): CloseReason {
  const state = s.agentState?.state
  const agent = CODING_AGENTS[s.command ?? ""] ?? CODING_AGENTS[s.kind] ?? null
  if (agent && (state === "working" || state === "blocked")) return { kind: "working", agent }
  const d = s.driver
  // An agent the backend could not name is "the agent" in the question.
  if (d && d.kind === "agent")
    return { kind: "driver", name: isUnnamedAgent(d) ? "" : d.name || "", agent: true }
  if (d && d.kind === "human" && d.id && d.id !== me)
    return { kind: "driver", name: d.name || "", agent: false }
  if (!isShellCommand(s.command) && !agent) return { kind: "program", command: s.command ?? "" }
  // A coding agent at its prompt (idle / done) is not cut off by closing.
  return null
}

/** How long a closed terminal can still be brought back. */
export const UNDO_MS = 5_000

/** Destroys scheduled by an undoable close: they run even if the window goes away. */
const pending = new Map<string, ReturnType<typeof setTimeout>>()

export function scheduleClose(terminalId: string, destroy: () => void, ms = UNDO_MS): void {
  cancelClose(terminalId)
  pending.set(
    terminalId,
    setTimeout(() => {
      pending.delete(terminalId)
      destroy()
    }, ms),
  )
}

/** Undo: the terminal stays. True when a close was still pending. */
export function cancelClose(terminalId: string): boolean {
  const timer = pending.get(terminalId)
  if (!timer) return false
  clearTimeout(timer)
  pending.delete(terminalId)
  return true
}

export function isClosing(terminalId: string): boolean {
  return pending.has(terminalId)
}
