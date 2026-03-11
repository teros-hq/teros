/**
 * MCA WebSocket Client
 *
 * Connects to the Teros backend WebSocket server for bidirectional communication.
 * Used by MCAs to:
 * - Receive commands from backend (shutdown, reload, etc.)
 * - Receive subscription notifications
 * - Send events to backend (for routing to channels)
 * - Send health updates
 * - Respond to ping/pong heartbeat
 */

import type {
  HealthIssue,
  HealthStatus,
  WsAdminResponse,
  WsBackendToMcaMessage,
  WsCommand,
  WsMcaToBackendMessage,
  WsQueryConversationsAction,
  WsQueryConversationsResult,
  WsSubscriptionAdded,
  WsSystemSecretsResponse,
  WsUpdateUserSecretsResponse,
  WsUserSecretsResponse,
} from '@teros/shared';
import { EventEmitter } from 'events';
import WebSocket from 'ws';

// ============================================================================
// TYPES
// ============================================================================

export interface McaWebSocketConfig {
  /** WebSocket URL (from MCA_WS_URL env var) */
  url: string;
  /** Whether to auto-reconnect on disconnect (default: true) */
  reconnect?: boolean;
  /** Max reconnection attempts (default: 10) */
  maxReconnectAttempts?: number;
  /** Base delay between reconnects in ms (default: 1000) */
  reconnectDelayMs?: number;
  /** Max delay between reconnects in ms (default: 30000) */
  maxReconnectDelayMs?: number;
}

export interface McaWebSocketEvents {
  connected: () => void;
  disconnected: (code: number, reason: string) => void;
  error: (error: Error) => void;
  subscription_added: (subscription: WsSubscriptionAdded) => void;
  subscription_removed: (subscriptionId: string, reason: string) => void;
  credentials_updated: (credentials: Record<string, string>) => void;
  command: (command: WsCommand) => void;
}

// ============================================================================
// WEBSOCKET CLIENT
// ============================================================================

