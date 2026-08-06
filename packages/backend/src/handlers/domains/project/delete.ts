/**
 * project.delete — Delete a project
 */

import type { Db } from 'mongodb'
import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { ProjectService } from '../../../services/project-service'
import { canAccessWorkspace } from '../../../auth/workspace-access'

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

    const deleted = await projectService.delete(projectId)

    if (!deleted) {
      throw new HandlerError('PROJECT_NOT_FOUND', `Project ${projectId} not found`)
    }

    console.log(`✅ Deleted project ${projectId}`)

    return { ok: true }
  }
}
