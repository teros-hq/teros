/**
 * board.remove-agent — Remove an agent from a project's autoplay panel
 *
 * Deletes the agent_project_relationships record for the given agentId+projectId.
 * Also emits board_agent_config_removed so the frontend can remove the chip.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { BoardService } from '../../../services/board-service'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { AutoplayService } from '../../../services/autoplay-service'

interface RemoveAgentData {
  projectId: string
  agentId: string
}

export function createRemoveAgentHandler(
  boardService: BoardService,
  workspaceService: WorkspaceService,
  autoplayService: AutoplayService,
) {
  return async function removeAgent(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as RemoveAgentData
    const { projectId, agentId } = data

    if (!projectId || !agentId) {
      throw new HandlerError('MISSING_FIELDS', 'projectId and agentId are required')
    }

    const project = await boardService.getProject(projectId)
    if (!project) {
      throw new HandlerError('NOT_FOUND', 'Project not found')
    }

    const role = await workspaceService.getUserRole(project.workspaceId, ctx.userId)
    if (role !== 'owner' && role !== 'admin' && role !== 'write') {
      throw new HandlerError('FORBIDDEN', 'Only managers can remove agents from a project')
    }

    await autoplayService.removeRelationship(projectId, agentId)

    return { projectId, agentId, removed: true }
  }
}
