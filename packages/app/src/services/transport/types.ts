/**
 * Transport layer type definitions
 *
 * Defines the Transport interface that abstracts all communication mechanisms.
 * Enables dependency injection and testability across domain APIs.
 *
 * REQ-1: Transport Abstraction
 * NFR-3: Testability
 */

// ============================================================================
// Connection State
// ============================================================================

/**
 * Connection states for the transport layer
 */
export enum ConnectionState {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  RECONNECTING = 'reconnecting',
  ERROR = 'error',
}

// ============================================================================
// Handler Types
// ============================================================================

export type EventHandler<T = unknown> = (event: T) => void
export type StateChangeHandler = (state: ConnectionState) => void

// ============================================================================
// Request Options
// ============================================================================

export interface RequestOptions {
  /** Request timeout in milliseconds */
  timeout?: number
  /** Number of retries on failure */
  retries?: number
}

// ============================================================================
// Transport Interface
// ============================================================================

/**
 * Transport interface — abstracts all communication mechanisms.
 *
 * Implementations:
 * - WsTransport: WebSocket-based transport (production)
 * - MockTransport: In-memory transport for unit testing
 *
 * REQ-1: Transport Abstraction
 */
export interface Transport {
  /**
   * Send a request and wait for the typed response.
   * @param action  Namespaced action, e.g. "channel.create"
   * @param payload Optional request payload
   * @param options Optional timeout / retry config
   */
  request<TResponse = unknown>(
    action: string,
    payload?: Record<string, unknown>,
    options?: RequestOptions,
  ): Promise<TResponse>

  /**
   * Subscribe to server-pushed events.
   * @param event   Event name or pattern
   * @param handler Event handler function
   */
  subscribe<TEvent = unknown>(event: string, handler: EventHandler<TEvent>): void

  /**
   * Unsubscribe from server-pushed events.
   */
  unsubscribe<TEvent = unknown>(event: string, handler: EventHandler<TEvent>): void

  /**
   * Get the current connection state.
   */
  getState(): ConnectionState

  /**
   * Subscribe to connection state changes.
   */
  onStateChange(handler: StateChangeHandler): void

  /**
   * Unsubscribe from connection state changes.
   */
  offStateChange(handler: StateChangeHandler): void
}

// ============================================================================
// WsTransport Configuration
// ============================================================================

export interface WsTransportConfig {
  /** Maximum reconnection attempts (default: 10) */
  maxReconnectAttempts?: number
  /** Initial reconnection delay in ms (default: 1000) */
  initialReconnectDelay?: number
  /** Maximum reconnection delay in ms (default: 30000) */
  maxReconnectDelay?: number
  /** Heartbeat ping interval in ms (default: 30000) */
  heartbeatInterval?: number
  /** Heartbeat pong timeout in ms (default: 10000) */
  heartbeatTimeout?: number
  /** Default request timeout in ms (default: 10000) */
  defaultTimeout?: number
  /** Maximum missed pongs before forced reconnect (default: 2) */
  maxMissedPongs?: number
}

// ============================================================================
// TerosClient Configuration
// ============================================================================

export interface TerosClientConfig extends Required<WsTransportConfig> {}

export const DEFAULT_CLIENT_CONFIG: TerosClientConfig = {
  maxReconnectAttempts: 10,
  initialReconnectDelay: 1000,
  maxReconnectDelay: 30000,
  heartbeatInterval: 30000,
  heartbeatTimeout: 10000,
  defaultTimeout: 10000,
  maxMissedPongs: 2,
}
