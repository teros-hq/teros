/**
 * project.update — Update project fields (name, description, context)
 */

import type { Db } from 'mongodb'
import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { ProjectService } from '../../../services/project-service'
import { canAccessWorkspace } from '../../../auth/workspace-access'

interface UpdateProjectData {
  projectId: string
  name?: string
  description?: string
  context?: string
}

export function createUpdateProjectHandler(projectService: ProjectService, db: Db) {
  return async function updateProject(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as UpdateProjectData
    const { projectId, name, description, context } = data

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

    const project = await projectService.update(projectId, { name, description, context })

    if (!project) {
      throw new HandlerError('PROJECT_NOT_FOUND', `Project ${projectId} not found`)
    }

    console.log(`✅ Updated project ${project.projectId} ("${project.name}")`)

    return { project }
  }
}
