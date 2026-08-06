/**
 * board.set-agent-slots — Configure the number of parallel execution slots for an agent
 *
 * Slots = 0 → autoplay disabled (play button hidden in UI)
 * Slots ≥ 1 → autoplay available
 *
 * If slots=0 and playEnabled=true, also disables play.
 * If slots>0 and playEnabled=true, triggers scheduling (new capacity).
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { BoardService } from '../../../services/board-service'
import type { BoardSubscriptionService } from '../../../services/board-subscription-service'
import { BoardSubscriptionService as BSS } from '../../../services/board-subscription-service'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { AutoplayService } from '../../../services/autoplay-service'
import type { PubSubService } from '../../../services/pubsub-service'

interface SetAgentSlotsData {
  projectId: string
  agentId: string
  slots: number
}

export function createSetAgentSlotsHandler(
  boardService: BoardService,
  workspaceService: WorkspaceService,
  autoplayService: AutoplayService,
  pubSubService: PubSubService,
  boardSubscriptionService?: BoardSubscriptionService,
) {
  return async function setAgentSlots(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as SetAgentSlotsData
    const { projectId, agentId, slots } = data

    if (!projectId || !agentId || slots === undefined || slots === null) {
      throw new HandlerError('MISSING_FIELDS', 'projectId, agentId, and slots are required')
    }

    if (typeof slots !== 'number' || slots < 0 || !Number.isInteger(slots)) {
      throw new HandlerError('INVALID_FIELDS', 'slots must be a non-negative integer')
    }

    const project = await boardService.getProject(projectId)
    if (!project) {
      throw new HandlerError('NOT_FOUND', 'Project not found')
    }

    // Only managers can configure slots
    const role = await workspaceService.getUserRole(project.workspaceId, ctx.userId)
    if (role !== 'owner' && role !== 'admin' && role !== 'write') {
      throw new HandlerError('FORBIDDEN', 'Only managers can configure agent slots')
    }

    const rel = await autoplayService.setAgentSlots(projectId, agentId, slots)

    // Emit WebSocket event
    await autoplayService.emitAgentConfigUpdated(project.boardId, projectId, agentId, rel)

    // Emit board.agent_slots_changed to subscribers
    if (boardSubscriptionService) {
      const payload = { agentId, slots, playEnabled: rel.playEnabled }
      boardSubscriptionService.notifySubscribers(project.boardId, {
        eventType: 'board.agent_slots_changed',
        boardId: project.boardId,
        formattedMessage: BSS.formatEventMessage({ eventType: 'board.agent_slots_changed', boardId: project.boardId, payload }),
        payload,
      })
    }

    // If slots > 0 and playEnabled, trigger scheduling (new capacity may be available)
    if (slots > 0 && rel.playEnabled) {
      autoplayService.scheduleAgentTasks(projectId, agentId)
    }

    return { relationship: rel }
  }
}
