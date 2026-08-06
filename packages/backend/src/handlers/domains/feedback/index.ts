/**
 * Feedback domain — registers message and conversation feedback handlers.
 *
 * Actions:
 *   conversation.message.feedback  → Upsert thumbs up/down on a message
 *   conversation.message.action    → Log copy/report action on a message
 *   conversation.feedback          → Submit end-of-conversation rating
 */

import type { Db } from 'mongodb'
import type { WsHandlerContext } from '@teros/shared'
import type { WsRouter } from '../../../ws-framework/WsRouter'
import { HandlerError } from '../../../ws-framework/WsRouter'
import { canAccessWorkspace } from '../../../auth/workspace-access'
import { FeedbackService, type MessageFeedbackReason } from '../../../services/feedback-service'
import type { LatitudeScoreEmitter } from '../../../services/latitude-score-emitter'
import type { McaManager } from '../../../services/mca-manager'
import type { PubSubService } from '../../../services/pubsub-service'
import { config } from '../../../config'

// ============================================================================
// TYPES
// ============================================================================

interface MessageFeedbackData {
  messageId: string
  channelId: string
  rating: 'up' | 'down'
  reasons?: MessageFeedbackReason[]
  comment?: string
}

interface MessageActionData {
  messageId: string
  channelId: string
  action: 'copy' | 'report'
  description?: string
  attachmentUrl?: string
}

interface ConversationFeedbackData {
  channelId: string
  rating: number | 'up' | 'down'
  solvedProblem?: boolean
  comment?: string
}

interface ChannelDoc {
  channelId: string
  workspaceId: string
  agentId: string
  userId: string
}

interface MessageDoc {
  messageId: string
  channelId: string
  role: 'user' | 'assistant' | 'system'
  agentId?: string
  userId?: string
  content?: any
}

// ============================================================================
// DOMAIN DEPS
// ============================================================================

export interface FeedbackDomainDeps {
  db: Db
  feedbackService: FeedbackService
  mcaManager: McaManager
  pubSubService: PubSubService | null
  /** F4·C0 — optional Latitude score emitter. Null when the emitter is not wired. */
  latitudeScoreEmitter?: LatitudeScoreEmitter | null
}

// ============================================================================
// SHARED HELPERS
// ============================================================================

async function resolveAuthorizedChannel(
  db: Db,
  userId: string,
  channelId: string,
): Promise<ChannelDoc> {
  const channel = await db.collection<ChannelDoc>('channels').findOne({ channelId })
  if (!channel) {
    throw new HandlerError('CHANNEL_NOT_FOUND', `Channel not found: ${channelId}`)
  }
  if (!channel.workspaceId) {
    throw new HandlerError('NO_WORKSPACE', `Channel ${channelId} has no associated workspace`)
  }
  if (channel.userId !== userId && !(await canAccessWorkspace(db, userId, channel.workspaceId))) {
    throw new HandlerError('FORBIDDEN_WORKSPACE', `No access to workspace ${channel.workspaceId}`)
  }
  return channel
}

async function getAssistantMessage(
  db: Db,
  messageId: string,
  channelId: string,
): Promise<MessageDoc> {
  const message = await db.collection<MessageDoc>('channel_messages').findOne({ messageId, channelId })
  if (!message) {
    throw new HandlerError('MESSAGE_NOT_FOUND', `Message not found: ${messageId}`)
  }
  if (message.role !== 'assistant') {
    throw new HandlerError('INVALID_MESSAGE', 'Feedback can only be submitted for assistant messages')
  }
  return message
}

function buildMessageLink(channelId: string, messageId: string): string {
  const baseUrl = config.share.baseUrl
  return `${baseUrl}/chat/${channelId}?messageId=${messageId}`
}

function buildConversationLink(channelId: string): string {
  const baseUrl = config.share.baseUrl
  return `${baseUrl}/chat/${channelId}`
}

// ============================================================================
// HANDLER FACTORIES
// ============================================================================

function createMessageFeedbackHandler(deps: FeedbackDomainDeps) {
  const { db, feedbackService } = deps

  return async function messageFeedback(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as MessageFeedbackData
    const { messageId, channelId, rating, reasons, comment } = data

    if (!messageId) throw new HandlerError('MISSING_FIELDS', 'messageId is required')
    if (!channelId) throw new HandlerError('MISSING_FIELDS', 'channelId is required')
    if (!rating || (rating !== 'up' && rating !== 'down')) {
      throw new HandlerError('INVALID_RATING', 'rating must be "up" or "down"')
    }

    const channel = await resolveAuthorizedChannel(db, ctx.userId, channelId)
    const message = await getAssistantMessage(db, messageId, channelId)

    const feedback = await feedbackService.upsertMessageFeedback({
      messageId,
      conversationId: channelId,
      workspaceId: channel.workspaceId,
      userId: ctx.userId,
      agentId: message.agentId ?? channel.agentId,
      rating,
      reasons,
      comment,
    })

    // F4·C0 — mirror a 👎 as a categorical Latitude score (fire-and-forget; the
    // emitter no-ops on 👍). Only the token leaves — never `reasons`/`comment`.
    deps.latitudeScoreEmitter?.emitMessageFeedback({ messageId, rating })

    return {
      feedbackId: feedback.feedbackId,
      messageId: feedback.messageId,
      rating: feedback.rating,
      createdAt: feedback.createdAt.toISOString(),
    }
  }
}

