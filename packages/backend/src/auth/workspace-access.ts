/**
 * Workspace access helpers — single source of truth for membership/ownership checks.
 *
 * Used by both HTTP and WebSocket handlers. Keeping the canonical implementation
 * here ensures both transports apply the same authz rules.
 */

import type { Db } from 'mongodb'
import { COLLECTIONS, collection } from '../db'

export async function getUserWorkspaceIds(db: Db, userId: string): Promise<string[]> {
  // Pending invitations don't grant access (same rule as canAccessWorkspace)
  const memberships = await db
    .collection('workspace_members')
    .find({ userId, status: { $ne: 'pending' } })
    .toArray()
  const workspaceIds = memberships.map((m) => m.workspaceId)
  if (workspaceIds.length === 0) return []

  // Only active workspaces are accessible — keep this in sync with the
  // status guard in canAccessWorkspace so both authz paths agree on what
  // "a workspace the user can access" means (archived → no access).
  const activeWorkspaces = await db
    .collection('workspaces')
    .find({ workspaceId: { $in: workspaceIds }, status: 'active' })
    .project({ workspaceId: 1, _id: 0 })
    .toArray()
  return activeWorkspaces.map((w) => w.workspaceId)
}

export async function canAccessWorkspace(db: Db, userId: string, workspaceId: string): Promise<boolean> {
  // Workspace must be active
  const workspace = await db.collection('workspaces').findOne({ workspaceId, status: 'active' })
  if (!workspace) return false

  // Check if owner
  if (workspace.ownerId === userId) return true

  // Check if member in the workspace_members collection (single source of truth)
  // MUW-14: must be active, not pending
  const membership = await db.collection('workspace_members').findOne({ workspaceId, userId })
  if (membership) {
    const status = membership.status ?? 'active' // backward compat: no status = active
    return status === 'active'
  }

  return false
}

/**
 * Write access: owner, or an active member with role 'admin' or 'write'.
 * Mirrors WorkspaceService.canWrite (a member without a role is read-only)
 * for handlers that only get a Db.
 */
export async function canWriteWorkspace(db: Db, userId: string, workspaceId: string): Promise<boolean> {
  const workspace = await db.collection('workspaces').findOne({ workspaceId, status: 'active' })
  if (!workspace) return false
  if (workspace.ownerId === userId) return true

  const membership = await db.collection('workspace_members').findOne({ workspaceId, userId })
  if (!membership) return false
  if ((membership.status ?? 'active') !== 'active') return false
  return membership.role === 'admin' || membership.role === 'write'
}

export async function canAccessAgent(db: Db, userId: string, agentId: string): Promise<boolean> {
  const agent = await db.collection('agents').findOne({ agentId })
  if (!agent) return false

  // Global agent owned by user
  if (!agent.workspaceId && agent.ownerId === userId) return true

  // Workspace agent — check workspace access
  if (agent.workspaceId) {
    return canAccessWorkspace(db, userId, agent.workspaceId)
  }

  return false
}

export async function canAccessApp(db: Db, userId: string, appId: string): Promise<boolean> {
  const app = await db.collection('apps').findOne({ appId })
  if (!app) return false

  // Legacy user-owned app (deprecated — all apps are now workspace-owned)
  if (app.ownerType === 'user' && app.ownerId === userId) return true

  // Workspace-owned app — check workspace access
  if (app.ownerType === 'workspace') {
    return canAccessWorkspace(db, userId, app.ownerId)
  }

  return false
}

/**
 * May this user read (or write) the workspace volume behind a file context?
 *
 * fs.list / fs.write / file.watch take a client-supplied `workspaceId` or
 * `channelId` and hand it to resolveVolumeHostPath, which never looked at the
 * caller. Authorize the SAME id the resolver will use, with its same rule
 * (`work_` / `ws_` prefix → workspace, anything else → that channel's
 * workspace): the volume belongs to the workspace, so workspace access is the
 * gate — read for listing/watching, the write role for writing.
 */
export async function canUseVolumeContext(
  db: Db,
  userId: string,
  contextId: string,
  mode: 'read' | 'write',
): Promise<boolean> {
  let workspaceId: string | undefined
  if (contextId.startsWith('work_') || contextId.startsWith('ws_')) {
    workspaceId = contextId
  } else {
    const channel = await collection(db, COLLECTIONS.channels).findOne(
      { channelId: contextId },
      { projection: { workspaceId: 1 } },
    )
    workspaceId = typeof channel?.workspaceId === 'string' ? channel.workspaceId : undefined
  }
  if (!workspaceId) return false
  return mode === 'write'
    ? canWriteWorkspace(db, userId, workspaceId)
    : canAccessWorkspace(db, userId, workspaceId)
}
