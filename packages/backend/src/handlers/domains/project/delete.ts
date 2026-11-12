/**
 * project.delete — Delete a project
 */

import type { Db } from 'mongodb'
import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { ProjectService } from '../../../services/project-service'
import { canAccessWorkspace } from '../../../auth/workspace-access'

/** Owner, or an active member with the admin role. */
async function canAdminWorkspace(db: Db, userId: string, workspaceId: string): Promise<boolean> {
  const workspace = await db.collection('workspaces').findOne({ workspaceId, status: 'active' })
  if (!workspace) return false
  if (workspace.ownerId === userId) return true
  const member = await db.collection('workspace_members').findOne({ workspaceId, userId })
  return !!member && (member.status ?? 'active') === 'active' && member.role === 'admin'
}

interface DeleteProjectData {
  projectId: string
}

export function createDeleteProjectHandler(projectService: ProjectService, db: Db) {
  return async function deleteProject(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as DeleteProjectData
    const { projectId } = data

    if (!projectId) {
      throw new HandlerError('MISSING_PROJECT_ID', 'projectId is required')
    }

    const existing = await projectService.get(projectId)
    if (!existing) {
      throw new HandlerError('PROJECT_NOT_FOUND', `Project ${projectId} not found`)
    }
    if (!(await canAccessWorkspace(db, ctx.userId, existing.workspaceId))) {
      throw new HandlerError('FORBIDDEN', 'No access to this project')
    }
    // Same rule as board.delete-project: deleting a project (board, tasks,
    // history) is for the workspace owner or an admin, not any member
    if (!(await canAdminWorkspace(db, ctx.userId, existing.workspaceId))) {
      throw new HandlerError('FORBIDDEN', 'Only workspace admin or owner can delete projects')
    }

    const deleted = await projectService.delete(projectId, ctx.userId)

    if (!deleted) {
      throw new HandlerError('PROJECT_NOT_FOUND', `Project ${projectId} not found`)
    }

    console.log(`✅ Deleted project ${projectId}`)

    return { ok: true }
  }
}
