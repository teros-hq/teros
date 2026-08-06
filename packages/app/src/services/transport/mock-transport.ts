/**
 * MockTransport — In-memory transport implementation for unit testing.
 *
 * Allows registering mock handlers for specific actions and simulating
 * server events without a real WebSocket connection.
 *
 * NFR-3: Testability
 *
 * @example
 * ```ts
 * const transport = new MockTransport()
 * transport.mockRequest('channel.list', () => ({ channels: [], hasMore: false }))
 * const api = new ChannelApi(transport)
 * const result = await api.list()
 * ```
 */

import type {
  EventHandler,
  RequestOptions,
  StateChangeHandler,
  Transport,
} from './types'
import { ConnectionState } from './types'

type RequestHandlerFn = (payload?: Record<string, unknown>) => unknown

export class MockTransport implements Transport {
  private state: ConnectionState = ConnectionState.CONNECTED
  private eventHandlers = new Map<string, Set<EventHandler<unknown>>>()
  private stateHandlers = new Set<StateChangeHandler>()
  private requestHandlers = new Map<string, RequestHandlerFn>()

  // ============================================================================
  // Transport Interface
  // ============================================================================

  request<TResponse = unknown>(
    action: string,
    payload?: Record<string, unknown>,
    _options?: RequestOptions,
  ): Promise<TResponse> {
    const handler = this.requestHandlers.get(action)
    if (!handler) {
      return Promise.reject(new Error(`MockTransport: no handler registered for action "${action}"`))
    }
    try {
      const result = handler(payload)
      return Promise.resolve(result as TResponse)
    } catch (err) {
      return Promise.reject(err)
    }
  }

  subscribe<TEvent = unknown>(event: string, handler: EventHandler<TEvent>): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set())
    }
    this.eventHandlers.get(event)!.add(handler as EventHandler<unknown>)
  }

  unsubscribe<TEvent = unknown>(event: string, handler: EventHandler<TEvent>): void {
    this.eventHandlers.get(event)?.delete(handler as EventHandler<unknown>)
  }

  getState(): ConnectionState {
    return this.state
  }

  onStateChange(handler: StateChangeHandler): void {
    this.stateHandlers.add(handler)
  }

  offStateChange(handler: StateChangeHandler): void {
    this.stateHandlers.delete(handler)
  }

  // ============================================================================
  // Test Helpers
  // ============================================================================

  /**
   * Register a mock handler for a specific action.
   * The handler receives the request payload and returns the response.
   * Throw inside the handler to simulate server errors.
   */
  mockRequest(action: string, handler: RequestHandlerFn): void {
    this.requestHandlers.set(action, handler)
  }

  /**
   * Simulate a server-pushed event.
   * Calls all subscribed handlers for the given event name.
   */
  simulateEvent<T>(event: string, data: T): void {
    const handlers = this.eventHandlers.get(event)
    handlers?.forEach((h) => h(data))
  }

  /**
   * Simulate a connection state change.
   * Calls all registered state change handlers.
   */
  setState(state: ConnectionState): void {
    this.state = state
    this.stateHandlers.forEach((h) => h(state))
  }

  /**
   * Clear all registered mock handlers (useful between tests).
   */
  reset(): void {
    this.requestHandlers.clear()
    this.eventHandlers.clear()
    this.stateHandlers.clear()
    this.state = ConnectionState.CONNECTED
  }
}
