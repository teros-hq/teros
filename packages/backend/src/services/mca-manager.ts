/**
 * MCA Manager
 *
 * Manages MCA (Model Context App) process lifecycle.
 * Each App gets its own MCP process with its specific config/secrets.
 *
 * Responsibilities:
 * - Spawn MCP processes on-demand (getOrSpawn)
 * - Kill processes (kill, killAll)
 * - Watchdog for auto-restart on crash
 * - Cleanup inactive processes (cleanupInactive)
 *
 * Architecture:
 * - One MCP process per App (not per agent, not per conversation)
 * - Config/secrets passed via environment variables
 * - Processes are reused across conversations for the same app
 *
 * Implementation is split across sub-modules:
 *   mca-manager.types.ts       — shared types & helpers
 *   mca-manager.spawn.ts       — spawn() dispatcher + SpawnContext
 *   mca-manager.spawn-container.ts — spawnContainer()
 *   mca-manager.spawn-stdio.ts — spawnStdio(), buildExecutionConfig(), setupWatchdog(), waitForReady()
 *   mca-manager.tools.ts       — tool loading, lookup, and execution
 *   mca-manager.health.ts      — health check methods
 */

import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { HealthIssue, HealthStatus, HealthCheckResult as SharedHealthCheckResult } from '@teros/shared';
import { appendFileSync, existsSync, mkdirSync } from 'fs';
import type { Db } from 'mongodb';
import { join } from 'path';
import { createInterface } from 'readline';
import type { Readable } from 'stream';
import { captureException } from '../lib/sentry';
import type { McaConnectionManager } from './mca-connection-manager';
import { McaContainerManager, envPositiveInt } from './mca-container-manager';
import { KubernetesContainerBackend } from './kubernetes-container-backend';
import { RemoteContainerBackend } from './remote-container-backend';
import { McaHttpClient } from './mca-http-client';
import { McaService } from './mca-service';
import { computeNextRestartCount } from './mca-manager.types';

import type {
  HealthCheckResult,
  ManagedMca,
  McaManagerConfig,
  StaticToolDefinition,
  ToolDefinition,
} from './mca-manager.types';

import { spawn, waitForReady } from './mca-manager.spawn';
import {
  checkHealth,
  checkAllHealth,
  getHealth,
  performInitialHealthCheck,
  updateHealthFromWebSocket,
  getCachedHealthIfNotReady,
} from './mca-manager.health';
import {
  invalidateStaticToolsCache,
  loadStaticTools,
  convertStaticTools,
  getMcaIdForTool,
  getToolsForApp,
  executeTool,
} from './mca-manager.tools';

import { createLogger } from '../lib/logger';

const log = createLogger('McaManager');

export class McaManager {
  private mcas = new Map<string, ManagedMca>();
  // Coalesces concurrent first-time spawns of the same app onto a single
  // promise. Without this, two tool calls for a dormant app both reach spawn()
  // before either registers 'starting', starting two containers with mismatched
  // MCA_CALLBACK_TOKENs (the surviving one fails callback auth → 401).
  private inFlightSpawns = new Map<string, Promise<ManagedMca>>();
  private mcaService: McaService;
  private config: Required<Omit<McaManagerConfig, 'secretsManager' | 'authManager' | 'volumeService'>> &
    Pick<McaManagerConfig, 'secretsManager' | 'authManager' | 'volumeService'>;
  private cleanupInterval?: NodeJS.Timeout;
  private isShuttingDown = false;

  private staticToolsCache = new Map<string, StaticToolDefinition[]>();
  private connectionManager?: McaConnectionManager;
  private containerManager: McaContainerManager;
  private httpClients = new Map<string, McaHttpClient>();
  private containerBackendHost: string;
  private containerMongoHost: string;

