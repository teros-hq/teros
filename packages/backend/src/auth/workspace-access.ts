/**
 * Workspace access helpers — single source of truth for membership/ownership checks.
 *
 * Used by both HTTP and WebSocket handlers. Keeping the canonical implementation
 * here ensures both transports apply the same authz rules.
 */

import type { Db } from 'mongodb'

export async function getUserWorkspaceIds(db: Db, userId: string): Promise<string[]> {
  const memberships = await db.collection('workspace_members').find({ userId }).toArray()
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

  // Check if member
  const membership = await db.collection('workspace_members').findOne({ workspaceId, userId })
  return !!membership
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
