/**
 * MCA Connection Manager — Types
 *
 * Shared interfaces and types used by McaConnectionManager and its query handler.
 */

import type {
  HealthStatus,
  WsBackendToMcaMessage,
  WsHealthUpdate,
  WsMcaEvent,
} from '@teros/shared';
import type { WsRouter } from '../ws-framework/WsRouter';
import type { AuthManager } from '../auth/auth-manager';
import type { SecretsManager } from '../secrets/secrets-manager';
import type { BoardService } from './board-service';
import type { ChannelManager } from './channel-manager';
import type { WorkspaceService } from './workspace-service';
import type { VolumeService } from './volume-service';
import type { SessionManager } from './session-manager';
import type { PubSubService } from './pubsub-service';
import type { MCAEventSubscriptionService } from './mca-event-subscription-service';
import type { WebSocket } from 'ws';

/**
 * App info needed for secrets resolution
 */
export interface AppInfo {
  appId: string;
  mcaId: string;
  ownerId: string;
}

/**
 * Active WebSocket connection with metadata
 */
export interface ActiveConnection {
  ws: WebSocket;
  appId: string;
  mcaId: string; // Needed to load system secrets
  ownerId: string; // Needed to load user secrets
  connectedAt: number;
  lastPingAt?: number;
  lastPongAt?: number;
  status: HealthStatus;
  /** Current agent context - set before tool execution, used for agent-to-agent communication */
  currentAgentId?: string;
  /** Current channel context - set before tool execution */
  currentChannelId?: string;
  /** Current workspace context - set before tool execution */
  currentWorkspaceId?: string;
}

/**
 * Events emitted by McaConnectionManager
 */
export interface McaConnectionManagerEvents {
  'mca:connected': (appId: string) => void;
  'mca:disconnected': (appId: string, reason: string) => void;
  'mca:event': (event: WsMcaEvent & { appId: string }) => void;
  'mca:health': (appId: string, update: WsHealthUpdate) => void;
  'mca:credentials_expired': (appId: string, reason: string) => void;
  'mca:send_message': (data: { channelId: string; agentId: string; message: string }) => void;
}

/**
 * Configuration for McaConnectionManager
 */
export interface McaConnectionManagerConfig {
  /** Ping interval in ms (default: 30000) */
  pingIntervalMs?: number;
  /** Pong timeout in ms - connection considered dead if no pong (default: 10000) */
  pongTimeoutMs?: number;
  /** Token expiry time in ms (default: 30000) */
  tokenExpiryMs?: number;
  /** Secrets manager for loading system secrets */
  secretsManager?: SecretsManager;
  /** Auth manager for loading user secrets */
  authManager?: AuthManager;
  /** Channel manager for conversations queries */
  channelManager?: ChannelManager;
  /** Board service for board/task queries from MCAs */
  boardService?: BoardService;
  /** Session manager for broadcasting board events */
  sessionManager?: SessionManager;
  /** WsRouter for admin_request dispatch (admin-api domain) */
  wsRouter?: WsRouter;
  /** Unified pub/sub service for persistent channel subscriptions */
  pubSubService?: PubSubService;
  /** MCA event subscription service for high-level topic routing */
  mcaEventSubscriptionService?: MCAEventSubscriptionService;
  /** Workspace service for validating workspace access */
  workspaceService?: WorkspaceService;
  /** Volume service for resolving workspace volume host paths (attachment import) */
  volumeService?: VolumeService;
}

/**
 * Minimal context passed to the query handler function.
 * Avoids passing the full McaConnectionManager instance.
 */
export interface QueryHandlerContext {
  db: import('mongodb').Db;
  channelManager?: ChannelManager;
  boardService?: BoardService;
  pubSubService?: PubSubService;
  mcaEventSubscriptionService?: MCAEventSubscriptionService;
  workspaceService?: WorkspaceService;
  volumeService?: VolumeService;
  wsRouter?: WsRouter;
  send: (appId: string, message: WsBackendToMcaMessage) => boolean;
  emit: (event: string, ...args: unknown[]) => boolean;
  resolveEffectiveAgentId: (connection: ActiveConnection, agentIdHint?: string) => Promise<string | undefined>;
  dispatchToRouter: (appId: string, connection: ActiveConnection, action: string, params: Record<string, unknown>) => Promise<unknown>;
}
