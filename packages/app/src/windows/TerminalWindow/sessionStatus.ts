import type { MemberRole } from "@teros/shared"
import { create } from "zustand"
import type { WindowStatus } from "../../store/windowTabMetaStore"
import type { TerminalSession } from "./terminalSessions"
import { sessionActions } from "./terminalWindowModel"

interface SessionMarks {
  finished: Record<string, true>
}

export const useSessionMarks = create<SessionMarks>()(() => ({ finished: {} }))

export function markFinished(terminalId: string, on: boolean): void {
  useSessionMarks.setState((state) => {
    if (!!state.finished[terminalId] === on) return state
    const finished = { ...state.finished }
    if (on) finished[terminalId] = true
    else delete finished[terminalId]
    return { finished }
  })
}

export function mayUse(
  session: TerminalSession,
  me: string | undefined,
  role: MemberRole = "write",
): boolean {
  return sessionActions(session, me, role).includes("use")
}

export function isBlockedOn(
  session: TerminalSession,
  me: string | undefined,
  role: MemberRole = "write",
): boolean {
  return session.agentState?.state === "blocked" && mayUse(session, me, role)
}

export function isAskedToUse(
  session: TerminalSession,
  me: string | undefined,
  role: MemberRole = "write",
): boolean {
  return !!session.wheelRequest && sessionActions(session, me, role).includes("control")
}

export function sessionStatus(
  session: TerminalSession,
  me: string | undefined,
  role: MemberRole = "write",
  finished: Record<string, true> = useSessionMarks.getState().finished,
): WindowStatus | null {
  if (isAskedToUse(session, me, role) || isBlockedOn(session, me, role)) return "needs-you"
  const state = session.agentState?.state
  if (state === "working") return "working"
  if (state === "done" && finished[session.terminalId]) return "finished"
  return null
}
