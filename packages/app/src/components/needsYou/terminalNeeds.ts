/**
 * Terminals that need the person, across every workspace they can write in:
 * a coding agent (Claude Code…) blocked on a question or a permission. Fed by
 * TerminalNeedsWatcher (one terminal.watch per workspace) and read by the
 * general notices — the navbar's pending banner and sheet, the Pending
 * Approvals window and Home's "Te esperan".
 *
 * The selectors are pure; the store only holds each workspace's live list.
 */

import { create } from "zustand"
import type { NavbarWorkspace } from "../../store/navbarStore"
import type { MemberRole } from "@teros/shared"
import { isAskedToUse, isBlockedOn } from "../../windows/TerminalWindow/sessionStatus"
import type { TerminalSession } from "../../windows/TerminalWindow/terminalSessions"

export type TerminalNeedKind = "blocked" | "request"

export interface TerminalNeed {
  workspaceId: string
  workspaceName: string
  session: TerminalSession
  kind: TerminalNeedKind
}

/** Workspaces whose terminals the person may see and answer (terminal.watch needs write). */
export function writableWorkspaceIds(
  workspaces: Pick<NavbarWorkspace, "workspaceId" | "role">[],
): string[] {
  return workspaces.filter((w) => w.role !== "read").map((w) => w.workspaceId)
}

/** Is a coding agent in this session waiting for an answer? (A finished turn is not a notice.) */
export function isBlocked(s: TerminalSession): boolean {
  return s.agentState?.state === "blocked"
}

/**
 * The sessions waiting for the person: blocked only, in a workspace they can
 * still write in, each terminal once, the longest-waiting first.
 */
export function selectTerminalNeeds(
  feeds: Record<string, TerminalSession[]>,
  workspaces: Pick<NavbarWorkspace, "workspaceId" | "name" | "role">[],
  me?: string,
): TerminalNeed[] {
  const seen = new Set<string>()
  const needs: TerminalNeed[] = []
  for (const w of workspaces) {
    if (w.role === "read") continue
    for (const session of feeds[w.workspaceId] ?? []) {
      if (session.ownerWorkspaceId && session.ownerWorkspaceId !== w.workspaceId) continue
      for (const kind of kindsOf(session, me, w.role)) {
        const key = `${session.terminalId}:${kind}`
        if (seen.has(key)) continue
        seen.add(key)
        needs.push({ workspaceId: w.workspaceId, workspaceName: w.name, session, kind })
      }
    }
  }
  return needs.sort(
    (a, b) =>
      since(a) - since(b) ||
      a.session.terminalId.localeCompare(b.session.terminalId) ||
      a.kind.localeCompare(b.kind),
  )
}

function kindsOf(
  session: TerminalSession,
  me: string | undefined,
  role: MemberRole,
): TerminalNeedKind[] {
  const kinds: TerminalNeedKind[] = []
  const blocked = me === undefined ? isBlocked(session) : isBlockedOn(session, me, role)
  const asked = me === undefined ? !!session.wheelRequest : isAskedToUse(session, me, role)
  if (blocked) kinds.push("blocked")
  if (asked) kinds.push("request")
  return kinds
}

function since(need: TerminalNeed): number {
  if (need.kind === "request") return need.session.wheelRequest?.at ?? 0
  const at = need.session.agentState?.at ? Date.parse(need.session.agentState.at) : Number.NaN
  return Number.isNaN(at) ? 0 : at
}

export function terminalNeedKey(need: Pick<TerminalNeed, "session" | "kind">): string {
  return `${need.session.terminalId}:${need.kind}`
}

/** One question of one session: a new block (new `at`) is a new question. */
export function needKey(s: Pick<TerminalSession, "terminalId" | "agentState">): string {
  return `${s.terminalId}@${s.agentState?.at ?? ""}`
}

// ── Store ─────────────────────────────────────────────────────────────────────

interface TerminalNeedsState {
  /** Live sessions per watched workspace. */
  feeds: Record<string, TerminalSession[]>
  setFeed(workspaceId: string, sessions: TerminalSession[]): void
  dropFeed(workspaceId: string): void
}

export const useTerminalNeedsStore = create<TerminalNeedsState>((set) => ({
  feeds: {},
  setFeed: (workspaceId, sessions) =>
    set((s) =>
      s.feeds[workspaceId] === sessions ? s : { feeds: { ...s.feeds, [workspaceId]: sessions } },
    ),
  dropFeed: (workspaceId) =>
    set((s) => {
      if (!(workspaceId in s.feeds)) return s
      const feeds = { ...s.feeds }
      delete feeds[workspaceId]
      return { feeds }
    }),
}))
