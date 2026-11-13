import { terminalSessionSpace } from "@teros/shared"
import { useSyncExternalStore } from "react"
import { isUnnamedAgent, openerOf } from "./sessionText"
import type { TerminalSession } from "./terminalSessions"

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
  if (d && d.kind === "agent")
    return { kind: "driver", name: isUnnamedAgent(d) ? "" : d.name || "", agent: true }
  if (d && d.kind === "human" && d.id && d.id !== me)
    return { kind: "driver", name: d.name || "", agent: false }
  if (!isShellCommand(s.command) && !agent) return { kind: "program", command: s.command ?? "" }
  return null
}

export function isBusy(s: Pick<TerminalSession, "command" | "agentState" | "driver">): boolean {
  const state = s.agentState?.state
  if (state === "working" || state === "blocked") return true
  if (s.driver?.kind === "agent") return true
  return !s.command || !isShellCommand(s.command)
}

export type CloseOutcome = "end" | "ask" | "keep" | "view"

export function closeOutcome(s: TerminalSession, me: string | undefined): CloseOutcome {
  if (terminalSessionSpace(s) !== "personal") return "keep"
  if (openerOf(s, me) !== "you") return "view"
  if (s.watchable) return "keep"
  return isBusy(s) ? "ask" : "end"
}

export const UNDO_MS = 5_000

const pending = new Map<string, ReturnType<typeof setTimeout>>()
const closingListeners = new Set<() => void>()
let closingVersion = 0

function closingChanged(): void {
  closingVersion++
  for (const l of closingListeners) l()
}

export function scheduleClose(terminalId: string, start: () => void, ms = UNDO_MS): void {
  cancelClose(terminalId)
  pending.set(
    terminalId,
    setTimeout(() => {
      pending.delete(terminalId)
      closingChanged()
    }, ms),
  )
  closingChanged()
  start()
}

export function cancelClose(terminalId: string): boolean {
  const timer = pending.get(terminalId)
  if (!timer) return false
  clearTimeout(timer)
  pending.delete(terminalId)
  closingChanged()
  return true
}

export async function undoClose(
  terminalId: string,
  cancelOnServer: (terminalId: string) => Promise<{ cancelled?: boolean } | undefined>,
): Promise<boolean> {
  if (!cancelClose(terminalId)) return false
  const answer = await cancelOnServer(terminalId).catch(() => null)
  return answer?.cancelled === true
}

export function isClosing(terminalId: string): boolean {
  return pending.has(terminalId)
}

export function useClosingVersion(): number {
  return useSyncExternalStore(
    (l) => {
      closingListeners.add(l)
      return () => closingListeners.delete(l)
    },
    () => closingVersion,
  )
}
