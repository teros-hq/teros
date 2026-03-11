/**
 * Container Bootstrap
 *
 * Registers all dependencies for the Teros backend.
 * This is the composition root where all services are wired together.
 *
 * @example
 * ```typescript
 * const container = await bootstrapContainer();
 * const wsHandler = container.get(Tokens.WebSocketHandler);
 * ```
 */

import { SessionLockManager } from '@teros/core';
import type { Db } from 'mongodb';
// Auth
import { AuthManager } from '../auth/auth-manager';
// Handlers
import { EventHandler } from '../handlers/event-handler';
import { MessageHandler } from '../handlers/message-handler';
import { WebSocketHandler } from '../handlers/websocket-handler';
// Secrets
import { SecretsManager } from '../secrets/secrets-manager';
import { ChannelManager } from '../services/channel-manager';
import { McaManager } from '../services/mca-manager';
import { McaService } from '../services/mca-service';
import { ModelService } from '../services/model-service';
import { ProviderService } from '../services/provider-service';
import { ResumeService } from '../services/resume-service';
import { SchedulerService } from '../services/scheduler-service';
// Services
import { SessionManager } from '../services/session-manager';
import { UsageService } from '../services/usage-service';
import { VolumeService } from '../services/volume-service';
// Session
import { MongoSessionStore } from '../session/MongoSessionStore';
import { type Container, createContainer } from './Container';
import { type AppConfig, Tokens } from './tokens';

/**
 * Bootstrap options
 */
export interface BootstrapOptions {
  /** MongoDB database instance */
  db: Db;
  /** Application configuration */
  config: AppConfig;
  /** Optional: Override specific registrations for testing */
  overrides?: (container: Container) => void;
}

/**
 * Register all dependencies in the container
 *
 * Registration order matters for eager dependencies.
 * Dependencies are grouped by layer:
 * 1. Infrastructure (db, config, secrets)
 * 2. Core services (session store, lock manager)
 * 3. Business services (mca, channel, usage, etc.)
 * 4. Handlers (websocket, message, event)
 */
export function registerDependencies(container: Container, options: BootstrapOptions): void {
  const { db, config } = options;

  // ============================================================================
  // INFRASTRUCTURE
  // ============================================================================

  container.registerInstance(Tokens.Db, db);
  container.registerInstance(Tokens.Config, config);

  container.register(
    Tokens.SecretsManager,
    () => {
      return new SecretsManager(config.mca.secretsPath);
    },
    { eager: true },
  );

  // ============================================================================
  // AUTH
  // ============================================================================

  container.register(Tokens.AuthManager, (c) => {
    return new AuthManager(c.get(Tokens.Db));
  });

  // ============================================================================
  // CORE SERVICES
  // ============================================================================

  container.register(Tokens.SessionStore, (c) => {
    return new MongoSessionStore(c.get(Tokens.Db));
  });

  container.register(Tokens.LockManager, () => {
    return new SessionLockManager();
  });

  container.register(Tokens.SessionManager, () => {
    return new SessionManager();
  });

  // ============================================================================
  // BUSINESS SERVICES
  // ============================================================================

  container.register(Tokens.ChannelManager, (c) => {
    return new ChannelManager(c.get(Tokens.Db), c.get(Tokens.ProviderService));
  });

  container.register(Tokens.VolumeService, (c) => {
    return new VolumeService(c.get(Tokens.Db), {
      basePath: config.volumes.basePath,
      defaultUserQuota: config.volumes.defaultUserQuota,
      defaultWorkspaceQuota: config.volumes.defaultWorkspaceQuota,
    });
  });

  container.register(Tokens.McaService, (c) => {
    return new McaService(c.get(Tokens.Db), {
      secretsManager: c.get(Tokens.SecretsManager),
      volumeService: c.get(Tokens.VolumeService),
    });
  });

  container.register(Tokens.McaManager, (c) => {
    return new McaManager(c.get(Tokens.Db), {
      mcaBasePath: config.mca.mcasPath,
      secretsManager: c.get(Tokens.SecretsManager),
      volumeService: c.get(Tokens.VolumeService),
      maxIdleMs: config.mca.idleTimeoutMs,
      cleanupIntervalMs: config.mca.cleanupIntervalMs,
    });
  });

  container.register(Tokens.UsageService, (c) => {
    return new UsageService(c.get(Tokens.Db));
  });

  container.register(Tokens.ModelService, (c) => {
    return new ModelService(c.get(Tokens.Db));
  });

  container.register(Tokens.ProviderService, (c) => {
    return new ProviderService(c.get(Tokens.Db));
  });

  // ============================================================================
  // HANDLERS
  // ============================================================================

  container.register(Tokens.EventHandler, (c) => {
    return new EventHandler(
      c.get(Tokens.Db),
      c.get(Tokens.SessionManager),
      c.get(Tokens.ChannelManager),
    );
  });

  container.register(Tokens.MessageHandler, (c) => {
    return new MessageHandler(
      c.get(Tokens.Db),
      c.get(Tokens.SessionManager),
      c.get(Tokens.ChannelManager),
      c.get(Tokens.McaManager),
    );
  });

  container.register(Tokens.WebSocketHandler, (c) => {
    return new WebSocketHandler(
      c.get(Tokens.SessionManager),
      c.get(Tokens.ChannelManager),
      c.get(Tokens.Db),
      c.get(Tokens.McaManager),
    );
  });

  // Scheduler depends on EventHandler
  container.register(Tokens.SchedulerService, (c) => {
    return new SchedulerService(c.get(Tokens.Db), c.get(Tokens.EventHandler));
  });

  container.register(Tokens.ResumeService, (c) => {
    return new ResumeService(
      c.get(Tokens.Db),
      c.get(Tokens.EventHandler),
      c.get(Tokens.ChannelManager),
    );
  });

  // ============================================================================
  // OVERRIDES (for testing)
  // ============================================================================

  if (options.overrides) {
    options.overrides(container);
  }
}

/**
 * Create and initialize a fully configured container
 */
export async function bootstrapContainer(options: BootstrapOptions): Promise<Container> {
  const container = createContainer();

  registerDependencies(container, options);

  await container.init();

  return container;
}

/**
 * Create a test container with mock dependencies
 *
 * @example
 * ```typescript
 * const container = createTestContainer({
 *   db: mockDb,
 *   config: testConfig,
 *   overrides: (c) => {
 *     c.registerInstance(Tokens.McaService, mockMcaService);
 *   },
 * });
 * ```
 */
export function createTestContainer(options: BootstrapOptions): Container {
  const container = createContainer();
  registerDependencies(container, options);
  return container;
}
