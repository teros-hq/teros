/**
 * Who may touch a live terminal session — shared by the terminal.* WS domain
 * and the /ws/terminal stream server, so both transports apply one rule.
 *
 * Host shells (mca.teros.admin.bash) additionally require a system admin on
 * their own session — never a bridge call (see the terminal domain header).
 */

import {
  type AccessAction,
  type AccessRefusal,
  evaluateAccess,
  roleReaches,
  type Principal,
  TERMINAL_SESSION_POLICY,
  type TerminalSessionShape,
  terminalSessionThing,
} from "@teros/shared"
import type { Db } from "mongodb"
import { getSystemRole } from "../../auth/auth-helpers"
import type { PtyManager } from "../pty-manager"
import { agentPrincipal, memberPrincipal, memberRole } from "../sharing/principals"

export type TerminalAccessDenial =
  | "TERMINAL_NOT_FOUND"
  | "FORBIDDEN_TERMINAL"
  | "FORBIDDEN_WORKSPACE_ROLE"
  | "TERMINAL_VIEW_ONLY"

export interface TerminalCaller {
  userId: string
  /** The call came through the MCA bridge (its userId is the workspace owner, not a person). */
  bridge: boolean
  workspaceId?: string | null
}

/** May this caller hold a host shell? A system admin on their own session. */
export async function mayUseHostPty(db: Db, caller: TerminalCaller): Promise<boolean> {
  if (caller.bridge) return false
  return (await getSystemRole(db, caller.userId)) !== null
}

export type SessionReach = TerminalSessionShape

export const sessionThing = terminalSessionThing

export async function terminalPrincipal(
  db: Db,
  caller: TerminalCaller,
  workspaceId: string,
): Promise<Principal> {
  if (!caller.bridge) return memberPrincipal(db, caller.userId, workspaceId)
  const behind = await memberRole(db, caller.userId, workspaceId)
  return agentPrincipal(
    roleReaches(behind, TERMINAL_SESSION_POLICY.entry) ? caller.workspaceId : null,
  )
}

export function sessionRefusal(
  session: SessionReach,
  workspaceId: string,
  principal: Principal,
  action: AccessAction = "see",
): AccessRefusal | null {
  const decision = evaluateAccess(
    principal,
    sessionThing(session, workspaceId),
    action,
    TERMINAL_SESSION_POLICY,
  )
  return decision.allowed ? null : decision.reason
}

export function mayReachSession(
  session: SessionReach,
  workspaceId: string,
  principal: Principal,
  action: AccessAction = "see",
): boolean {
  return sessionRefusal(session, workspaceId, principal, action) === null
}

function denialOf(reason: AccessRefusal): TerminalAccessDenial {
  if (reason === "role") return "FORBIDDEN_WORKSPACE_ROLE"
  if (reason === "view_only") return "TERMINAL_VIEW_ONLY"
  return "FORBIDDEN_TERMINAL"
}

export async function checkTerminalAccess(
  db: Db,
  ptyManager: PtyManager,
  caller: TerminalCaller,
  terminalId: string,
  action: AccessAction = "use",
): Promise<TerminalAccessDenial | null> {
  if (!ptyManager.has(terminalId)) return "TERMINAL_NOT_FOUND"
  const owner = ptyManager.ownerOf(terminalId)
  if (!owner) return "FORBIDDEN_TERMINAL"
  const principal = await terminalPrincipal(db, caller, owner)
  if (principal.kind === "member" && !principal.role) return "FORBIDDEN_TERMINAL"
  if (ptyManager.isHost(terminalId) && !(await mayUseHostPty(db, caller)))
    return "FORBIDDEN_TERMINAL"
  const session = ptyManager.describe ? ptyManager.describe(terminalId) : {}
  if (!session) return "TERMINAL_NOT_FOUND"
  const reason = sessionRefusal(session, owner, principal, action)
  return reason ? denialOf(reason) : null
}
