/**
 * Feedback Service
 *
 * Persists message-level and conversation-level feedback, plus logged
 * message actions (copy/report). Emits events through PubSubService so
 * other sessions can reflect feedback state in real time.
 */

import type { Db, Collection } from 'mongodb'
import type { MessageFeedback, MessageAction, ConversationFeedback } from '../types/database'
import type { PubSubService } from './pubsub-service'
import { createLogger } from '../lib/logger'

const log = createLogger('FeedbackService')

export type MessageFeedbackRating = 'up' | 'down'

export type MessageFeedbackReason =
  | 'inaccurate'
  | 'incomplete'
  | 'not_helpful'
  | 'wrong_tone'
  | 'did_not_follow_instructions'
  | 'other'

export interface UpsertMessageFeedbackInput {
  messageId: string
  conversationId: string
  workspaceId: string
  userId: string
  agentId: string
  rating: MessageFeedbackRating
  reasons?: MessageFeedbackReason[]
  comment?: string
}

export interface LogMessageActionInput {
  messageId: string
  conversationId: string
  workspaceId: string
  userId: string
  action: 'copy' | 'report'
  context?: Record<string, unknown>
}

export interface CreateConversationFeedbackInput {
  conversationId: string
  workspaceId: string
  userId: string
  rating: number | 'up' | 'down'
  solvedProblem?: boolean
  comment?: string
}

export class FeedbackService {
  private feedbackCollection: Collection<MessageFeedback>
  private actionsCollection: Collection<MessageAction>
  private conversationFeedbackCollection: Collection<ConversationFeedback>

  constructor(
    private db: Db,
    private pubSubService: PubSubService | null,
  ) {
    this.feedbackCollection = this.db.collection<MessageFeedback>('message_feedback')
    this.actionsCollection = this.db.collection<MessageAction>('message_actions')
    this.conversationFeedbackCollection = this.db.collection<ConversationFeedback>('conversation_feedback')
  }

  // ============================================================================
  // INDEXES
  // ============================================================================

  async ensureIndexes(): Promise<void> {
    // Message feedback: one row per (messageId, userId)
    await this.feedbackCollection.createIndex(
      { messageId: 1, userId: 1 },
      { unique: true, background: true },
    )
    await this.feedbackCollection.createIndex(
      { conversationId: 1, createdAt: -1 },
      { background: true },
    )
    await this.feedbackCollection.createIndex(
      { agentId: 1, createdAt: -1 },
      { background: true },
    )

    // Message actions: append-only log
    await this.actionsCollection.createIndex(
      { messageId: 1, createdAt: -1 },
      { background: true },
    )
    await this.actionsCollection.createIndex(
      { conversationId: 1, createdAt: -1 },
      { background: true },
    )

    // Conversation feedback: one row per (conversationId, userId)
    await this.conversationFeedbackCollection.createIndex(
      { conversationId: 1, userId: 1 },
      { unique: true, background: true },
    )
    await this.conversationFeedbackCollection.createIndex(
      { workspaceId: 1, createdAt: -1 },
      { background: true },
    )

    log.info('FeedbackService indexes ensured')
  }

  // ============================================================================
  // MESSAGE FEEDBACK
  // ============================================================================

  async upsertMessageFeedback(input: UpsertMessageFeedbackInput): Promise<MessageFeedback> {
    const now = new Date()
    const sanitizedComment = input.comment ? input.comment.trim().slice(0, 2000) : undefined

    const update: Partial<MessageFeedback> = {
      rating: input.rating,
      reasons: input.reasons,
      comment: sanitizedComment,
      updatedAt: now,
    }

    // Atomic upsert keyed on the unique (messageId, userId) index. A single
    // findOneAndUpdate with upsert eliminates the find-then-insert race: two
    // concurrent first-time votes can no longer both miss and then collide on
    // the unique index (which would surface a duplicate-key error to one user).
    // Mutable fields go in $set; immutable creation fields in $setOnInsert.
    const feedback = await this.feedbackCollection.findOneAndUpdate(
      { messageId: input.messageId, userId: input.userId },
      {
        $set: update,
        $setOnInsert: {
          feedbackId: this.generateFeedbackId(),
          conversationId: input.conversationId,
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          createdAt: now,
        },
      },
      { returnDocument: 'after', upsert: true },
    )

    if (!feedback) {
      // With upsert: true + returnDocument: 'after', Mongo always returns the
      // resulting document. A null here would mean a contract violation.
      throw new Error('upsertMessageFeedback: findOneAndUpdate returned null despite upsert')
    }

    this.broadcastFeedbackCreated(feedback)
    return feedback
  }

  async getMessageFeedback(messageId: string, userId: string): Promise<MessageFeedback | null> {
    return this.feedbackCollection.findOne({ messageId, userId })
  }

  // ============================================================================
  // MESSAGE ACTIONS
  // ============================================================================

  async logMessageAction(input: LogMessageActionInput): Promise<MessageAction> {
    const now = new Date()
    const action: MessageAction = {
      actionId: this.generateActionId(),
      messageId: input.messageId,
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      action: input.action,
      context: input.context,
      createdAt: now,
    }

    await this.actionsCollection.insertOne(action)
    this.broadcastActionExecuted(action)
    return action
  }

  // ============================================================================
  // CONVERSATION FEEDBACK
  // ============================================================================

  async createConversationFeedback(input: CreateConversationFeedbackInput): Promise<ConversationFeedback> {
    const now = new Date()
    const sanitizedComment = input.comment ? input.comment.trim().slice(0, 2000) : undefined

    const feedback: ConversationFeedback = {
      conversationFeedbackId: this.generateConversationFeedbackId(),
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      rating: input.rating,
      solvedProblem: input.solvedProblem,
      comment: sanitizedComment,
      createdAt: now,
    }

    await this.conversationFeedbackCollection.insertOne(feedback)
    return feedback
  }

  // ============================================================================
  // EVENT PUBLISHING
  // ============================================================================

  private broadcastFeedbackCreated(feedback: MessageFeedback): void {
    if (!this.pubSubService) return

    this.pubSubService.broadcastToTopic(`channel:${feedback.conversationId}`, {
      type: 'conversation.message.feedback.created',
      channelId: feedback.conversationId,
      messageId: feedback.messageId,
      userId: feedback.userId,
      rating: feedback.rating,
      reasons: feedback.reasons,
      hasComment: !!feedback.comment,
      createdAt: feedback.createdAt.toISOString(),
    })
  }

  private broadcastActionExecuted(action: MessageAction): void {
    if (!this.pubSubService) return

    this.pubSubService.broadcastToTopic(`channel:${action.conversationId}`, {
      type: 'conversation.message.action.executed',
      channelId: action.conversationId,
      messageId: action.messageId,
      userId: action.userId,
      action: action.action,
      actionId: action.actionId,
      createdAt: action.createdAt.toISOString(),
    })
  }

  // ============================================================================
  // ID GENERATION
  // ============================================================================

  private generateFeedbackId(): string {
    return `fb_${this.generateUuid()}`
  }

  private generateActionId(): string {
    return `act_${this.generateUuid()}`
  }

  private generateConversationFeedbackId(): string {
    return `cfb_${this.generateUuid()}`
  }

  private generateUuid(): string {
    return crypto.randomUUID()
  }
}
