/**
 * FeedbackApi — Typed client for message and conversation feedback.
 *
 * Exposes the backend feedback domain actions over the WsFramework transport.
 */

import type { Transport } from './transport/types'

export type MessageFeedbackRating = 'up' | 'down'

export type MessageFeedbackReason =
  | 'inaccurate'
  | 'incomplete'
  | 'not_helpful'
  | 'wrong_tone'
  | 'did_not_follow_instructions'
  | 'other'

export interface SubmitMessageFeedbackInput {
  messageId: string
  channelId: string
  rating: MessageFeedbackRating
  reasons?: MessageFeedbackReason[]
  comment?: string
}

export interface SubmitMessageActionInput {
  messageId: string
  channelId: string
  action: 'copy' | 'report'
  description?: string
  attachmentUrl?: string
}

export interface SubmitConversationFeedbackInput {
  channelId: string
  rating: number | MessageFeedbackRating
  solvedProblem?: boolean
  comment?: string
}

export interface MessageFeedbackResponse {
  feedbackId: string
  messageId: string
  rating: MessageFeedbackRating
  createdAt: string
}

export interface MessageActionResponse {
  actionId: string
  action: 'copy' | 'report'
  bugReportId?: string
  createdAt: string
}

export interface ConversationFeedbackResponse {
  conversationFeedbackId: string
  conversationId: string
  rating: number | MessageFeedbackRating
  createdAt: string
}

export class FeedbackApi {
  constructor(private readonly transport: Transport) {}

  submitMessageFeedback(data: SubmitMessageFeedbackInput): Promise<MessageFeedbackResponse> {
    return this.transport.request('conversation.message.feedback', data as unknown as Record<string, unknown>)
  }

  submitMessageAction(data: SubmitMessageActionInput): Promise<MessageActionResponse> {
    return this.transport.request('conversation.message.action', data as unknown as Record<string, unknown>)
  }

  submitConversationFeedback(data: SubmitConversationFeedbackInput): Promise<ConversationFeedbackResponse> {
    return this.transport.request('conversation.feedback', data as unknown as Record<string, unknown>)
  }
}
