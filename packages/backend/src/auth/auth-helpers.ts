/**
 * Centralized auth helpers
 *
 * Centralizes role checks previously duplicated across admin-api/* handlers.
 * Two levels of authorization:
 *
 * 1. System admin — `users.role ∈ {'admin', 'super'}`. Use `requireSystemAdmin`.
 *    For platform-wide operations (admin-api.*).
 *
 * 2. Workspace admin — `workspace.ownerId === userId` OR
 *    `workspace.members[].role === 'admin'`. Use `WorkspaceService.canAdmin`
 *    (already implemented in workspace-service.ts:295). Not duplicated here.
 *
 * Per-user self-service handlers do not call these helpers; they force
 * `userId = ctx.userId` in the query.
 */

import type { Db } from "mongodb"
import { HandlerError } from "../ws-framework/WsRouter"

/**
 * Require the caller to be a system admin (`role: 'admin'` or `'super'`).
 *
 * Throws HandlerError('FORBIDDEN') otherwise.
 *
 * This replaces the ad-hoc `requireAdmin(db, userId)` previously inlined in
 * admin-api/usage.ts, workspaces.ts, apps.ts, agents.ts, access.ts, catalog.ts,
 * mca-management.ts, system.ts. Single source of truth.
 */
export async function requireSystemAdmin(db: Db, userId: string): Promise<void> {
  const user = await db.collection("users").findOne({ userId })
  if (user?.role !== "admin" && user?.role !== "super") {
    throw new HandlerError("FORBIDDEN", "Admin privileges required")
  }
}

/**
 * Require the caller to be a super admin specifically.
 *
 * For destructive operations or role changes that 'admin' should not perform.
 */
export async function requireSuperAdmin(db: Db, userId: string): Promise<void> {
  const user = await db.collection("users").findOne({ userId })
  if (user?.role !== "super") {
    throw new HandlerError("FORBIDDEN", "Super admin privileges required")
  }
}

/**
 * Return the system role of the user, or null if not a system admin/super.
 *
 * Useful when the handler wants to behave differently depending on the role
 * level without raising.
 */
export async function getSystemRole(
  db: Db,
  userId: string,
): Promise<"admin" | "super" | null> {
  const user = await db.collection("users").findOne({ userId })
  if (user?.role === "admin" || user?.role === "super") {
    return user.role
  }
  return null
}
