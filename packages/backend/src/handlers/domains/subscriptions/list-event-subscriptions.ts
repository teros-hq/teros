/**
 * mca.list-event-subscriptions — List channel event subscriptions for a channel
 *
 * Validates that the caller has access to the channel before returning subscriptions.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { MCAEventSubscriptionService } from '../../../services/mca-event-subscription-service'
import type { ChannelManager } from '../../../services/channel-manager'

interface ListEventSubscriptionsData {
  channelId: string
}

export function createListEventSubscriptionsHandler(
  mcaEventSubscriptionService: MCAEventSubscriptionService,
  channelManager: ChannelManager,
) {
  return async function listEventSubscriptions(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as ListEventSubscriptionsData
    const { channelId } = data

    if (!channelId) throw new HandlerError('MISSING_FIELDS', 'channelId is required')

    const hasAccess = await channelManager.canAccessChannel(channelId, ctx.userId)
    if (!hasAccess) {
      throw new HandlerError('FORBIDDEN', 'No access to this channel')
    }

    const subs = await mcaEventSubscriptionService.listChannelSubscriptions(channelId)

    return {
      subscriptions: subs.map((sub) => ({
        id: sub.id,
        topic: sub.topic,
        channelId: sub.channelId,
        rules: sub.rules,
        mode: sub.mode,
        createdAt: sub.createdAt,
        lastActivityAt: sub.lastActivityAt,
      })),
    }
  }
}
