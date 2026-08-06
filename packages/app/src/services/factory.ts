/**
 * TerosClientFactory — Creates pre-configured TerosClient instances.
 *
 * Supports custom transport injection for testing (REQ-4).
 *
 * @example Production use:
 * ```ts
 * const factory = new TerosClientFactory()
 * const client = factory.createClient()
 * client.connect('wss://be.teros.ai/ws')
 * ```
 *
 * @example Testing:
 * ```ts
 * const transport = new MockTransport()
 * const factory = new TerosClientFactory()
 * const client = factory.createClientWithTransport(transport)
 * ```
 */

import { TerosClient } from './client'
import { WsTransport } from './transport/ws-transport'
import { MockTransport } from './transport/mock-transport'
import type { Transport, TerosClientConfig } from './transport/types'
import { DEFAULT_CLIENT_CONFIG } from './transport/types'

export class TerosClientFactory {
  private readonly config: TerosClientConfig

  constructor(config: Partial<TerosClientConfig> = {}) {
    this.config = { ...DEFAULT_CLIENT_CONFIG, ...config }
  }

  /** Create a client backed by a real WebSocket transport. */
  createClient(): TerosClient {
    const transport = new WsTransport(this.config)
    return new TerosClient(transport)
  }

  /** Create a client with a custom transport (e.g. MockTransport for tests). */
  createClientWithTransport(transport: Transport): TerosClient {
    return new TerosClient(transport)
  }

  /** Create a client with a MockTransport — convenience for tests. */
  createMockClient(): { client: TerosClient; transport: MockTransport } {
    const transport = new MockTransport()
    const client = new TerosClient(transport)
    return { client, transport }
  }

  getConfig(): TerosClientConfig {
    return { ...this.config }
  }
}