function createMessageActionHandler(deps: FeedbackDomainDeps) {
  const { db, feedbackService, mcaManager } = deps

  return async function messageAction(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as MessageActionData
    const { messageId, channelId, action, description, attachmentUrl } = data

    if (!messageId) throw new HandlerError('MISSING_FIELDS', 'messageId is required')
    if (!channelId) throw new HandlerError('MISSING_FIELDS', 'channelId is required')
    if (!action || (action !== 'copy' && action !== 'report')) {
      throw new HandlerError('INVALID_ACTION', 'action must be "copy" or "report"')
    }

    const channel = await resolveAuthorizedChannel(db, ctx.userId, channelId)

    let bugReportId: string | undefined

    if (action === 'report') {
      await getAssistantMessage(db, messageId, channelId)
      if (!description || !description.trim()) {
        throw new HandlerError('MISSING_FIELDS', 'description is required for report actions')
      }

      const feedbackApp = await db.collection<{ appId: string; name: string }>('apps').findOne({
        mcaId: 'mca.teros.feedback',
        ownerId: channel.workspaceId,
        status: 'active',
      })
      if (!feedbackApp) {
        throw new HandlerError('FEEDBACK_APP_NOT_FOUND', 'Feedback app is not installed in this workspace')
      }

      const messageLink = buildMessageLink(channelId, messageId)
      const conversationLink = buildConversationLink(channelId)
      const reportDescription = `Reported message: ${messageLink}\nConversation: ${conversationLink}\nAttachment: ${attachmentUrl ?? 'none'}\n\n${description.trim()}`

      try {
        const result = await mcaManager.executeTool(
          `${feedbackApp.name}_report-bug`,
          {
            title: `Message report: ${messageId}`,
            description: reportDescription,
            severity: 'medium',
          },
          {
            appId: feedbackApp.appId,
            userId: ctx.userId,
            workspaceId: channel.workspaceId,
            channelId,
          },
        )

        if (result.isError) {
          throw new Error(result.output)
        }

        const parsed = safeJsonParse(result.output)
        bugReportId = parsed?.bugReportId ?? parsed?.id ?? undefined
      } catch (err: any) {
        console.error(`[FeedbackDomain] Failed to report bug for message ${messageId}:`, err.message)
        throw new HandlerError('REPORT_FAILED', 'Failed to submit report. Please try again later.')
      }
    }

    const loggedAction = await feedbackService.logMessageAction({
      messageId,
      conversationId: channelId,
      workspaceId: channel.workspaceId,
      userId: ctx.userId,
      action,
      context: {
        bugReportId,
        attachmentUrl,
        ...(action === 'report' && { description: description?.trim() }),
      },
    })

    return {
      actionId: loggedAction.actionId,
      action: loggedAction.action,
      bugReportId,
      createdAt: loggedAction.createdAt.toISOString(),
    }
  }
}

function createConversationFeedbackHandler(deps: FeedbackDomainDeps) {
  const { db, feedbackService } = deps

  return async function conversationFeedback(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as ConversationFeedbackData
    const { channelId, rating, solvedProblem, comment } = data

    if (!channelId) throw new HandlerError('MISSING_FIELDS', 'channelId is required')
    if (rating === undefined || rating === null) {
      throw new HandlerError('MISSING_FIELDS', 'rating is required')
    }
    if (typeof rating !== 'number' && rating !== 'up' && rating !== 'down') {
      throw new HandlerError('INVALID_RATING', 'rating must be a number, "up", or "down"')
    }

    const channel = await resolveAuthorizedChannel(db, ctx.userId, channelId)

    const feedback = await feedbackService.createConversationFeedback({
      conversationId: channelId,
      workspaceId: channel.workspaceId,
      userId: ctx.userId,
      rating,
      solvedProblem,
      comment,
    })

    return {
      conversationFeedbackId: feedback.conversationFeedbackId,
      conversationId: feedback.conversationId,
      rating: feedback.rating,
      createdAt: feedback.createdAt.toISOString(),
    }
  }
}

// ============================================================================
// REGISTRATION
// ============================================================================

export function register(router: WsRouter, deps: FeedbackDomainDeps): void {
  router.register('conversation.message.feedback', createMessageFeedbackHandler(deps))
  router.register('conversation.message.action', createMessageActionHandler(deps))
  router.register('conversation.feedback', createConversationFeedbackHandler(deps))
}

// ============================================================================
// UTILS
// ============================================================================

function safeJsonParse(value: string): any {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}
