/**
 * TerosClient — entry point.
 *
 * The implementation has been refactored into:
 *   - packages/app/src/services/client.ts          (TerosClient facade)
 *   - packages/app/src/services/transport/          (Transport layer)
 *   - packages/app/src/services/events/             (EventBus)
 *   - packages/app/src/services/factory.ts          (TerosClientFactory)
 *
 * This file re-exports TerosClient so all existing imports continue to work
 * without any changes.
 *
 *
 */
export { TerosClient } from './client'
