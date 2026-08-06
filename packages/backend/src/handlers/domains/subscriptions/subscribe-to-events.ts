/**
 * mca.subscribe-to-events — Create a channel event subscription
 *
 * Routes MCA events matching a topic into an existing conversation.
 * Validates that the calling user has access to the target channel.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { MCAEventSubscriptionService } from '../../../services/mca-event-subscription-service'
import type { ChannelManager } from '../../../services/channel-manager'

interface SubscribeToEventsData {
  topic: string
  channelId: string
  rules?: Array<Record<string, unknown>>
  mode?: 'notify' | 'wake'
}

export function createSubscribeToEventsHandler(
  mcaEventSubscriptionService: MCAEventSubscriptionService,
  channelManager: ChannelManager,
) {
  return async function subscribeToEvents(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as SubscribeToEventsData
    const { topic, channelId, rules, mode } = data

    if (!topic) throw new HandlerError('MISSING_FIELDS', 'topic is required')
    if (!channelId) throw new HandlerError('MISSING_FIELDS', 'channelId is required')

    // Verify caller has access to the target channel
    const hasAccess = await channelManager.canAccessChannel(channelId, ctx.userId)
    if (!hasAccess) {
      throw new HandlerError('FORBIDDEN', 'No access to this channel')
    }

    const sub = await mcaEventSubscriptionService.createChannelSubscription({
      topic,
      channelId,
      rules: rules ?? [],
      mode: mode ?? 'notify',
    })

    return {
      subscription: {
        id: sub.id,
        topic: sub.topic,
        channelId: sub.channelId,
        rules: sub.rules,
        mode: sub.mode,
        createdAt: sub.createdAt,
      },
    }
  }
}
