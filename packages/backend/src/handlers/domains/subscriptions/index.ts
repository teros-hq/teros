/**
 * Subscriptions domain — registers MCA event subscription handlers with the router
 *
 * Actions:
 *   mca.subscribe-to-events      → Create a channel event subscription
 *   mca.unsubscribe-from-events  → Delete a channel event subscription
 *   mca.list-event-subscriptions → List channel event subscriptions
 */

import type { WsRouter } from '../../../ws-framework/WsRouter'
import type { MCAEventSubscriptionService } from '../../../services/mca-event-subscription-service'
import type { ChannelManager } from '../../../services/channel-manager'
import type { Db } from 'mongodb'

import { createSubscribeToEventsHandler } from './subscribe-to-events'
import { createUnsubscribeFromEventsHandler } from './unsubscribe-from-events'
import { createListEventSubscriptionsHandler } from './list-event-subscriptions'

export interface SubscriptionsDomainDeps {
  mcaEventSubscriptionService: MCAEventSubscriptionService
  channelManager: ChannelManager
  db: Db
}

export function register(router: WsRouter, deps: SubscriptionsDomainDeps): void {
  const { mcaEventSubscriptionService, channelManager, db } = deps

  router.register(
    'mca.subscribe-to-events',
    createSubscribeToEventsHandler(mcaEventSubscriptionService, channelManager),
  )
  router.register(
    'mca.unsubscribe-from-events',
    createUnsubscribeFromEventsHandler(mcaEventSubscriptionService, channelManager, db),
  )
  router.register(
    'mca.list-event-subscriptions',
    createListEventSubscriptionsHandler(mcaEventSubscriptionService, channelManager),
  )
}