  constructor(db: Db, config: McaManagerConfig) {
    this.mcaService = new McaService(db, { secretsManager: config.secretsManager });
    const logDir = config.logDir ?? join(config.mcaBasePath, '..', 'logs', 'mcas');
    this.config = {
      mcaBasePath: config.mcaBasePath,
      secretsManager: config.secretsManager,
      authManager: config.authManager,
      volumeService: config.volumeService,
      // Same knob as McaContainerManager's container idle-kill: both cleanups
      // MUST share one clock. When this map outlived the containers (10 vs 30
      // min after the 2026-07-05 hardening), every tool call against an
      // idle-killed MCA returned "fetch failed" for up to 20 minutes
      // (stale-map window; see also the self-heal in executeToolViaHttp).
      maxIdleMs: config.maxIdleMs ?? envPositiveInt('MCA_IDLE_TIMEOUT_MS') ?? 30 * 60 * 1000,
      maxRestarts: config.maxRestarts ?? 3,
      cleanupIntervalMs: config.cleanupIntervalMs ?? 5 * 60 * 1000,
      serverPort: config.serverPort ?? 3000,
      logDir,
      enableMcaLogs: config.enableMcaLogs !== false,
    };

    if (this.config.enableMcaLogs && !existsSync(logDir)) {
      try {
        mkdirSync(logDir, { recursive: true });
        log.debug({ logDir }, 'Created MCA log directory');
      } catch (error) {
        log.warn({ err: error, logDir }, 'Failed to create log directory');
        this.config.enableMcaLogs = false;
      }
    }

    const containerProvider = process.env.CONTAINER_PROVIDER || 'remote';
    log.info({ containerProvider }, 'Container provider');

    let containerBackend;
    if (containerProvider === 'kubernetes') {
      const namespace = process.env.KUBERNETES_NAMESPACE || 'dev';
      const image = process.env.MCA_RUNTIME_IMAGE || 'teros/mca-runtime:latest';
      const backendServiceHost =
        process.env.BACKEND_SERVICE_HOST || `teros-backend.${namespace}.svc.cluster.local`;
      containerBackend = new KubernetesContainerBackend({
        namespace,
        defaultImage: image,
        backendServiceHost,
        backendPort: this.config.serverPort,
        imagePullSecret: process.env.IMAGE_PULL_SECRET || 'artifact-registry',
      });
    } else if (containerProvider === 'docker') {
      // Removed 2026-07-05 (simplification backlog item 1): the backend no
      // longer talks to Docker directly — the container agent is the only
      // Docker path. Fail loudly instead of silently changing behavior.
      throw new Error(
        'CONTAINER_PROVIDER=docker was removed: the container agent is the only ' +
          'Docker path now. Unset CONTAINER_PROVIDER (defaults to remote), run the ' +
          'teros-container-agent pm2 app, and set CONTAINER_AGENT_TOKEN/URL.',
      );
    } else {
      // Default: container agent (separate daemon, possibly another machine).
      // The backend holds no Docker access at all — all container operations
      // go over HTTP to the agent.
      containerBackend = new RemoteContainerBackend({
        agentUrl: process.env.CONTAINER_AGENT_URL || 'http://127.0.0.1:10011',
        agentToken: process.env.CONTAINER_AGENT_TOKEN || '',
      });
    }

    this.containerManager = new McaContainerManager({ backend: containerBackend });

    if (containerProvider === 'kubernetes') {
      const namespace = process.env.KUBERNETES_NAMESPACE || 'dev';
      this.containerBackendHost =
        process.env.BACKEND_SERVICE_HOST || `teros-backend.${namespace}.svc.cluster.local`;
      this.containerMongoHost =
        process.env.MCA_MONGODB_HOST || `mongodb.${namespace}.svc.cluster.local`;
    } else {
      // Host MCA containers use to reach the core (callbacks, WS). On a
      // remote execution machine set MCA_CALLBACK_HOST to the core's private
      // IP; the default only works when core and containers share a host.
      this.containerBackendHost = process.env.MCA_CALLBACK_HOST || 'host.docker.internal';
      // Host containers use to reach MONGO. This is NOT the backend host: Mongo is
      // published on the host loopback (docker-compose.yml: 127.0.0.1:27017), which
      // rejects bridge-gateway (host.docker.internal) traffic — ECONNREFUSED. Internal
      // MCAs (scheduler, memory, …) join `teros_teros-network` where Mongo resolves as
      // the compose service DNS `mongodb`, so that is the correct container-reachable
      // default. MCA_MONGODB_HOST overrides it for non-compose topologies (and the full
      // MCA_MONGODB_URI override in spawn-impl bypasses the rewrite entirely).
      this.containerMongoHost = process.env.MCA_MONGODB_HOST || 'mongodb';
    }
    log.debug(
      { host: this.containerBackendHost, mongoHost: this.containerMongoHost },
      'Container backend host',
    );

    this.startCleanupInterval();
  }

