/**
 * WebSocket Framework Protocol Types
 *
 * Defines the three communication primitives:
 * - Request/Response (client → server → client)
 * - Subscribe/Unsubscribe (client manages subscriptions)
 * - Event (server → client push)
 */

// ============================================================================
// REQUEST / RESPONSE
// ============================================================================

/** Client → Server: request an action */
export interface WsRequest {
  type: "request"
  requestId: string
  action: string
  data?: Record<string, unknown>
}

/** Server → Client: successful response */
export interface WsResponse {
  type: "response"
  requestId: string
  data: unknown
}

/** Server → Client: error (may or may not be tied to a request) */
export interface WsError {
  type: "error"
  requestId?: string
  code: string
  message: string
}

// ============================================================================
// SUBSCRIPTIONS
// ============================================================================

/** Client → Server: subscribe to a channel */
export interface WsSubscribe {
  type: "subscribe"
  requestId: string
  channel: string // format: "{domain}:{resourceId}"
}

/** Client → Server: unsubscribe from a channel */
export interface WsUnsubscribe {
  type: "unsubscribe"
  requestId: string
  channel: string
}

// ============================================================================
// EVENTS (server push)
// ============================================================================

/** Server → Client: push event */
export interface WsEvent {
  type: "event"
  event: string // namespaced, e.g. "channel.typing.start"
  channel?: string // present if from a subscription
  data: unknown
}

// ============================================================================
// UNION TYPES
// ============================================================================

/** All messages the client can send */
export type WsClientMessage = WsRequest | WsSubscribe | WsUnsubscribe

/** All messages the server can send */
export type WsServerMessage = WsResponse | WsError | WsEvent

// ============================================================================
// HANDLER TYPES (backend)
// ============================================================================

/** Context passed to every handler */
export interface WsHandlerContext {
  userId: string
  sessionId: string
  ip: string
}

/** A handler function that processes a request and returns data */
export type WsHandler<TData = unknown, TResult = unknown> = (
  ctx: WsHandlerContext,
  data: TData,
) => Promise<TResult>

/** Middleware function — wraps a handler */
export type WsMiddleware = (
  ctx: WsHandlerContext,
  action: string,
  data: unknown,
  next: () => Promise<unknown>,
) => Promise<unknown>

// ============================================================================
// TYPE GUARDS
// ============================================================================

export function isWsRequest(msg: unknown): msg is WsRequest {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as WsRequest).type === "request" &&
    typeof (msg as WsRequest).requestId === "string" &&
    typeof (msg as WsRequest).action === "string"
  )
}

export function isWsSubscribe(msg: unknown): msg is WsSubscribe {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as WsSubscribe).type === "subscribe" &&
    typeof (msg as WsSubscribe).requestId === "string" &&
    typeof (msg as WsSubscribe).channel === "string"
  )
}

export function isWsUnsubscribe(msg: unknown): msg is WsUnsubscribe {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as WsUnsubscribe).type === "unsubscribe" &&
    typeof (msg as WsUnsubscribe).requestId === "string" &&
    typeof (msg as WsUnsubscribe).channel === "string"
  )
}

export function isWsFrameworkMessage(msg: unknown): boolean {
  return isWsRequest(msg) || isWsSubscribe(msg) || isWsUnsubscribe(msg)
}
