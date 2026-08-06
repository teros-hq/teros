/**
 * WsRouter — Registry-based WebSocket message router
 *
 * Handlers are registered by action name (e.g. "profile.get").
 * Supports a middleware pipeline that wraps every handler call.
 */

import type { WebSocket } from 'ws';
import type {
  WsHandler,
  WsHandlerContext,
  WsMiddleware,
} from '@teros/shared';
import { normalizeError } from '@teros/shared';

export class WsRouter {
  private handlers = new Map<string, WsHandler>();
  private middlewares: WsMiddleware[] = [];

  /** Register a handler for an action */
  register(action: string, handler: WsHandler): void {
    if (this.handlers.has(action)) {
      throw new Error(`Handler already registered for action: ${action}`);
    }
    this.handlers.set(action, handler);
  }

  /** Add a middleware to the pipeline */
  use(middleware: WsMiddleware): void {
    this.middlewares.push(middleware);
  }

  /** Check if an action has a registered handler */
  has(action: string): boolean {
    return this.handlers.has(action);
  }

  /** List all registered actions (useful for debugging) */
  listActions(): string[] {
    return Array.from(this.handlers.keys()).sort();
  }

  /** Dispatch a request to the appropriate handler */
  async dispatch(
    ws: WebSocket,
    ctx: WsHandlerContext,
    requestId: string,
    action: string,
    data: unknown,
  ): Promise<void> {
    const handler = this.handlers.get(action);

    if (!handler) {
      sendWsError(ws, requestId, 'UNKNOWN_ACTION', `Unknown action: ${action}`);
      return;
    }

    try {
      // Build middleware chain
      const execute = this.buildChain(ctx, action, data, handler);
      const result = await execute();

      sendWsResponse(ws, requestId, result);
    } catch (error: unknown) {
      const code = isHandlerError(error) ? error.code : 'INTERNAL_ERROR';
      const normalized = normalizeError(error);
      sendWsError(ws, requestId, code, normalized.userMessage);
    }
  }

  /** Build the middleware chain ending with the handler */
  private buildChain(
    ctx: WsHandlerContext,
    action: string,
    data: unknown,
    handler: WsHandler,
  ): () => Promise<unknown> {
    let index = 0;

    const next = (): Promise<unknown> => {
      if (index < this.middlewares.length) {
        const middleware = this.middlewares[index++];
        return middleware(ctx, action, data, next);
      }
      return handler(ctx, data);
    };

    return next;
  }
}

// ============================================================================
// HELPERS
// ============================================================================

function sendWsResponse(ws: WebSocket, requestId: string, data: unknown): void {
  ws.send(JSON.stringify({
    type: 'response',
    requestId,
    data,
  }));
}

function sendWsError(ws: WebSocket, requestId: string, code: string, message: string): void {
  ws.send(JSON.stringify({
    type: 'error',
    requestId,
    code,
    message,
  }));
}

// ============================================================================
// HANDLER ERROR
// ============================================================================

/**
 * Typed error that handlers can throw to control the error code.
 *
 * Its `message` is user-facing by contract (handlers craft it for the client),
 * so it also exposes `userMessage`. That makes `normalizeError` preserve it
 * instead of replacing it with a generic catalog message — only raw
 * infrastructure errors get normalized.
 */
export class HandlerError extends Error {
  readonly userMessage: string;
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HandlerError';
    this.userMessage = message;
  }
}

function isHandlerError(error: unknown): error is HandlerError {
  return error instanceof HandlerError;
}
