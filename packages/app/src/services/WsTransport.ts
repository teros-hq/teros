/**
 * WsTransport — Thin adapter that sends WsFramework requests via TerosClient
 *
 * Bridges the new request/response protocol with TerosClient's existing
 * requestCallbacks infrastructure. No separate WebSocket connection needed.
 */

import type { TerosClient } from "./TerosClient"

export class WsTransport {
  private requestCounter = 0

  constructor(private readonly client: TerosClient) {}

  /**
   * Send a framework request and wait for the typed response.
   *
   * @param action  Namespaced action, e.g. "profile.get"
   * @param data    Optional payload
   * @param timeout Milliseconds before rejecting (default: 10 000)
   */
  request<TResult = unknown>(
    action: string,
    data?: Record<string, unknown>,
    timeout = 10_000,
  ): Promise<TResult> {
    const requestId = `ws_${++this.requestCounter}_${Date.now()}`
    return this.client.sendFrameworkRequest<TResult>(requestId, action, data, timeout)
  }
}
