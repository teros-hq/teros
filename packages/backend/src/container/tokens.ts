/**
 * Dependency Injection Tokens
 *
 * Type-safe tokens for all injectable dependencies in Teros backend.
 * Using symbols ensures uniqueness and prevents accidental collisions.
 *
 * @example
 * ```typescript
 * // Registration
 * container.register(Tokens.McaService, (c) => new McaService(c.get(Tokens.Db)));
 *
 * // Resolution (type-safe!)
 * const mcaService = container.get(Tokens.McaService); // type: IMcaService
 * ```
 */

import type { SessionLockManager } from '@teros/core';
import type { Db } from 'mongodb';
import type { AuthManager } from '../auth/auth-manager';
import type { EventHandler } from '../handlers/event-handler';
import type { MessageHandler } from '../handlers/message-handler';
import type { WebSocketHandler } from '../handlers/websocket-handler';
import type { SecretsManager } from '../secrets/secrets-manager';
import type { ChannelManager } from '../services/channel-manager';
import type { McaManager } from '../services/mca-manager';
import type { McaService } from '../services/mca-service';
import type { ModelService } from '../services/model-service';
import type { ProviderService } from '../services/provider-service';
import type { ResumeService } from '../services/resume-service';
import type { SchedulerService } from '../services/scheduler-service';
// Import service types
// Note: Interfaces exist in ./services/interfaces/ for testing with mocks
import type { SessionManager } from '../services/session-manager';
import type { UsageService } from '../services/usage-service';
import type { VolumeService } from '../services/volume-service';
import type { BoardService } from '../services/board-service';
import type { WorkspaceService } from '../services/workspace-service';
import type { MongoSessionStore } from '../session/MongoSessionStore';
import { createToken, type Token } from './types';

/**
 * All dependency injection tokens
 *
 * Organized by category:
 * - Infrastructure: Database, config, secrets
 * - Services: Business logic services
 * - Handlers: Request/event handlers
 * - Core: Shared core components
 */
export const Tokens = {
  // ============================================================================
  // INFRASTRUCTURE
  // ============================================================================

  /** MongoDB database instance */
  Db: createToken<Db>('Db'),

  /** Secrets manager for credentials */
  SecretsManager: createToken<SecretsManager>('SecretsManager'),

  /** Application configuration */
  Config: createToken<AppConfig>('Config'),

  // ============================================================================
  // AUTH
  // ============================================================================

  /** Authentication manager */
  AuthManager: createToken<AuthManager>('AuthManager'),

  // ============================================================================
  // SERVICES
  // ============================================================================

  /** WebSocket session manager */
  SessionManager: createToken<SessionManager>('SessionManager'),

  /** Channel/conversation manager */
  ChannelManager: createToken<ChannelManager>('ChannelManager'),

  /** MCA (Model Context App) lifecycle manager */
  McaManager: createToken<McaManager>('McaManager'),

  /** MCA service for app/catalog operations */
  McaService: createToken<McaService>('McaService'),

  /** Volume service for container storage */
  VolumeService: createToken<VolumeService>('VolumeService'),

  /** Workspace service for project/collaboration contexts */
  WorkspaceService: createToken<WorkspaceService>('WorkspaceService'),

  /** Board service for projects, boards, and tasks */
  BoardService: createToken<BoardService>('BoardService'),

  /** Token usage tracking service */
  UsageService: createToken<UsageService>('UsageService'),

  /** LLM model configuration service */
  ModelService: createToken<ModelService>('ModelService'),

  /** LLM provider management service */
  ProviderService: createToken<ProviderService>('ProviderService'),

  /** Scheduled tasks service */
  SchedulerService: createToken<SchedulerService>('SchedulerService'),

  /** Session resume service */
  ResumeService: createToken<ResumeService>('ResumeService'),

  // ============================================================================
  // SESSION/STORAGE
  // ============================================================================

  /** MongoDB session store */
  SessionStore: createToken<MongoSessionStore>('SessionStore'),

  /** Session lock manager */
  LockManager: createToken<SessionLockManager>('LockManager'),

  // ============================================================================
  // HANDLERS
  // ============================================================================

  /** Event handler for scheduled events */
  EventHandler: createToken<EventHandler>('EventHandler'),

  /** WebSocket connection handler */
  WebSocketHandler: createToken<WebSocketHandler>('WebSocketHandler'),

  /** Message processing handler */
  MessageHandler: createToken<MessageHandler>('MessageHandler'),
} as const;

/**
 * Application configuration interface
 */
export interface AppConfig {
  mongodb: {
    uri: string;
    dbName: string;
  };
  server: {
    port: number;
    host: string;
  };
  admin: {
    apiKey?: string;
  };
  mca: {
    mcasPath: string;
    secretsPath: string;
    idleTimeoutMs: number;
    cleanupIntervalMs: number;
  };
  volumes: {
    basePath: string;
    defaultUserQuota: number;
    defaultWorkspaceQuota: number;
  };
}

/**
 * Type helper to extract the type from a token
 *
 * @example
 * ```typescript
 * type McaServiceType = TokenType<typeof Tokens.McaService>; // IMcaService
 * ```
 */
export type TokenType<T> = T extends Token<infer U> ? U : never;
