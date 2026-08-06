/**
 * project.create — Create a new project in a workspace
 */

import type { Db } from 'mongodb'
import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { ProjectService } from '../../../services/project-service'
import { canAccessWorkspace } from '../../../auth/workspace-access'

interface CreateProjectData {
  workspaceId: string
  name: string
  boardId: string
  description?: string
  context?: string
}

export function createCreateProjectHandler(projectService: ProjectService, db: Db) {
  return async function createProject(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as CreateProjectData
    const { workspaceId, name, boardId, description, context } = data

    if (!workspaceId) {
      throw new HandlerError('MISSING_WORKSPACE_ID', 'workspaceId is required')
    }
    if (!name) {
      throw new HandlerError('MISSING_NAME', 'name is required')
    }
    if (!boardId) {
      throw new HandlerError('MISSING_BOARD_ID', 'boardId is required')
    }

    if (!(await canAccessWorkspace(db, ctx.userId, workspaceId))) {
      throw new HandlerError('FORBIDDEN', 'No access to this workspace')
    }

    const project = await projectService.create(workspaceId, ctx.userId, {
      name,
      boardId,
      description,
      context,
    })

    console.log(`✅ Created project ${project.projectId} ("${project.name}") in workspace ${workspaceId}`)

    return { project }
  }
}
