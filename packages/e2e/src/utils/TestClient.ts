/**
 * Test WebSocket Client for E2E Testing
 *
 * Speaks the REAL Teros WS protocol (TER-453):
 *   1. Auth handshake: flat `{type:'auth',...}` → `auth_success`/`auth_error`
 *      (this is the production protocol — auth happens before the envelope).
 *   2. Everything else: WsFramework envelope
 *      `{type:'request', requestId, action, data}` correlated by requestId
 *      against `{type:'response'|'error', requestId, ...}`.
 *   3. Server pushes (flat `message_sent`, `channel_list_status`,
 *      `project.created`, envelope `event`…) observed via waitFor/waitForEvent.
 *
 * The legacy flat-type request surface (create_channel, list_channels…) was
 * removed: the backend routes those to UNKNOWN_MESSAGE_TYPE.
 */

import WebSocket from 'ws';
import type { WsError, WsRequest, WsResponse } from '@teros/shared';

export interface TestClientConfig {
  /** WebSocket URL (default: ws://localhost:3002/ws) */
  url?: string;
  /** Connection timeout in ms */
  timeout?: number;
  /** Debug logging */
  debug?: boolean;
}

export interface WsMessage {
  type: string;
  [key: string]: any;
}

export interface AuthResponse {
  type: 'auth_success' | 'auth_error';
  userId?: string;
  role?: string;
  sessionToken?: string;
  error?: string;
}

export type MessageFilter = (msg: WsMessage) => boolean;

interface Waiter {
  filter: MessageFilter;
  resolve: (msg: WsMessage) => void;
  timer: ReturnType<typeof setTimeout>;
}

let requestCounter = 0;

/**
 * Test client for E2E WebSocket testing against the real protocol.
 */
export class TestClient {
  private ws: WebSocket | null = null;
  private config: Required<TestClientConfig>;
  private messageQueue: WsMessage[] = [];
  private waiters: Waiter[] = [];
  private allMessages: WsMessage[] = [];
  /** Raw JSON frames sent over the socket (for contract assertions). */
  private sentFrames: string[] = [];

  constructor(config: TestClientConfig = {}) {
    this.config = {
      url: config.url || 'ws://localhost:3002/ws',
      timeout: config.timeout || 10000,
      debug: config.debug || false,
    };
  }