export class McaWebSocketClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private isConnected = false;
  private shouldReconnect = true;
  private reconnectAttempts = 0;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private config: Required<McaWebSocketConfig>;
  private appId: string;

  // Pending secrets requests (requestId -> resolver)
  private pendingSecretsRequests = new Map<
    string,
    {
      resolve: (secrets: Record<string, string> | null) => void;
      reject: (error: Error) => void;
    }
  >();

  // Pending update secrets requests (requestId -> resolver)
  private pendingUpdateSecretsRequests = new Map<
    string,
    {
      resolve: (success: boolean) => void;
      reject: (error: Error) => void;
    }
  >();

  // Pending query requests (requestId -> resolver)
  private pendingQueryRequests = new Map<
    string,
    {
      resolve: (data: unknown) => void;
      reject: (error: Error) => void;
    }
  >();

  // Pending admin requests (requestId -> resolver)
  private pendingAdminRequests = new Map<
    string,
    {
      resolve: (data: unknown) => void;
      reject: (error: Error) => void;
    }
  >();

  constructor(config: McaWebSocketConfig) {
    super();
    this.config = {
      url: config.url,
      reconnect: config.reconnect ?? true,
      maxReconnectAttempts: config.maxReconnectAttempts ?? 10,
      reconnectDelayMs: config.reconnectDelayMs ?? 1000,
      maxReconnectDelayMs: config.maxReconnectDelayMs ?? 30000,
    };

    // Extract appId from URL
    const url = new URL(config.url);
    this.appId = url.searchParams.get('appId') || 'unknown';
  }

  /**
   * Connect to the backend WebSocket server
   */
  async connect(): Promise<void> {
    if (this.isConnected) {
      console.log(`[McaWsClient:${this.appId}] Already connected`);
      return;
    }

    return new Promise((resolve, reject) => {
      console.log(`[McaWsClient:${this.appId}] Connecting to ${this.config.url}`);

      try {
        this.ws = new WebSocket(this.config.url);
      } catch (error) {
        reject(error);
        return;
      }

      const connectionTimeout = setTimeout(() => {
        if (!this.isConnected) {
          this.ws?.close();
          reject(new Error('Connection timeout'));
        }
      }, 10000);

      this.ws.on('open', () => {
        clearTimeout(connectionTimeout);
        // Wait for connection_ack before considering connected
      });

      this.ws.on('message', (data) => {
        this.handleMessage(data, resolve);
      });

      this.ws.on('close', (code, reason) => {
        clearTimeout(connectionTimeout);
        this.handleClose(code, reason.toString());
        if (!this.isConnected) {
          reject(new Error(`Connection closed: ${code} ${reason}`));
        }
      });

      this.ws.on('error', (error: Error) => {
        clearTimeout(connectionTimeout);
        console.error(`[McaWsClient:${this.appId}] WebSocket error:`, error.message);
        // Only emit if there are listeners (to avoid crash)
        if (this.listenerCount('error') > 0) {
          this.emit('error', error);
        }
        if (!this.isConnected) {
          reject(error);
        }
      });
    });
  }

  /**
   * Handle incoming message from backend
   */
  private handleMessage(data: WebSocket.RawData, onConnected?: (value: void) => void): void {
    let message: WsBackendToMcaMessage;

    try {
      message = JSON.parse(data.toString());
    } catch (error) {
      console.error(`[McaWsClient:${this.appId}] Failed to parse message:`, error);
      return;
    }

    switch (message.type) {
      case 'connection_ack':
        this.isConnected = true;
        this.reconnectAttempts = 0;
        console.log(`[McaWsClient:${this.appId}] Connected (server time: ${message.serverTime})`);
        this.emit('connected');
        onConnected?.();
        break;

      case 'ping':
        this.sendPong();
        break;

      case 'credentials_updated':
        console.log(`[McaWsClient:${this.appId}] Credentials updated`);
        this.emit('credentials_updated', message.credentials);
        break;

      case 'subscription_added':
        console.log(`[McaWsClient:${this.appId}] Subscription added: ${message.subscriptionId}`);
        this.emit('subscription_added', message);
        break;

      case 'subscription_removed':
        console.log(`[McaWsClient:${this.appId}] Subscription removed: ${message.subscriptionId}`);
        this.emit('subscription_removed', message.subscriptionId, message.reason);
        break;

      case 'command':
        console.log(`[McaWsClient:${this.appId}] Command received: ${message.command}`);
        this.emit('command', message);
        break;

      case 'system_secrets':
        this.handleSecretsResponse(message);
        break;

      case 'user_secrets':
        this.handleSecretsResponse(message);
        break;

      case 'update_user_secrets_response':
        this.handleUpdateSecretsResponse(message);
        break;

      case 'query_conversations_result':
        this.handleQueryResponse(message);
        break;

      case 'admin_response':
        this.handleAdminResponse(message);
        break;
    }
  }

  /**
   * Handle secrets response from backend
   */
  private handleSecretsResponse(message: WsSystemSecretsResponse | WsUserSecretsResponse): void {
    const pending = this.pendingSecretsRequests.get(message.requestId);
    if (!pending) {
      console.warn(
        `[McaWsClient:${this.appId}] Received secrets response for unknown requestId: ${message.requestId}`,
      );
      return;
    }

    this.pendingSecretsRequests.delete(message.requestId);

    if (message.error) {
      pending.reject(new Error(message.error));
    } else {
      pending.resolve(message.secrets);
    }
  }

  /**
   * Handle update user secrets response from backend
   */
  private handleUpdateSecretsResponse(message: WsUpdateUserSecretsResponse): void {
    const pending = this.pendingUpdateSecretsRequests.get(message.requestId);
    if (!pending) {
      console.warn(
        `[McaWsClient:${this.appId}] Received update secrets response for unknown requestId: ${message.requestId}`,
      );
      return;
    }

    this.pendingUpdateSecretsRequests.delete(message.requestId);

    if (message.error) {
      pending.reject(new Error(message.error));
    } else {
      pending.resolve(message.success);
    }
  }

  /**
   * Handle query conversations response from backend
   */
  private handleQueryResponse(message: WsQueryConversationsResult): void {
    const pending = this.pendingQueryRequests.get(message.requestId);
    if (!pending) {
      console.warn(
        `[McaWsClient:${this.appId}] Received query response for unknown requestId: ${message.requestId}`,
      );
      return;
    }

    this.pendingQueryRequests.delete(message.requestId);

    if (message.error) {
      pending.reject(new Error(message.error));
    } else {
      pending.resolve(message.data);
    }
  }

  /**
   * Handle admin_response from backend
   */
  private handleAdminResponse(message: WsAdminResponse): void {
    const pending = this.pendingAdminRequests.get(message.requestId);
    if (!pending) {
      console.warn(
        `[McaWsClient:${this.appId}] Received admin_response for unknown requestId: ${message.requestId}`,
      );
      return;
    }

    this.pendingAdminRequests.delete(message.requestId);

    if (message.error) {
      const err = new Error(message.error);
      (err as any).code = message.code;
      pending.reject(err);
    } else {
      pending.resolve(message.data);
    }
  }

  /**
   * Handle connection close
   */
  private handleClose(code: number, reason: string): void {
    const wasConnected = this.isConnected;
    this.isConnected = false;
    this.ws = null;

    console.log(`[McaWsClient:${this.appId}] Disconnected (code: ${code}, reason: ${reason})`);

    if (wasConnected) {
      this.emit('disconnected', code, reason);
    }

    // Attempt reconnection if enabled
    if (this.shouldReconnect && this.config.reconnect) {
      this.scheduleReconnect();
    }
  }

  /**
   * Schedule a reconnection attempt
   */
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      console.error(`[McaWsClient:${this.appId}] Max reconnection attempts reached`);
      return;
    }

    // Exponential backoff
    const delay = Math.min(
      this.config.reconnectDelayMs * 2 ** this.reconnectAttempts,
      this.config.maxReconnectDelayMs,
    );

    this.reconnectAttempts++;
    console.log(
      `[McaWsClient:${this.appId}] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.config.maxReconnectAttempts})`,
    );

    this.reconnectTimeout = setTimeout(async () => {
      try {
        await this.connect();
      } catch (error) {
        console.error(`[McaWsClient:${this.appId}] Reconnection failed:`, error);
        // handleClose will schedule next attempt
      }
    }, delay);
  }

  // ==========================================================================
  // SENDING MESSAGES
  // ==========================================================================

  /**
   * Send a message to the backend
   */
  private send(message: WsMcaToBackendMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn(`[McaWsClient:${this.appId}] Cannot send - not connected`);
      return false;
    }

    try {
      this.ws.send(JSON.stringify(message));
      return true;
    } catch (error) {
      console.error(`[McaWsClient:${this.appId}] Failed to send message:`, error);
      return false;
    }
  }

  /**
   * Send pong response to ping
   */
  private sendPong(): void {
    this.send({
      type: 'pong',
      mcaTime: Date.now(),
    });
  }

  /**
   * Send an event to the backend (for routing to a channel)
   */
  sendEvent(subscriptionId: string, eventType: string, data: Record<string, unknown>): boolean {
    return this.send({
      type: 'event',
      eventId: `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      subscriptionId,
      eventType,
      data,
      timestamp: Date.now(),
    });
  }

  /**
   * Send a health status update
   */
  sendHealthUpdate(status: HealthStatus, issues?: HealthIssue[]): boolean {
    return this.send({
      type: 'health_update',
      status,
      issues,
    });
  }

  /**
   * Notify backend that credentials have expired
   */
  sendCredentialsExpired(reason: string, message?: string): boolean {
    return this.send({
      type: 'credentials_expired',
      reason,
      message,
    });
  }

  /**
   * Send an error to the backend
   */
  sendError(code: string, message: string, retryable: boolean = false): boolean {
    return this.send({
      type: 'error',
      code,
      message,
      retryable,
    });
  }

  // ==========================================================================
  // SECRETS
  // ==========================================================================

  /**
   * Request system secrets from backend (CLIENT_ID, CLIENT_SECRET, etc.)
   * These are MCA-level secrets configured by admins.
   *
   * @param timeoutMs - Timeout in milliseconds (default: 5000)
   * @returns Promise resolving to secrets object or null if not available
   */
  async getSystemSecrets(timeoutMs: number = 5000): Promise<Record<string, string> | null> {
    if (!this.isConnected) {
      throw new Error('Not connected to backend');
    }

    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    return new Promise((resolve, reject) => {
      // Set timeout
      const timeout = setTimeout(() => {
        this.pendingSecretsRequests.delete(requestId);
        reject(new Error('Timeout waiting for system secrets'));
      }, timeoutMs);

      // Store pending request
      this.pendingSecretsRequests.set(requestId, {
        resolve: (secrets) => {
          clearTimeout(timeout);
          resolve(secrets);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      // Send request
      const sent = this.send({
        type: 'get_system_secrets',
        requestId,
      });

      if (!sent) {
        clearTimeout(timeout);
        this.pendingSecretsRequests.delete(requestId);
        reject(new Error('Failed to send get_system_secrets request'));
      }
    });
  }

  /**
   * Request user secrets from backend (ACCESS_TOKEN, REFRESH_TOKEN, etc.)
   * These are user-specific credentials stored encrypted in MongoDB.
   *
   * @param timeoutMs - Timeout in milliseconds (default: 5000)
   * @returns Promise resolving to secrets object or null if not authenticated
   */
  async getUserSecrets(timeoutMs: number = 5000): Promise<Record<string, string> | null> {
    if (!this.isConnected) {
      throw new Error('Not connected to backend');
    }

    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    return new Promise((resolve, reject) => {
      // Set timeout
      const timeout = setTimeout(() => {
        this.pendingSecretsRequests.delete(requestId);
        reject(new Error('Timeout waiting for user secrets'));
      }, timeoutMs);

      // Store pending request
      this.pendingSecretsRequests.set(requestId, {
        resolve: (secrets) => {
          clearTimeout(timeout);
          resolve(secrets);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      // Send request
      const sent = this.send({
        type: 'get_user_secrets',
        requestId,
      });

      if (!sent) {
        clearTimeout(timeout);
        this.pendingSecretsRequests.delete(requestId);
        reject(new Error('Failed to send get_user_secrets request'));
      }
    });
  }

  /**
   * Update user secrets in backend (when MCA refreshes tokens locally).
   * This is a partial update - only the keys provided will be updated.
   *
   * @param secrets - Object with secrets to update (e.g., { ACCESS_TOKEN: '...', EXPIRY_DATE: '...' })
   * @param timeoutMs - Timeout in milliseconds (default: 5000)
   * @returns Promise resolving to true if successful
   */
  async updateUserSecrets(
    secrets: Record<string, string>,
    timeoutMs: number = 5000,
  ): Promise<boolean> {
    if (!this.isConnected) {
      throw new Error('Not connected to backend');
    }

    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    return new Promise((resolve, reject) => {
      // Set timeout
      const timeout = setTimeout(() => {
        this.pendingUpdateSecretsRequests.delete(requestId);
        reject(new Error('Timeout waiting for update_user_secrets response'));
      }, timeoutMs);

      // Store pending request
      this.pendingUpdateSecretsRequests.set(requestId, {
        resolve: (success) => {
          clearTimeout(timeout);
          resolve(success);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      // Send request
      const sent = this.send({
        type: 'update_user_secrets',
        requestId,
        secrets,
      });

      if (!sent) {
        clearTimeout(timeout);
        this.pendingUpdateSecretsRequests.delete(requestId);
        reject(new Error('Failed to send update_user_secrets request'));
      }
    });
  }

  /**
   * Wait for credentials to be updated via WebSocket.
   * Useful after calling sendCredentialsExpired() to wait for backend to refresh.
   *
   * @param timeoutMs - Timeout in milliseconds (default: 30000)
   * @returns Promise resolving to the new credentials
   */
  async waitForCredentialsUpdate(timeoutMs: number = 30000): Promise<Record<string, string>> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.off('credentials_updated', handler);
        reject(new Error('Timeout waiting for credentials update'));
      }, timeoutMs);

      const handler = (credentials: Record<string, string>) => {
        clearTimeout(timeout);
        resolve(credentials);
      };

      this.once('credentials_updated', handler);
    });
  }

  // ==========================================================================
  // CONVERSATIONS QUERY
  // ==========================================================================

  /**
   * Query conversations data from backend.
   * Used by mca.teros.conversations to search messages, list channels, etc.
   *
   * @param action - The query action to perform
   * @param params - Parameters for the query
   * @param timeoutMs - Timeout in milliseconds (default: 10000)
   * @returns Promise resolving to the query result data
   */
  async queryConversations<T = unknown>(
    action: WsQueryConversationsAction,
    params: Record<string, unknown>,
    timeoutMs: number = 10000,
  ): Promise<T> {
    if (!this.isConnected) {
      throw new Error('Not connected to backend');
    }

    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    return new Promise((resolve, reject) => {
      // Set timeout
      const timeout = setTimeout(() => {
        this.pendingQueryRequests.delete(requestId);
        reject(new Error(`Timeout waiting for query_conversations (${action})`));
      }, timeoutMs);

      // Store pending request
      this.pendingQueryRequests.set(requestId, {
        resolve: (data) => {
          clearTimeout(timeout);
          resolve(data as T);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      // Send request
      const sent = this.send({
        type: 'query_conversations',
        requestId,
        action,
        params,
      });

      if (!sent) {
        clearTimeout(timeout);
        this.pendingQueryRequests.delete(requestId);
        reject(new Error('Failed to send query_conversations request'));
      }
    });
  }

  // ==========================================================================
  // ADMIN API
  // ==========================================================================

  /**
   * Send an admin_request to the backend WsRouter (admin-api domain).
   * Replaces HTTP fetch to /admin/* endpoints.
   *
   * @param action - The WsRouter action (e.g. 'admin-api.mca-status')
   * @param params - Request parameters
   * @param timeoutMs - Timeout in milliseconds (default: 15000)
   * @returns Promise resolving to the response data
   */
  async adminRequest<T = unknown>(
    action: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = 15000,
  ): Promise<T> {
    if (!this.isConnected) {
      throw new Error('Not connected to backend');
    }

    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingAdminRequests.delete(requestId);
        reject(new Error(`Timeout waiting for admin_request (${action})`));
      }, timeoutMs);

      this.pendingAdminRequests.set(requestId, {
        resolve: (data) => {
          clearTimeout(timeout);
          resolve(data as T);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      const sent = this.send({
        type: 'admin_request',
        requestId,
        action,
        params,
      });

      if (!sent) {
        clearTimeout(timeout);
        this.pendingAdminRequests.delete(requestId);
        reject(new Error('Failed to send admin_request'));
      }
    });
  }

  // ==========================================================================
  // LIFECYCLE
  // ==========================================================================

  /**
   * Check if connected
   */
  get connected(): boolean {
    return this.isConnected;
  }

  /**
   * Disconnect from the backend
   */
  disconnect(): void {
    this.shouldReconnect = false;

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }

    this.isConnected = false;
    console.log(`[McaWsClient:${this.appId}] Disconnected by client`);
  }
}

// ============================================================================
// FACTORY FUNCTION
// ============================================================================

/**
 * Create a WebSocket client from environment variables
 *
 * Expects:
 * - MCA_WS_URL: Full WebSocket URL with appId and token
 *
 * WebSocket is the core transport protocol - MCA_WS_URL must always be set.
 *
 * @throws Error if MCA_WS_URL is not set
 */
export function createWebSocketClient(): McaWebSocketClient {
  const url = process.env.MCA_WS_URL;

  if (!url) {
    throw new Error(
      '[McaWsClient] MCA_WS_URL is required but not set. WebSocket is the core transport protocol.',
    );
  }

  return new McaWebSocketClient({ url });
}
