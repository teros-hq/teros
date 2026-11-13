import type { AgentPrincipal, MemberPrincipal, MemberRole } from "@teros/shared"
import type { Db } from "mongodb"
import { COLLECTIONS, collection } from "../../db"

const MEMBER_ROLES: readonly MemberRole[] = ["admin", "write", "read"]

export async function memberRole(
  db: Db,
  userId: string,
  workspaceId: string,
): Promise<MemberRole | null> {
  const workspace = await collection(db, COLLECTIONS.workspaces).findOne({
    workspaceId,
    status: "active",
  })
  if (!workspace) return null
  if (workspace.ownerId === userId) return "owner"
  const membership = await collection(db, COLLECTIONS.workspaceMembers).findOne({
    workspaceId,
    userId,
  })
  if (!membership || (membership.status ?? "active") !== "active") return null
  const role = membership.role as MemberRole
  return MEMBER_ROLES.includes(role) ? role : "read"
}

export async function memberPrincipal(
  db: Db,
  userId: string,
  workspaceId: string,
): Promise<MemberPrincipal> {
  return { kind: "member", userId, workspaceId, role: await memberRole(db, userId, workspaceId) }
}

export function agentPrincipal(workspaceId: string | null | undefined): AgentPrincipal {
  return { kind: "agent", workspaces: workspaceId ? [workspaceId] : [] }
}
