/**
 * project.get — Get a project by ID
 */

import type { Db } from 'mongodb'
import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { ProjectService } from '../../../services/project-service'
import { canAccessWorkspace } from '../../../auth/workspace-access'

interface GetProjectData {
  projectId: string
}

export function createGetProjectHandler(projectService: ProjectService, db: Db) {
  return async function getProject(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as GetProjectData
    const { projectId } = data

    if (!projectId) {
      throw new HandlerError('MISSING_PROJECT_ID', 'projectId is required')
    }

    const project = await projectService.get(projectId)

    if (!project) {
      throw new HandlerError('PROJECT_NOT_FOUND', `Project ${projectId} not found`)
    }

    if (!(await canAccessWorkspace(db, ctx.userId, project.workspaceId))) {
      throw new HandlerError('FORBIDDEN', 'No access to this project')
    }

    return { project }
  }
}
