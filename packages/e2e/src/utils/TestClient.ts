/**
 * Test WebSocket Client for E2E Testing
 *
 * Provides a typed client for interacting with the Teros backend
 * via WebSocket. Handles authentication, message sending, and
 * response collection.
 */

import WebSocket from 'ws';

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

/**
 * Test client for E2E WebSocket testing
 */
export class TestClient {
  private ws: WebSocket | null = null;
  private config: Required<TestClientConfig>;
  private messageQueue: WsMessage[] = [];
  private waiters: Map<string, (msg: WsMessage) => void> = new Map();
  private allMessages: WsMessage[] = [];

  constructor(config: TestClientConfig = {}) {
    this.config = {
      url: config.url || 'ws://localhost:3002/ws',
      timeout: config.timeout || 10000,
      debug: config.debug || false,
    };
  }

  /**
   * Connect to the WebSocket server
   */
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
        } catch (e) {
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

  /**
   * Disconnect from the server
   */
  async disconnect(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Authenticate with email/password
   */
  async authenticate(email: string, password: string): Promise<AuthResponse> {
    const response = await this.sendAndWait(
      { type: 'auth', method: 'credentials', email, password },
      ['auth_success', 'auth_error'],
    );
    return response as AuthResponse;
  }

  /**
   * Authenticate with existing token
   */
  async authenticateWithToken(token: string): Promise<AuthResponse> {
    const response = await this.sendAndWait(
      { type: 'auth', method: 'token', sessionToken: token },
      ['auth_success', 'auth_error'],
    );
    return response as AuthResponse;
  }

  /**
   * Register a new user (via auth with credentials - backend auto-creates)
   */
  async register(email: string, password: string, name?: string): Promise<AuthResponse> {
    // In Teros, registration happens via credentials auth if user doesn't exist
    // This might need adjustment based on actual backend behavior
    const response = await this.sendAndWait(
      { type: 'auth', method: 'credentials', email, password },
      ['auth_success', 'auth_error'],
    );
    return response as AuthResponse;
  }

  /**
   * Send a message and wait for a specific response type
   */
  async sendAndWait(
    message: WsMessage,
    responseTypes: string | string[],
    timeout?: number,
  ): Promise<WsMessage> {
    const types = Array.isArray(responseTypes) ? responseTypes : [responseTypes];

    return new Promise((resolve, reject) => {
      const timeoutMs = timeout || this.config.timeout;
      const timer = setTimeout(() => {
        types.forEach((t) => this.waiters.delete(t));
        reject(new Error(`Timeout waiting for ${types.join(' or ')} after ${timeoutMs}ms`));
      }, timeoutMs);

      // Register waiters for all expected types
      types.forEach((type) => {
        this.waiters.set(type, (msg) => {
          clearTimeout(timer);
          types.forEach((t) => this.waiters.delete(t));
          resolve(msg);
        });
      });

      this.send(message);
    });
  }

  /**
   * Send a message without waiting
   */
  send(message: WsMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }
    this.log('Sending:', message.type, message);
    this.ws.send(JSON.stringify(message));
  }

  /**
   * Wait for a specific message type
   */
  async waitFor(responseTypes: string | string[], timeout?: number): Promise<WsMessage> {
    const types = Array.isArray(responseTypes) ? responseTypes : [responseTypes];

    // Check if we already have it in the queue
    const existing = this.messageQueue.find((m) => types.includes(m.type));
    if (existing) {
      this.messageQueue = this.messageQueue.filter((m) => m !== existing);
      return existing;
    }

    return new Promise((resolve, reject) => {
      const timeoutMs = timeout || this.config.timeout;
      const timer = setTimeout(() => {
        types.forEach((t) => this.waiters.delete(t));
        reject(new Error(`Timeout waiting for ${types.join(' or ')} after ${timeoutMs}ms`));
      }, timeoutMs);

      types.forEach((type) => {
        this.waiters.set(type, (msg) => {
          clearTimeout(timer);
          types.forEach((t) => this.waiters.delete(t));
          resolve(msg);
        });
      });
    });
  }

  /**
   * Collect all messages of a type until a condition or timeout
   */
  async collectMessages(
    type: string,
    options: { until?: string; timeout?: number; count?: number } = {},
  ): Promise<WsMessage[]> {
    const collected: WsMessage[] = [];
    const { until, timeout = this.config.timeout, count } = options;

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve(collected);
      }, timeout);

      const cleanup = () => {
        clearTimeout(timer);
        this.waiters.delete(type);
        if (until) this.waiters.delete(until);
      };

      // Collector for target type
      this.waiters.set(type, (msg) => {
        collected.push(msg);
        if (count && collected.length >= count) {
          cleanup();
          resolve(collected);
        }
      });

      // Stop condition
      if (until) {
        this.waiters.set(until, () => {
          cleanup();
          resolve(collected);
        });
      }
    });
  }

  /**
   * Get all messages received (for debugging)
   */
  getAllMessages(): WsMessage[] {
    return [...this.allMessages];
  }

  /**
   * Clear message history
   */
  clearMessages(): void {
    this.allMessages = [];
    this.messageQueue = [];
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  // ============================================================================
  // Private
  // ============================================================================

  private handleMessage(msg: WsMessage): void {
    const waiter = this.waiters.get(msg.type);
    if (waiter) {
      waiter(msg);
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