  // ==========================================================================
  // Connection
  // ==========================================================================

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Connection timeout after ${this.config.timeout}ms`));
      }, this.config.timeout);

      this.ws = new WebSocket(this.config.url);

      this.ws.on('open', () => {
        clearTimeout(timeout);
        this.log('Connected to', this.config.url);
        resolve();
      });

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString()) as WsMessage;
          this.log('Received:', msg.type, msg);
          this.allMessages.push(msg);
          this.handleMessage(msg);
        } catch (_e) {
          this.log('Failed to parse message:', data.toString());
        }
      });

      this.ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      this.ws.on('close', () => {
        this.log('Disconnected');
      });
    });
  }

  async disconnect(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  // ==========================================================================
  // Auth handshake (flat protocol — pre-envelope, as in production)
  // ==========================================================================

  async authenticate(email: string, password: string): Promise<AuthResponse> {
    this.sendRaw({ type: 'auth', method: 'credentials', email, password });
    return (await this.waitFor(
      (msg) => msg.type === 'auth_success' || msg.type === 'auth_error',
    )) as AuthResponse;
  }

  async authenticateWithToken(token: string): Promise<AuthResponse> {
    this.sendRaw({ type: 'auth', method: 'token', sessionToken: token });
    return (await this.waitFor(
      (msg) => msg.type === 'auth_success' || msg.type === 'auth_error',
    )) as AuthResponse;
  }

  // ==========================================================================
  // WsFramework envelope — request/response correlated by requestId
  // ==========================================================================

  /**
   * Send a `{type:'request'}` envelope and wait for the response or error
   * carrying the SAME requestId. Other traffic (pushes, concurrent responses)
   * does not satisfy the wait — that is the whole point of the correlation.
   */
  async request(
    action: string,
    data?: Record<string, unknown>,
    timeout?: number,
  ): Promise<(WsResponse | WsError) & WsMessage> {
    const requestId = `req_${++requestCounter}_${Math.random().toString(36).slice(2, 10)}`;
    const envelope: WsRequest = { type: 'request', requestId, action, ...(data ? { data } : {}) };

    const responsePromise = this.waitFor(
      (msg) => (msg.type === 'response' || msg.type === 'error') && msg.requestId === requestId,
      timeout,
      `response/error for ${action} (${requestId})`,
    );
    this.sendRaw(envelope);
    return (await responsePromise) as (WsResponse | WsError) & WsMessage;
  }

  /**
   * Like request() but throws on `{type:'error'}` and unwraps `response.data`.
   */
  async requestOk<T = any>(
    action: string,
    data?: Record<string, unknown>,
    timeout?: number,
  ): Promise<T> {
    const result = await this.request(action, data, timeout);
    if (result.type === 'error') {
      throw new Error(`[${action}] ${(result as WsError).code}: ${(result as WsError).message}`);
    }
    return (result as WsResponse).data as T;
  }

  // ==========================================================================
  // Push observation
  // ==========================================================================

  /**
   * Wait for a message matching a type (string) or predicate. Checks the
   * queue of already-received messages first.
   */
  async waitFor(
    filter: string | string[] | MessageFilter,
    timeout?: number,
    label?: string,
  ): Promise<WsMessage> {
    const filterFn = this.toFilter(filter);
    const description = label ?? (typeof filter === 'function' ? 'predicate' : String(filter));

    const queueIndex = this.messageQueue.findIndex(filterFn);
    if (queueIndex >= 0) {
      return this.messageQueue.splice(queueIndex, 1)[0];
    }

    return new Promise((resolve, reject) => {
      const timeoutMs = timeout || this.config.timeout;
      const waiter: Waiter = {
        filter: filterFn,
        resolve,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          reject(new Error(`Timeout waiting for ${description} after ${timeoutMs}ms`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  /** Semantic alias for server pushes (flat or envelope `event`). */
  async waitForEvent(
    filter: string | string[] | MessageFilter,
    timeout?: number,
  ): Promise<WsMessage> {
    return this.waitFor(filter, timeout);
  }

  /**
   * Collect messages matching a type until a condition, count, or timeout.
   */
  async collectMessages(
    type: string,
    options: { until?: string; timeout?: number; count?: number } = {},
  ): Promise<WsMessage[]> {
    const collected: WsMessage[] = [];
    const { until, timeout = this.config.timeout, count } = options;

    return new Promise((resolve) => {
      const collector: Waiter = {
        filter: (msg) => msg.type === type || (until !== undefined && msg.type === until),
        resolve: () => {},
        timer: setTimeout(() => {
          cleanup();
          resolve(collected);
        }, timeout),
      };

      const cleanup = () => {
        clearTimeout(collector.timer);
        this.waiters = this.waiters.filter((w) => w !== collector);
      };

      collector.resolve = (msg: WsMessage) => {
        if (until && msg.type === until) {
          cleanup();
          resolve(collected);
          return;
        }
        collected.push(msg);
        if (count && collected.length >= count) {
          cleanup();
          resolve(collected);
          return;
        }
        // Re-arm: waiters are one-shot, so push the collector back.
        this.waiters.push(collector);
      };

      this.waiters.push(collector);
    });
  }

  // ==========================================================================
  // Introspection
  // ==========================================================================

  getAllMessages(): WsMessage[] {
    return [...this.allMessages];
  }

  /** Raw frames sent over the socket — exact bytes for contract tests. */
  getSentFrames(): string[] {
    return [...this.sentFrames];
  }

  clearMessages(): void {
    this.allMessages = [];
    this.messageQueue = [];
  }

  // ==========================================================================
  // Private
  // ==========================================================================

  /** Low-level send. Public API should go through request()/authenticate(). */
  sendRaw(message: WsMessage | WsRequest): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }
    const frame = JSON.stringify(message);
    this.log('Sending:', (message as WsMessage).type, message);
    this.sentFrames.push(frame);
    this.ws.send(frame);
  }

  private toFilter(filter: string | string[] | MessageFilter): MessageFilter {
    if (typeof filter === 'function') return filter;
    const types = Array.isArray(filter) ? filter : [filter];
    return (msg) => types.includes(msg.type);
  }

  private handleMessage(msg: WsMessage): void {
    const index = this.waiters.findIndex((w) => w.filter(msg));
    if (index >= 0) {
      const waiter = this.waiters.splice(index, 1)[0];
      clearTimeout(waiter.timer);
      waiter.resolve(msg);
    } else {
      this.messageQueue.push(msg);
    }
  }

  private log(...args: any[]): void {
    if (this.config.debug) {
      console.log('[TestClient]', ...args);
    }
  }
}

/**
 * Create a connected and authenticated test client
 */
export async function createAuthenticatedClient(
  email: string,
  password: string,
  config?: TestClientConfig,
): Promise<TestClient> {
  const client = new TestClient(config);
  await client.connect();

  const auth = await client.authenticate(email, password);
  if (auth.type === 'auth_error') {
    throw new Error(`Authentication failed: ${auth.error}`);
  }

  return client;
}
