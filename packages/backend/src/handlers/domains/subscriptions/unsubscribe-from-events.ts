/**
 * mca.unsubscribe-from-events — Delete a channel event subscription
 *
 * Validates that the subscription belongs to a channel the caller can access.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { MCAEventSubscriptionService } from '../../../services/mca-event-subscription-service'
import type { ChannelManager } from '../../../services/channel-manager'
import type { Db } from 'mongodb'
import { getChannelEventSubscriptionsCollection } from '../../../models/mca-event-subscriptions'

interface UnsubscribeFromEventsData {
  id: string
}

export function createUnsubscribeFromEventsHandler(
  mcaEventSubscriptionService: MCAEventSubscriptionService,
  channelManager: ChannelManager,
  db: Db,
) {
  return async function unsubscribeFromEvents(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as UnsubscribeFromEventsData
    const { id } = data

    if (!id) throw new HandlerError('MISSING_FIELDS', 'id (subscriptionId) is required')

    // The service does not expose a get-by-id method, so we use the DB collection
    // directly to look up the subscription and validate channel access before deleting.
    const col = getChannelEventSubscriptionsCollection(db)
    const sub = await col.findOne({ id })

    if (!sub) {
      throw new HandlerError('NOT_FOUND', `Subscription ${id} not found`)
    }

    const hasAccess = await channelManager.canAccessChannel(sub.channelId, ctx.userId)
    if (!hasAccess) {
      throw new HandlerError('FORBIDDEN', 'No access to the channel associated with this subscription')
    }

    const deleted = await mcaEventSubscriptionService.deleteChannelSubscription(id)
    if (!deleted) {
      throw new HandlerError('NOT_FOUND', `Subscription ${id} could not be deleted`)
    }

    return { deleted: true }
  }
}
