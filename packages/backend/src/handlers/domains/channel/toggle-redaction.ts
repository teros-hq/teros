/**
 * channel.toggle-redaction — Mark or unmark a message as redacted (REQ-4).
 *
 * Authorization: canRedact (only the channel creator).
 * Non-creator → ACCESS_DENIED ("You do not have permission to perform this action").
 *
 * Available in both private and public conversations.
 * Broadcasts a `message_redacted` event to channel subscribers so the UI can update.
 * The broadcast contains NO message content — only the redaction state change.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import type { ChannelManager } from '../../../services/channel-manager'
import type { SessionManager } from '../../../services/session-manager'
import type { PubSubService } from '../../../services/pubsub-service'
import { canRedact } from '../../../auth/channel-permissions'

interface ToggleRedactionData {
  channelId: string
  messageId: string
  redacted: boolean // true to redact, false to un-redact
}

export function createToggleRedactionHandler(
  channelManager: ChannelManager,
  sessionManager: SessionManager,
  pubSubService: PubSubService,
  db: Db,
) {
  return async function toggleRedaction(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as ToggleRedactionData

    if (!data.channelId) {
      throw new HandlerError('MISSING_FIELDS', 'channelId is required')
    }
    if (!data.messageId) {
      throw new HandlerError('MISSING_FIELDS', 'messageId is required')
    }
    if (typeof data.redacted !== 'boolean') {
      throw new HandlerError('INVALID_FIELDS', 'redacted must be a boolean')
    }

    const channel = await channelManager.getChannel(data.channelId)
    if (!channel) {
      throw new HandlerError('CHANNEL_NOT_FOUND', 'Channel not found')
    }

    // Authorization: only the channel creator can redact messages (REQ-4, REQ-10)
    const allowed = await canRedact(db, ctx.userId, data.channelId)
    if (!allowed) {
      throw new HandlerError('ACCESS_DENIED', 'You do not have permission to perform this action')
    }

    const updatedMessage = await channelManager.toggleMessageRedaction(
      data.channelId,
      data.messageId,
      data.redacted,
      ctx.userId,
    )

    if (!updatedMessage) {
      throw new HandlerError('MESSAGE_NOT_FOUND', 'Message not found in this channel')
    }

    // Broadcast the redaction state change to channel subscribers.
    // IMPORTANT: No message content is included in the broadcast — only the state.
    // Non-owners who receive this will know the message is redacted but never see its content.
    // The owner's client already has the content (click-to-reveal).
    pubSubService.broadcastToTopic(`channel:${data.channelId}`, {
      type: 'message_redacted',
      channelId: data.channelId,
      messageId: data.messageId,
      redacted: data.redacted,
      redactedBy: ctx.userId,
      redactedAt: updatedMessage.redactedAt || new Date().toISOString(),
    })

    return {
      channelId: data.channelId,
      messageId: data.messageId,
      redacted: data.redacted,
      redactedAt: updatedMessage.redactedAt,
    }
  }
}
