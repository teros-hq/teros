/**
 * Public API for the Teros client services layer.
 */

// Main client & factory
export { TerosClient } from './client'
export { TerosClientFactory } from './factory'

// Transport layer
export { WsTransport } from './transport/ws-transport'
export { MockTransport } from './transport/mock-transport'
export { ConnectionState } from './transport/types'
export type {
  Transport,
  WsTransportConfig,
  TerosClientConfig,
  RequestOptions,
  EventHandler,
  StateChangeHandler,
} from './transport/types'

// Events
export { SimpleEventBus } from './events/event-bus'
export type { EventBus } from './events/event-bus'
