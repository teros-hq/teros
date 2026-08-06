/**
 * Container Bootstrap
 *
 * Registers all dependencies for the Teros backend.
 * This is the composition root where all services are wired together.
 *
 * Rule: `new Service()` only here. Everywhere else: `container.get(Tokens.XService)`.
 *
 * @example
 * ```typescript
 * const container = await bootstrapContainer(options);
 * const wsHandler = container.get(Tokens.WebSocketHandler);
 * ```
 */

import { SessionLockManager } from '@teros/core';
import type { Db } from 'mongodb';
// Auth
import { AuthManager } from '../auth/auth-manager';
import { AuthService } from '../auth/auth-service';
import { DefaultAgentService } from '../auth/default-agent-service';
import { IdentityService } from '../auth/identity-service';
import { SessionService } from '../auth/session-service';
import { UserService } from '../auth/user-service';
// Handlers
import { EventHandler } from '../handlers/event-handler';
import { MessageHandler } from '../handlers/message-handler';
import { WebSocketHandler } from '../handlers/websocket-handler';
// Secrets
import { SecretsManager } from '../secrets/secrets-manager';
// Services
import { AutoplayService } from '../services/autoplay-service';
import { BoardService } from '../services/board-service';
import { BoardSubscriptionService } from '../services/board-subscription-service';
import { ChannelManager } from '../services/channel-manager';
import { DesktopStateService } from '../services/desktop-state-service';
import { McaManager } from '../services/mca-manager';
import { MCAEventSubscriptionService } from '../services/mca-event-subscription-service';
import { McaService } from '../services/mca-service';
import { ModelService } from '../services/model-service';
import { ProjectService } from '../services/project-service';
import { ProviderService } from '../services/provider-service';
import { PubSubService } from '../services/pubsub-service';
import { PtyManager } from '../services/pty-manager';
import { ResumeService } from '../services/resume-service';
import { SchedulerService } from '../services/scheduler-service';
import { SessionManager } from '../services/session-manager';
import { ShareService } from '../services/share-service';
import { SkillService } from '../services/skill-service';
import { UsageService } from '../services/usage-service';
import { UsageTrackingService } from '../services/usage-tracking-service';
import { VolumeService } from '../services/volume-service';
import { WorkspaceService } from '../services/workspace-service';
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
 * Registration order matters — dependencies must be registered before
 * anything that depends on them. Layers:
 * 1. Infrastructure (db, config, secrets)
 * 2. Auth services
 * 3. Core session services
 * 4. Business services (bottom-up: no deps → many deps)
 * 5. Handlers (top of the dependency tree)
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
    () => new SecretsManager(config.mca.secretsPath),
    { eager: true },
  );

  // ============================================================================
  // AUTH
  // ============================================================================

  container.register(Tokens.AuthManager, (c) => new AuthManager(c.get(Tokens.Db)));

  container.register(Tokens.AuthService, (c) => new AuthService(c.get(Tokens.Db)));

  container.register(Tokens.UserService, (c) => new UserService(c.get(Tokens.Db)));

  container.register(Tokens.IdentityService, (c) => new IdentityService(c.get(Tokens.Db)));

  container.register(Tokens.SessionService, (c) => new SessionService(c.get(Tokens.Db)));

  container.register(Tokens.DefaultAgentService, (c) => new DefaultAgentService(c.get(Tokens.Db)));

  // ============================================================================
  // CORE SESSION SERVICES
  // ============================================================================

  container.register(Tokens.SessionStore, (c) => new MongoSessionStore(c.get(Tokens.Db)));

  container.register(Tokens.LockManager, () => new SessionLockManager());

  container.register(Tokens.SessionManager, () => new SessionManager());

  container.register(
    Tokens.PubSubService,
    (c) => new PubSubService(c.get(Tokens.Db)),
    { eager: true },
  );

  container.register(
    Tokens.MCAEventSubscriptionService,
    (c) => new MCAEventSubscriptionService(c.get(Tokens.Db)),
  );

  // ============================================================================
  // BUSINESS SERVICES — Layer 1: no cross-service deps
  // ============================================================================

  container.register(Tokens.UsageService, (c) => new UsageService(c.get(Tokens.Db)));

  container.register(Tokens.UsageTrackingService, (c) => new UsageTrackingService(c.get(Tokens.Db)));

  container.register(Tokens.ModelService, (c) => new ModelService(c.get(Tokens.Db)));

  container.register(Tokens.ProviderService, (c) => new ProviderService(c.get(Tokens.Db)));

  container.register(Tokens.SkillService, (c) => new SkillService(c.get(Tokens.Db)));

  container.register(Tokens.ProjectService, (c) => new ProjectService(c.get(Tokens.Db)));

  container.register(Tokens.ShareService, (c) => new ShareService(c.get(Tokens.Db)));

  container.register(Tokens.DesktopStateService, (c) => new DesktopStateService(c.get(Tokens.Db)));

  container.register(Tokens.BoardService, (c) => new BoardService(c.get(Tokens.Db)));

  container.register(
    Tokens.BoardSubscriptionService,
    (c) => new BoardSubscriptionService(c.get(Tokens.Db)),
  );

  // ============================================================================
  // BUSINESS SERVICES — Layer 2: volume / workspace / mca stack
  // ============================================================================

  container.register(
    Tokens.VolumeService,
    (c) => new VolumeService(c.get(Tokens.Db), {
      basePath: config.volumes.basePath,
      defaultWorkspaceQuota: config.volumes.defaultWorkspaceQuota,
    }),
  );

  container.register(
    Tokens.WorkspaceService,
    (c) => new WorkspaceService(c.get(Tokens.Db), c.get(Tokens.VolumeService)),
  );

  container.register(
    Tokens.McaService,
    (c) => new McaService(c.get(Tokens.Db), {
      secretsManager: c.get(Tokens.SecretsManager),
      volumeService: c.get(Tokens.VolumeService),
      workspaceService: c.get(Tokens.WorkspaceService),
    }),
  );

  container.register(
    Tokens.McaManager,
    (c) => new McaManager(c.get(Tokens.Db), {
      mcaBasePath: config.mca.mcasPath,
      secretsManager: c.get(Tokens.SecretsManager),
      volumeService: c.get(Tokens.VolumeService),
      maxIdleMs: config.mca.idleTimeoutMs,
      cleanupIntervalMs: config.mca.cleanupIntervalMs,
    }),
  );

  // ============================================================================
  // BUSINESS SERVICES — Layer 3: channel / pub-sub dependents
  // ============================================================================

  container.register(
    Tokens.ChannelManager,
    (c) => new ChannelManager(c.get(Tokens.Db), c.get(Tokens.ProviderService)),
  );

  container.register(
    Tokens.PtyManager,
    (c) => new PtyManager(c.get(Tokens.PubSubService)),
  );

  container.register(
    Tokens.AutoplayService,
    (c) => new AutoplayService(
      c.get(Tokens.Db),
      c.get(Tokens.PubSubService),
      c.get(Tokens.ChannelManager),
    ),
  );

  // ============================================================================
  // HANDLERS
  // ============================================================================

  container.register(
    Tokens.EventHandler,
    (c) => new EventHandler(
      c.get(Tokens.Db),
      c.get(Tokens.SessionManager),
      c.get(Tokens.ChannelManager),
    ),
  );

  container.register(
    Tokens.SchedulerService,
    (c) => new SchedulerService(c.get(Tokens.Db), c.get(Tokens.EventHandler)),
  );

  container.register(
    Tokens.ResumeService,
    (c) => new ResumeService(
      c.get(Tokens.Db),
      c.get(Tokens.EventHandler),
      c.get(Tokens.ChannelManager),
    ),
  );

  container.register(
    Tokens.MessageHandler,
    (c) => new MessageHandler(
      c.get(Tokens.ChannelManager),
      c.get(Tokens.SessionManager),
      c.get(Tokens.Db),
      c.get(Tokens.SessionStore),
      c.get(Tokens.McaManager),
      undefined, // mockLLMClient — test override only
      undefined, // mockToolExecutor — test override only
      c.get(Tokens.SecretsManager),
      c.get(Tokens.ModelService),
      c.get(Tokens.ProviderService),
      c.get(Tokens.McaService),
      c.get(Tokens.UsageService),
      c.get(Tokens.UsageTrackingService),
    ),
  );

  container.register(
    Tokens.WebSocketHandler,
    (c) => new WebSocketHandler(
      c.get(Tokens.SessionManager),
      c.get(Tokens.ChannelManager),
      c.get(Tokens.Db),
      c.get(Tokens.McaManager),
    ),
  );

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
 * Create a test container with mock dependencies (synchronous, no eager init)
 *
 * @example
 * ```typescript
 * const container = createTestContainer({
 *   db: mockDb,
 *   config: testConfig,
 *   overrides: (c) => {
 *     c.registerInstance(Tokens.McaService, mockMcaService);
 *     c.registerInstance(Tokens.SkillService, mockSkillService);
 *   },
 * });
 * ```
 */
export function createTestContainer(options: BootstrapOptions): Container {
  const container = createContainer();
  registerDependencies(container, options);
  return container;
}
