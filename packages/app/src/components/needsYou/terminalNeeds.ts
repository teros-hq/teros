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
import type { TerminalSession } from "../../windows/TerminalWindow/terminalSessions"

export interface TerminalNeed {
  workspaceId: string
  workspaceName: string
  session: TerminalSession
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
): TerminalNeed[] {
  const seen = new Set<string>()
  const needs: TerminalNeed[] = []
  for (const w of workspaces) {
    if (w.role === "read") continue
    for (const session of feeds[w.workspaceId] ?? []) {
      if (!isBlocked(session) || seen.has(session.terminalId)) continue
      // A session lives in its owner workspace; a stray copy elsewhere is not a second notice.
      if (session.ownerWorkspaceId && session.ownerWorkspaceId !== w.workspaceId) continue
      seen.add(session.terminalId)
      needs.push({ workspaceId: w.workspaceId, workspaceName: w.name, session })
    }
  }
  return needs.sort(
    (a, b) =>
      since(a.session) - since(b.session) ||
      a.session.terminalId.localeCompare(b.session.terminalId),
  )
}

function since(s: TerminalSession): number {
  const at = s.agentState?.at ? Date.parse(s.agentState.at) : Number.NaN
  return Number.isNaN(at) ? 0 : at
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