  // ---------------------------------------------------------------------------
  // Connection / container manager accessors
  // ---------------------------------------------------------------------------

  setConnectionManager(connectionManager: McaConnectionManager): void {
    this.connectionManager = connectionManager;
    log.debug('Connection manager set');
  }

  getConnectionManager(): McaConnectionManager | undefined {
    return this.connectionManager;
  }

  getContainerManager(): McaContainerManager {
    return this.containerManager;
  }

  // ---------------------------------------------------------------------------
  // Logging helpers
  // ---------------------------------------------------------------------------

  private logMcaOutput(appId: string, appName: string, mcaId: string, line: string): void {
    const timestamp = new Date().toISOString();
    const prefix = `[${appName}]`;
    log.debug({ prefix, line }, 'MCA stdout');

    if (this.config.enableMcaLogs) {
      try {
        const today = timestamp.substring(0, 10);
        const appLogDir = join(this.config.logDir, mcaId, appId);
        const logFile = join(appLogDir, `${today}.log`);
        if (!existsSync(appLogDir)) mkdirSync(appLogDir, { recursive: true });
        appendFileSync(logFile, `[${timestamp}] ${line}\n`);
      } catch {
        // Silently skip file logging failures
      }
    }
  }

  setupStderrLogging(
    appId: string,
    appName: string,
    mcaId: string,
    transport: StdioClientTransport,
  ): void {
    const stderr = transport.stderr;
    if (!stderr) { log.warn({ appId }, 'No stderr stream available'); return; }
    const rl = createInterface({ input: stderr as Readable });
    rl.on('line', (line) => this.logMcaOutput(appId, appName, mcaId, line));
    rl.on('error', (error: Error) => log.warn({ err: error, appId }, 'stderr readline error'));
  }

