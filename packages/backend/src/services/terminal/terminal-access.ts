/**
 * Who may touch a live terminal session — shared by the terminal.* WS domain
 * and the /ws/terminal stream server, so both transports apply one rule.
 *
 * Rule (decision D6 in the terminal-gem report): a terminal is a root shell in
 * the workspace's container, and its screen routinely shows secrets (env, API
 * keys, OAuth codes). Viewing is therefore as privileged as typing: owner,
 * admin and write members only. A read-role member gets nothing — sessions are
 * not listed, not readable, not watchable, not resizable.
 *
 * Host shells (mca.teros.admin.bash) additionally require a system admin on
 * their own session — never a bridge call (see the terminal domain header).
 */

import type { Db } from "mongodb"
import { getSystemRole } from "../../auth/auth-helpers"
import { canAccessWorkspace, canWriteWorkspace } from "../../auth/workspace-access"
import type { PtyManager } from "../pty-manager"

export type TerminalAccessDenial =
  | "TERMINAL_NOT_FOUND"
  | "FORBIDDEN_TERMINAL"
  | "FORBIDDEN_WORKSPACE_ROLE"

export interface TerminalCaller {
  userId: string
  /** The call came through the MCA bridge (its userId is the workspace owner, not a person). */
  bridge: boolean
}

/** May this caller hold a host shell? A system admin on their own session. */
export async function mayUseHostPty(db: Db, caller: TerminalCaller): Promise<boolean> {
  if (caller.bridge) return false
  return (await getSystemRole(db, caller.userId)) !== null
}

/**
 * Check access to an existing session. Returns null when allowed, otherwise
 * the denial code. Order matters: authz before existence would let a caller
 * probe ids, so a missing session is reported only to callers who could see it
 * — and since an id that doesn't exist has no workspace, that is "not found".
 */
export async function checkTerminalAccess(
  db: Db,
  ptyManager: PtyManager,
  caller: TerminalCaller,
  terminalId: string,
): Promise<TerminalAccessDenial | null> {
  if (!ptyManager.has(terminalId)) return "TERMINAL_NOT_FOUND"
  const owner = ptyManager.ownerOf(terminalId)
  if (!owner || !(await canAccessWorkspace(db, caller.userId, owner))) return "FORBIDDEN_TERMINAL"
  if (ptyManager.isHost(terminalId) && !(await mayUseHostPty(db, caller)))
    return "FORBIDDEN_TERMINAL"
  if (!(await canWriteWorkspace(db, caller.userId, owner))) return "FORBIDDEN_WORKSPACE_ROLE"
  return null
}
