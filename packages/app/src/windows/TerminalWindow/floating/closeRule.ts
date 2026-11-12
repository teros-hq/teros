import type { TerminalSession } from "../terminalSessions"

/**
 * Closing asks twice only when it would cut something off: a program runs in
 * it, its coding agent is busy, or someone else is at the wheel.
 */
export function closeNeedsConfirm(
  session: TerminalSession | undefined,
  me: string | undefined,
): boolean {
  if (!session) return false
  const runs = !!session.command && !/^(ba|z|fi|da)?sh$/.test(session.command)
  const busy = session.agentState?.state === "working" || session.agentState?.state === "blocked"
  const d = session.driver
  const someoneElse = !!d && d.kind !== "none" && !(d.kind === "human" && d.id === me)
  return runs || busy || someoneElse
}