  toEnvKey(prefix: 'SECRET_MCA' | 'SECRET_USER', key: string): string {
    return `${prefix}_${key.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  }

  // ---------------------------------------------------------------------------
  // SpawnContext / HealthContext / ToolsContext builder
  // ---------------------------------------------------------------------------

  private get spawnCtx() {
    return {
      mcas: this.mcas,
      mcaService: this.mcaService,
      containerManager: this.containerManager,
      httpClients: this.httpClients,
      connectionManager: this.connectionManager,
      isShuttingDown: this.isShuttingDown,
      containerBackendHost: this.containerBackendHost,
      containerMongoHost: this.containerMongoHost,
      config: this.config,
      setupStderrLogging: this.setupStderrLogging.bind(this),
      toEnvKey: this.toEnvKey.bind(this),
      performInitialHealthCheck: (appId: string) => performInitialHealthCheck(this.healthCtx, appId),
    };
  }

  private get healthCtx() {
    return {
      mcas: this.mcas,
      mcaService: this.mcaService,
      config: this.config,
      getOrSpawn: this.getOrSpawn.bind(this),
      registerApp: this.registerApp.bind(this),
      executeTool: this.executeTool.bind(this),
    };
  }

  private get toolsCtx() {
    return {
      mcas: this.mcas,
      mcaService: this.mcaService,
      containerManager: this.containerManager,
      httpClients: this.httpClients,
      connectionManager: this.connectionManager,
      staticToolsCache: this.staticToolsCache,
      containerBackendHost: this.containerBackendHost,
      config: this.config,
      getOrSpawn: this.getOrSpawn.bind(this),
      registerApp: this.registerApp.bind(this),
    };
  }

  // ---------------------------------------------------------------------------
  // Static tools (public: used by McaBootSync)
  // ---------------------------------------------------------------------------

  invalidateStaticToolsCache(mcaId: string): void {
    invalidateStaticToolsCache(this.toolsCtx, mcaId);
  }

  getStaticToolsForMca(mcaId: string): StaticToolDefinition[] {
    return loadStaticTools(this.toolsCtx, mcaId);
  }

  // ---------------------------------------------------------------------------
  // App registration & spawn
  // ---------------------------------------------------------------------------

  async registerApp(appId: string): Promise<ManagedMca | null> {
    const existing = this.mcas.get(appId);
    if (existing) return existing;

    const app = await this.mcaService.getApp(appId);
    if (!app) { log.warn({ appId }, 'Cannot register app, not found'); return null; }

    const staticTools = loadStaticTools(this.toolsCtx, app.mcaId);
    if (staticTools.length === 0) {
      log.warn({ appId, mcaId: app.mcaId }, 'No static tools found for app');
      return null;
    }

    const { tools, mapping } = convertStaticTools(staticTools, app.name);

    const managed: ManagedMca = {
      appId, mcaId: app.mcaId, appName: app.name,
      client: null, transport: null,
      tools, toolNameMapping: mapping,
      status: 'standby', lastUsed: new Date(), restartCount: 0,
    };
    this.mcas.set(appId, managed);
    log.info({ appId, toolCount: tools.length }, 'Registered app (standby)');
    return managed;
  }

  async getOrSpawn(appId: string): Promise<ManagedMca> {
    const existing = this.mcas.get(appId);
    if (existing && existing.status === 'ready') { existing.lastUsed = new Date(); return existing; }
    if (existing && existing.status === 'disabled') throw new Error(`MCA ${appId} is disabled`);
    if (existing && existing.status === 'starting') return waitForReady(this.spawnCtx, appId);
    if (existing && existing.status === 'error' && existing.restartCount >= this.config.maxRestarts) {
      throw new Error(`MCA ${appId} failed after ${existing.restartCount} restart attempts: ${existing.lastError}`);
    }
    // Coalesce concurrent spawns: the 'starting' guard above only helps once
    // spawn() has registered state, but spawn() awaits getApp()/catalog first,
    // leaving a window where two concurrent calls both start a container. Reuse
    // the in-flight spawn promise so only one container is ever created.
    const inFlight = this.inFlightSpawns.get(appId);
    if (inFlight) return inFlight;
    // computeNextRestartCount: a retry of an MCA in 'error' counts as a restart
    // (+1), so the maxRestarts guard above eventually trips. Container MCAs have
    // no watchdog to bump restartCount → without this it stays 0 → infinite spawn
    // loop (a failing memory MCA re-spawned on every turn). TER-559.
    const spawnPromise = spawn(this.spawnCtx, appId, computeNextRestartCount(existing)).finally(
      () => {
        this.inFlightSpawns.delete(appId);
      },
    );
    this.inFlightSpawns.set(appId, spawnPromise);
    return spawnPromise;
  }

  // ---------------------------------------------------------------------------
  // Tool methods (delegated)
  // ---------------------------------------------------------------------------

  async executeTool(
    toolName: string,
    input: Record<string, any>,
    context?: {
      agentId?: string; channelId?: string; appId?: string;
      userId?: string; workspaceId?: string;
      userDisplayName?: string; userAvatarUrl?: string;
      signal?: AbortSignal;
    },
  ): Promise<{ output: string; isError: boolean; mcaId: string; attachments?: Array<{ url: string; mime: string; filename?: string }> }> {
    return executeTool(this.toolsCtx, toolName, input, context);
  }

  getMcaIdForTool(toolName: string): string | undefined {
    return getMcaIdForTool(this.toolsCtx, toolName);
  }

  async getToolsForApp(appId: string): Promise<{
    tools: ToolDefinition[];
    status: 'ready' | 'standby' | 'error' | 'disabled';
    error?: string;
  }> {
    return getToolsForApp(this.toolsCtx, appId);
  }

  // ---------------------------------------------------------------------------
  // Health methods (delegated)
  // ---------------------------------------------------------------------------

  async checkHealth(appId: string, forceSpawn: boolean = true): Promise<HealthCheckResult> {
    return checkHealth(this.healthCtx, appId, forceSpawn);
  }

  getHealth(appId: string): HealthCheckResult | undefined {
    return getHealth(this.healthCtx, appId);
  }

  async checkAllHealth(forceSpawn: boolean = false): Promise<Map<string, HealthCheckResult>> {
    return checkAllHealth(this.healthCtx, forceSpawn);
  }

  updateHealthFromWebSocket(appId: string, status: HealthStatus, issues?: HealthIssue[]): void {
    updateHealthFromWebSocket(this.healthCtx, appId, status, issues);
  }

  getCachedHealthIfNotReady(appId: string): HealthCheckResult | null {
    return getCachedHealthIfNotReady(this.healthCtx, appId);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle: kill / cleanup / shutdown
  // ---------------------------------------------------------------------------

  async kill(appId: string): Promise<void> {
    const managed = this.mcas.get(appId);
    if (!managed) return;
    log.info({ appId }, 'Killing MCA');
    managed.status = 'stopping';
    try {
      await managed.client?.close();
      managed.process?.kill();
    } catch (error: any) {
      log.warn({ err: error, appId }, 'Error killing MCA');
    }
  }

  async cleanupInactive(): Promise<string[]> {
    const now = Date.now();
    const toKill: string[] = [];

    for (const [appId, managed] of this.mcas.entries()) {
      const idleTime = now - managed.lastUsed.getTime();
      if (idleTime <= this.config.maxIdleMs || managed.status !== 'ready') continue;
      if (this.connectionManager) {
        const hasSubscriptions = await this.connectionManager.hasActiveSubscriptions(appId);
        if (hasSubscriptions) { log.debug({ appId }, 'Keeping MCA alive (has active subscriptions)'); continue; }
      }
      toKill.push(appId);
    }

    for (const appId of toKill) {
      log.debug({ appId }, 'Cleaning up inactive MCA');
      await this.kill(appId);
    }
    return toKill;
  }

  private startCleanupInterval(): void {
    this.cleanupInterval = setInterval(async () => {
      try {
        const cleaned = await this.cleanupInactive();
        if (cleaned.length > 0) log.info({ count: cleaned.length }, 'Cleaned up inactive MCAs');
      } catch (error) {
        log.error({ err: error }, 'Error in cleanup interval');
      }
    }, this.config.cleanupIntervalMs);
  }

  async shutdown(): Promise<void> {
    log.info('Shutting down all MCAs');
    this.isShuttingDown = true;
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    const appIds = Array.from(this.mcas.keys());
    for (const appId of appIds) await this.kill(appId);
    await this.containerManager.shutdown();
    this.httpClients.clear();
    log.info('All MCAs shut down');
  }

  // ---------------------------------------------------------------------------
  // Status / port
  // ---------------------------------------------------------------------------

  getMcaPort(mcaId: string): number | undefined {
    return this.containerManager.getContainerPort(mcaId);
  }

  getStatus(): Array<{
    appId: string; mcaId: string; status: string;
    toolCount: number; lastUsed: Date; restartCount: number; health?: HealthCheckResult;
  }> {
    return Array.from(this.mcas.values()).map((m) => ({
      appId: m.appId, mcaId: m.mcaId, status: m.status,
      toolCount: m.tools.length, lastUsed: m.lastUsed,
      restartCount: m.restartCount, health: m.health,
    }));
  }
}

// Re-export types that consumers import from this module
export type { McaStatus, ToolDefinition } from './mca-manager.types';
