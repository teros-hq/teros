/**
 * project.list — List all projects in a workspace
 */

import type { Db } from 'mongodb'
import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { ProjectService } from '../../../services/project-service'
import { canAccessWorkspace } from '../../../auth/workspace-access'

interface ListProjectsData {
  workspaceId: string
}

export function createListProjectsHandler(projectService: ProjectService, db: Db) {
  return async function listProjects(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as ListProjectsData
    const { workspaceId } = data

    if (!workspaceId) {
      throw new HandlerError('MISSING_WORKSPACE_ID', 'workspaceId is required')
    }

    if (!(await canAccessWorkspace(db, ctx.userId, workspaceId))) {
      throw new HandlerError('FORBIDDEN', 'No access to this workspace')
    }

    const projects = await projectService.list(workspaceId)

    return { projects }
  }
}
