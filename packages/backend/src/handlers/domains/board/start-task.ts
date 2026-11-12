/**
 * board.start-task — Start a task: move to in_progress, create/reuse channel, send initial message
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { BoardService } from '../../../services/board-service'
import { buildTaskInitialMessage, SYSTEM_SENDER } from '../../../services/board-service'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { PubSubService } from '../../../services/pubsub-service'
import type { ChannelManager } from '../../../services/channel-manager'
import type { MessageHandler } from '../../message-handler'

interface StartTaskData {
  taskId: string
  agentId?: string
  prompt?: string
}

export function createStartTaskHandler(
  boardService: BoardService,
  workspaceService: WorkspaceService,
  pubSubService: PubSubService,
  channelManager: ChannelManager,
  messageHandler: MessageHandler,
) {
  return async function startTask(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as StartTaskData
    const { taskId, agentId, prompt } = data

    if (!taskId) {
      throw new HandlerError('MISSING_FIELDS', 'taskId is required')
    }

    const existing = await boardService.getTask(taskId)
    if (!existing) {
      throw new HandlerError('NOT_FOUND', 'Task not found')
    }

    const board = await boardService.getBoard(existing.boardId)
    const project = board ? await boardService.getProject(board.projectId) : null
    if (!project) {
      throw new HandlerError('NOT_FOUND', 'Project not found')
    }

    const role = await workspaceService.getUserRole(project.workspaceId, ctx.userId)
    if (role !== 'owner' && role !== 'admin' && role !== 'write') {
      throw new HandlerError('FORBIDDEN', 'No write access')
    }

    // Start task (move to in_progress, assign agent)
    const { task } = await boardService.startTask(taskId, ctx.userId, agentId)
    const assignedAgentId = task.assignedAgentId!

    // Reuse existing conversation or create a new one
    let channel: any
    if (task.channelId) {
      channel = await channelManager.getChannel(task.channelId)
    }
    if (!channel) {
      // TER-157: Board task channels are headless — no human is watching directly.
      // Without headless, tools with 'ask' permission block the turn indefinitely
      // waiting for a human who never comes. The agent will get an auto-deny message
      // and can either find an alternative or block the task with a note explaining
      // what permission is needed.
      channel = await channelManager.createChannel(ctx.userId, assignedAgentId, {
        name: task.title,
      }, {
        workspaceId: project.workspaceId,
        headless: true,
      })
      await boardService.linkConversation(task.taskId, ctx.userId, channel.channelId)
      // REQ-3: Board-linked channels are auto-shared (set by linkConversation handler,
      // but start-task calls boardService directly — set it here too).
      await channelManager.setChannelScope(channel.channelId, 'shared')
    } else {
      // Existing channel being reused — ensure it's public for board scope (REQ-3)
      await channelManager.setChannelScope(channel.channelId, 'shared')
    }

    // Build initial message for the agent
    const initialMessage = buildTaskInitialMessage(task, prompt)

    const startedFullTask = { ...task, channelId: channel.channelId }

    pubSubService.broadcastToTopic(`board:${task.boardId}`, { type: 'board_task_updated', task: startedFullTask })

    // Send the initial message to trigger the agent (fire-and-forget)
    // Save message directly and call processAgentResponse to avoid broadcast issues
    // when the channel has no subscribers yet.
    ;(async () => {
      try {
        const msgId = channelManager.createMessageId()
        const msgTimestamp = new Date().toISOString()
        const sender = SYSTEM_SENDER

        await channelManager.saveMessage({
          messageId: msgId,
          channelId: channel.channelId,
          role: 'user' as const,
          userId: ctx.userId,
          sender,
          content: { type: 'text' as const, text: initialMessage },
          timestamp: msgTimestamp,
        })

        await messageHandler.processAgentResponse(
          channel.channelId,
          assignedAgentId,
          initialMessage,
          undefined,
          undefined,
          'autorun',
        )
      } catch (err: any) {
        console.error(`❌ Error sending initial task message to ${channel.channelId}:`, err)
      }
    })()

    return { task: startedFullTask, channelId: channel.channelId }
  }
}
