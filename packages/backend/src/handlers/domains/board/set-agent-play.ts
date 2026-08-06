/**
 * board.set-agent-play — Activate or deactivate autoplay mode for an agent
 *
 * Rejects if enabling play with 0 slots.
 * When enabled, immediately triggers the scheduling cycle.
 * When disabled, does NOT cancel in-progress tasks.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { BoardService } from '../../../services/board-service'
import type { BoardSubscriptionService } from '../../../services/board-subscription-service'
import { BoardSubscriptionService as BSS } from '../../../services/board-subscription-service'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { AutoplayService } from '../../../services/autoplay-service'

interface SetAgentPlayData {
  projectId: string
  agentId: string
  enabled: boolean
}

export function createSetAgentPlayHandler(
  boardService: BoardService,
  workspaceService: WorkspaceService,
  autoplayService: AutoplayService,
  boardSubscriptionService?: BoardSubscriptionService,
) {
  return async function setAgentPlay(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as SetAgentPlayData
    const { projectId, agentId, enabled } = data

    if (!projectId || !agentId || enabled === undefined || enabled === null) {
      throw new HandlerError('MISSING_FIELDS', 'projectId, agentId, and enabled are required')
    }

    if (typeof enabled !== 'boolean') {
      throw new HandlerError('INVALID_FIELDS', 'enabled must be a boolean')
    }

    const project = await boardService.getProject(projectId)
    if (!project) {
      throw new HandlerError('NOT_FOUND', 'Project not found')
    }

    // Only managers can control play state
    const role = await workspaceService.getUserRole(project.workspaceId, ctx.userId)
    if (role !== 'owner' && role !== 'admin' && role !== 'write') {
      throw new HandlerError('FORBIDDEN', 'Only managers can control agent play state')
    }

    let rel
    try {
      rel = await autoplayService.setAgentPlay(projectId, agentId, enabled)
    } catch (err: any) {
      if (err.message?.startsWith('INVALID_STATE')) {
        throw new HandlerError('INVALID_STATE', err.message.replace('INVALID_STATE: ', ''))
      }
      throw err
    }

    // Emit WebSocket event
    await autoplayService.emitAgentConfigUpdated(project.boardId, projectId, agentId, rel)

    // Emit board.agent_play_changed to subscribers
    if (boardSubscriptionService) {
      const payload = { agentId, playEnabled: enabled, slots: rel.slots }
      boardSubscriptionService.notifySubscribers(project.boardId, {
        eventType: 'board.agent_play_changed',
        boardId: project.boardId,
        formattedMessage: BSS.formatEventMessage({ eventType: 'board.agent_play_changed', boardId: project.boardId, payload }),
        payload,
      })
    }

    // If enabling play, trigger scheduling immediately
    if (enabled) {
      autoplayService.scheduleAgentTasks(projectId, agentId)

      // Ensure periodic scheduler is running (lazy init)
      autoplayService.startPeriodicScheduler()
    }

    return { relationship: rel }
  }
}
