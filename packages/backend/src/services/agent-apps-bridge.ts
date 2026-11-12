/**
 * Agent Apps Bridge
 *
 * THIN adapter between the self-contained Agent Apps module and the
 * Teros backend. This is the ONLY file that imports both worlds.
 *
 * It implements the McaManager public surface by delegating to
 * AgentAppsManager, so McaToolExecutor works without changes.
 */

import type { HealthIssue, HealthStatus as SharedHealthStatus } from '@teros/shared';
import type { Db } from 'mongodb';
import { captureException } from '../lib/sentry';
import { createLogger as createTerosLogger } from '../lib/logger';
import { McaService } from './mca-service';
import { normalizeToolName } from '../types/permissions';
import { truncateToolOutput, type HealthCheckResult, type ManagedMca, type StaticToolDefinition, type ToolDefinition } from './mca-manager.types';
import type { McaConnectionManager } from './mca-connection-manager';
import type { McaManager } from './mca-manager';
import {
  AgentAppsManager,
  type AgentAppsConfig,
  type StationEndpoint,
  type RawToolDefinition,
  type AnnouncePayload,
  type AnnounceResult,
  type DiscoveredApp,
  type Logger as AdapterLogger,
  type CallbackRequest,
  type CallbackResponse,
  type LifecycleInstallRequest,
  type LifecycleUninstallRequest,
  type LifecycleInstallResponse,
  type LifecycleUninstallResponse,
} from './agent-apps';
import { CallbackHandlers, type CallbackHandlersConfig } from './agent-apps';

const log = createTerosLogger('AgentAppsBridge');

// ---------------------------------------------------------------------------
// Config helper
// ---------------------------------------------------------------------------

export interface AgentAppsBridgeConfig {
  /** Station endpoints */
  stations: StationEndpoint[];
  /** Global bearer token */
  globalToken?: string;
  /** Tool call timeout (ms, default: 60_000) */
  toolCallTimeoutMs?: number;
  /** Server port (for compatibility) */
  serverPort?: number;
  /**
   * Local McaManager for Teros-native apps that run as local processes.
   * When set, apps unknown to the bridge are routed here instead of
   * returning "not found".
   */
  localManager?: McaManager;
}

/**
 * Build an AdapterLogger that delegates to Teros's pino-based logger.
 */
function createBridgeLogger(): AdapterLogger {
  return {
    debug: (msg, data) => log.debug(data ?? {}, msg),
    info: (msg, data) => log.info(data ?? {}, msg),
    warn: (msg, data) => log.warn(data ?? {}, msg),
    error: (msg, data) => log.error(data ?? {}, msg),
  };
}

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

/**
 * Drop-in replacement for McaManager that routes everything through
 * the Agent Apps adapter.
 *
 * McaToolExecutor calls methods on this class exactly as it would on
 * McaManager. The bridge translates between Teros-specific types
 * (ToolDefinition, ManagedMca, HealthCheckResult) and the adapter's
 * generic types (RawToolDefinition, ToolCallResult, InstanceHealth).
 */
export class AgentAppsBridge {
  private adapter: AgentAppsManager;
  private mcaService: McaService;
  private localManager?: McaManager;
  private callbackHandlers: CallbackHandlers;
  private staticToolsCache = new Map<string, StaticToolDefinition[]>();
  /** Maps sanitized tool name → { appId, originalName } for all registered apps */
  private toolIndex = new Map<string, { appId: string; mcaId: string; originalName: string }>();

  constructor(db: Db, config: AgentAppsBridgeConfig) {
    this.mcaService = new McaService(db);
    this.localManager = config.localManager;
    this.callbackHandlers = new CallbackHandlers({
      db,
      logger: createBridgeLogger(),
    });

    const adapterConfig: AgentAppsConfig = {
      stations: config.stations,
      globalToken: config.globalToken,
      host: { name: 'teros', version: '1.0.0' },
      capabilities: { directConnection: false, platformActions: ['boards', 'scheduler', 'conversations'] },
      timeouts: { toolCallMs: config.toolCallTimeoutMs ?? 60_000 },
      logger: createBridgeLogger(),
    };

    this.adapter = new AgentAppsManager(adapterConfig);

    // Forward adapter events to Sentry/logging
    this.adapter.onEvent((event) => {
      if (event.type === 'session:error' || event.type === 'station:unhealthy') {
        log.error(event as any, `Adapter event: ${event.type}`);
      } else {
        log.debug(event as any, `Adapter event: ${event.type}`);
      }
    });

    // Fire-and-forget initialization
    this.adapter.initialize().then(({ ok, failed }) => {
      log.info({ ok, failed }, 'Stations initialized');
      if (failed.length > 0) {
        log.warn({ failed }, 'Some stations failed to initialize');
      }
    }).catch((err) => {
      log.error({ err }, 'Station initialization failed');
      captureException(err, { context: 'AgentAppsBridge.initialize' });
    });
  }

  // ---------------------------------------------------------------------------
  // Routing
  // ---------------------------------------------------------------------------

  /**
   * Check if an app is served by a remote Station (as opposed to a local MCA).
   * An app is remote when it has tools in the static cache (populated by
   * Station announcements or previous fetches).
   */
  private isRemoteApp(mcaId: string): boolean {
    return this.staticToolsCache.has(mcaId);
  }

  // ---------------------------------------------------------------------------
  // Public API (matches McaManager's surface used by McaToolExecutor)
  // ---------------------------------------------------------------------------

  async registerApp(appId: string): Promise<ManagedMca | null> {
    const app = await this.mcaService.getApp(appId);
    if (!app) {
      // Not in catalog — try local manager
      if (this.localManager) return this.localManager.registerApp(appId);
      log.warn({ appId }, 'Cannot register app, not found');
      return null;
    }

    // If the app is not known as remote, delegate to local manager
    if (!this.isRemoteApp(app.mcaId) && this.localManager) {
      return this.localManager.registerApp(appId);
    }

    try {
      // Warmup the session (or just register tools if we have them cached)
      const tools = this.getStaticToolsForMca(app.mcaId);
      if (tools.length > 0) {
        const converted = this.convertAndIndex(tools, app.name, appId, app.mcaId);
        return this.buildManagedMca(appId, app.mcaId, app.name, converted.tools, converted.mapping, 'standby');
      }

      // No cached tools — try to fetch from station
      const rawTools = await this.adapter.listTools(appId);
      const converted = this.convertRawAndIndex(rawTools, app.name, appId, app.mcaId);

      // Also cache as static tools for future use
      this.setStaticToolsFromRaw(app.mcaId, rawTools);

      return this.buildManagedMca(appId, app.mcaId, app.name, converted.tools, converted.mapping, 'ready');
    } catch (error: any) {
      log.error({ err: error, appId }, 'Failed to register app via Agent Apps');
      captureException(error, { context: 'AgentAppsBridge.registerApp', appId });
      return null;
    }
  }

  async getOrSpawn(appId: string): Promise<ManagedMca> {
    const app = await this.mcaService.getApp(appId);
    if (!app) throw new Error(`App not found: ${appId}`);

    const session = await this.adapter.warmup(appId);
    const converted = this.convertRawAndIndex(session.tools, app.name, appId, app.mcaId);
    this.setStaticToolsFromRaw(app.mcaId, session.tools);

    return this.buildManagedMca(appId, app.mcaId, app.name, converted.tools, converted.mapping, 'ready');
  }

  async executeTool(
    toolName: string,
    input: Record<string, any>,
    context?: {
      agentId?: string;
      channelId?: string;
      appId?: string;
      userId?: string;
      workspaceId?: string;
      userDisplayName?: string;
      userAvatarUrl?: string;
      signal?: AbortSignal;
    },
  ): Promise<{ output: string; isError: boolean; mcaId: string; attachments?: Array<{ url: string; mime: string; filename?: string }> }> {
    // Resolve tool → app
    const indexed = this.toolIndex.get(toolName);
    const appId = context?.appId ?? indexed?.appId;

    // Tool not known to the bridge — delegate to local manager
    if (!indexed && this.localManager) {
      return this.localManager.executeTool(toolName, input, context);
    }

    if (!appId) {
      return {
        output: `Error: Tool '${toolName}' not found. The app may not be installed.`,
        isError: true,
        mcaId: 'unknown',
      };
    }

    const originalToolName = indexed?.originalName ?? toolName;
    const mcaId = indexed?.mcaId ?? 'unknown';

    try {
      const result = await this.adapter.callTool(
        appId,
        originalToolName,
        input,
        {
          installationId: appId,
          userId: context?.userId,
          workspaceId: context?.workspaceId,
          channelId: context?.channelId,
          agentId: context?.agentId,
          userDisplayName: context?.userDisplayName,
          userAvatarUrl: context?.userAvatarUrl,
        },
        context?.signal,
      );

      const output = truncateToolOutput(result.output, toolName, appId);

      return {
        output,
        isError: !result.success,
        mcaId,
        ...(result.attachments ? { attachments: result.attachments } : {}),
      };
    } catch (error: any) {
      log.error({ err: error, toolName, appId }, 'Tool execution failed');
      captureException(error, { context: 'AgentAppsBridge.executeTool', toolName, appId });
      return {
        output: `Error executing tool '${toolName}': ${error.message}`,
        isError: true,
        mcaId,
      };
    }
  }

  getMcaIdForTool(toolName: string): string | undefined {
    return this.toolIndex.get(toolName)?.mcaId ?? this.localManager?.getMcaIdForTool(toolName);
  }

  async getToolsForApp(appId: string): Promise<{
    tools: ToolDefinition[];
    status: 'ready' | 'standby' | 'error' | 'disabled';
    error?: string;
  }> {
    const app = await this.mcaService.getApp(appId);
    if (!app) {
      if (this.localManager) return this.localManager.getToolsForApp(appId);
      return { tools: [], status: 'error', error: `App not found: ${appId}` };
    }

    // Not a remote app — delegate to local manager
    if (!this.isRemoteApp(app.mcaId) && this.localManager) {
      return this.localManager.getToolsForApp(appId);
    }

    // Try cached static tools first
    const staticTools = this.getStaticToolsForMca(app.mcaId);
    if (staticTools.length > 0) {
      const { tools } = this.convertAndIndex(staticTools, app.name, appId, app.mcaId);
      return { tools, status: 'standby' };
    }

    // Fetch from station
    try {
      const rawTools = await this.adapter.listTools(appId);
      const { tools } = this.convertRawAndIndex(rawTools, app.name, appId, app.mcaId);
      this.setStaticToolsFromRaw(app.mcaId, rawTools);
      return { tools, status: 'ready' };
    } catch (error: any) {
      return { tools: [], status: 'error', error: error.message };
    }
  }

  async checkHealth(appId: string, forceSpawn = true): Promise<HealthCheckResult> {
    if (!forceSpawn && !this.adapter.hasSession(appId)) {
      return { status: 'not_ready', message: 'No active session', checkedAt: new Date() };
    }
    const health = await this.adapter.checkInstanceHealth(appId);
    return {
      status: health.status,
      message: health.message,
      issues: health.issues as any,
      version: health.version,
      uptime: health.uptime,
      checkedAt: health.checkedAt,
    };
  }

  getHealth(appId: string): HealthCheckResult | undefined {
    const session = this.adapter.getSession(appId);
    return session ? { status: 'ready', checkedAt: new Date() } : undefined;
  }

  async checkAllHealth(forceSpawn = false): Promise<Map<string, HealthCheckResult>> {
    const sessions = this.adapter.getAllSessions();
    const results = new Map<string, HealthCheckResult>();
    for (const s of sessions) {
      results.set(s.appId, await this.checkHealth(s.appId, forceSpawn));
    }
    return results;
  }

  updateHealthFromWebSocket(appId: string, status: SharedHealthStatus, issues?: HealthIssue[]): void {
    // Remote apps manage health through the Agent Apps protocol.
    // Local apps use WebSocket health updates.
    this.localManager?.updateHealthFromWebSocket(appId, status, issues);
  }

  getCachedHealthIfNotReady(appId: string): HealthCheckResult | null {
    return this.localManager?.getCachedHealthIfNotReady(appId) ?? null;
  }

  // ---------------------------------------------------------------------------
  // Static tools cache (for McaBootSync compatibility)
  // ---------------------------------------------------------------------------

  invalidateStaticToolsCache(mcaId: string): void {
    this.staticToolsCache.delete(mcaId);
  }

  getStaticToolsForMca(mcaId: string): StaticToolDefinition[] {
    return this.staticToolsCache.get(mcaId) ?? [];
  }

  setStaticToolsForMca(mcaId: string, tools: StaticToolDefinition[]): void {
    this.staticToolsCache.set(mcaId, tools);
  }

  // ---------------------------------------------------------------------------
  // Connection manager (compatibility stubs)
  // ---------------------------------------------------------------------------

  setConnectionManager(cm: McaConnectionManager): void {
    this.localManager?.setConnectionManager(cm);
  }

  getConnectionManager(): McaConnectionManager | undefined {
    return this.localManager?.getConnectionManager();
  }

  getContainerManager(): any {
    return this.localManager?.getContainerManager() ?? null;
  }

  getMcaPort(mcaId: string): number | undefined {
    return this.localManager?.getMcaPort(mcaId);
  }

  // ---------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------

  getStatus(): Array<{
    appId: string;
    mcaId: string;
    status: string;
    toolCount: number;
    lastUsed: Date;
    restartCount: number;
    health?: HealthCheckResult;
  }> {
    const remote = this.adapter.getAllSessions().map((s) => ({
      appId: s.appId,
      mcaId: s.appId, // In Agent Apps, appId is the primary identifier
      status: s.status,
      toolCount: s.tools.length,
      lastUsed: s.lastUsedAt,
      restartCount: 0,
      health: { status: s.status === 'active' ? 'ready' as const : 'not_ready' as const, checkedAt: new Date() },
    }));
    const local = this.localManager?.getStatus() ?? [];
    return [...remote, ...local];
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async kill(appId: string): Promise<void> {
    if (this.adapter.hasSession(appId)) {
      await this.adapter.closeSession(appId);
    } else if (this.localManager) {
      await this.localManager.kill(appId);
    }
  }

  async shutdown(): Promise<void> {
    await this.adapter.shutdown();
    if (this.localManager) {
      await this.localManager.shutdown();
    }
  }

  // ---------------------------------------------------------------------------
  // Scaling — exposed for admin endpoints
  // ---------------------------------------------------------------------------

  addStation(endpoint: StationEndpoint): void {
    this.adapter.addStation(endpoint);
  }

  async removeStation(stationId: string): Promise<void> {
    await this.adapter.removeStation(stationId);
  }

  getStationStatuses() {
    return this.adapter.getStationStatuses();
  }

  async discoverApps() {
    return this.adapter.discoverApps();
  }

  /**
   * Handle a push announcement from a station.
   * Returns discovered apps for the route handler to persist.
   */
  handleAnnounce(payload: AnnouncePayload): AnnounceResult & { discovered: DiscoveredApp[] } {
    return this.adapter.handleAnnounce(payload);
  }

  // ---------------------------------------------------------------------------
  // Callback handling (station → host requests)
  // ---------------------------------------------------------------------------

  /**
   Handle a callback request from a remote station. When a station's app
   calls ctx.storage.put(), ctx.files.object.put(), etc., the station sends
   a callback request to the host. This method dispatches it to the
   appropriate handler and returns the response.
   */
  async handleCallback(request: CallbackRequest): Promise<CallbackResponse> {
    return this.callbackHandlers.handle(request);
  }

  /**
   * Get the callback handlers instance (for use by route handlers).
   */
  getCallbackHandlers(): CallbackHandlers {
    return this.callbackHandlers;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle management
  // ---------------------------------------------------------------------------

  /**
   * Trigger a lifecycle install event for an app installation.
   * Records the installation in MongoDB and returns success.
   */
  async triggerInstall(
    installationId: string,
    workspaceId?: string,
    userId?: string,
  ): Promise<LifecycleInstallResponse> {
    const request: LifecycleInstallRequest = {
      type: 'lifecycle_install',
      installationId,
      workspaceId,
      userId,
    };
    const response = await this.callbackHandlers.handle(request);
    return response as LifecycleInstallResponse;
  }

  /**
   * Trigger a lifecycle uninstall event for an app installation.
   * Marks the installation as uninstalled and cleans up object storage.
   */
  async triggerUninstall(
    installationId: string,
    workspaceId?: string,
  ): Promise<LifecycleUninstallResponse> {
    const request: LifecycleUninstallRequest = {
      type: 'lifecycle_uninstall',
      installationId,
      workspaceId,
    };
    const response = await this.callbackHandlers.handle(request);
    return response as LifecycleUninstallResponse;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private convertAndIndex(
    staticTools: StaticToolDefinition[],
    appName: string,
    appId: string,
    mcaId: string,
  ): { tools: ToolDefinition[]; mapping: Map<string, string> } {
    const tools: ToolDefinition[] = [];
    const mapping = new Map<string, string>();

    for (const tool of staticTools) {
      if (tool.name.startsWith('_')) continue;

      const kebab = normalizeToolName(tool.name);
      const sanitized = `${appName}_${kebab}`;
      mapping.set(sanitized, tool.name);

      this.toolIndex.set(sanitized, { appId, mcaId, originalName: tool.name });

      tools.push({
        name: sanitized,
        description: tool.description,
        input_schema: {
          type: 'object' as const,
          properties: tool.inputSchema.properties || {},
          required: tool.inputSchema.required,
        },
        ...(tool.annotations ? { annotations: tool.annotations as any } : {}),
      });
    }

    return { tools, mapping };
  }

  private convertRawAndIndex(
    rawTools: RawToolDefinition[],
    appName: string,
    appId: string,
    mcaId: string,
  ): { tools: ToolDefinition[]; mapping: Map<string, string> } {
    const tools: ToolDefinition[] = [];
    const mapping = new Map<string, string>();

    for (const raw of rawTools) {
      if (raw.name.startsWith('_')) continue;

      const kebab = normalizeToolName(raw.name);
      const sanitized = `${appName}_${kebab}`;
      mapping.set(sanitized, raw.name);

      this.toolIndex.set(sanitized, { appId, mcaId, originalName: raw.name });

      tools.push({
        name: sanitized,
        description: raw.description,
        input_schema: {
          type: 'object' as const,
          properties: (raw.parameters as any)?.properties ?? {},
          required: (raw.parameters as any)?.required,
        },
        ...(raw.annotations ? { annotations: raw.annotations as any } : {}),
      });
    }

    return { tools, mapping };
  }

  private setStaticToolsFromRaw(mcaId: string, rawTools: RawToolDefinition[]): void {
    const staticTools: StaticToolDefinition[] = rawTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: {
        type: 'object' as const,
        properties: (t.parameters as any)?.properties ?? {},
        required: (t.parameters as any)?.required,
      },
      ...(t.annotations ? { annotations: t.annotations as any } : {}),
    }));
    this.staticToolsCache.set(mcaId, staticTools);
  }

  private buildManagedMca(
    appId: string,
    mcaId: string,
    appName: string,
    tools: ToolDefinition[],
    toolNameMapping: Map<string, string>,
    status: 'ready' | 'standby',
  ): ManagedMca {
    return {
      appId,
      mcaId,
      appName,
      client: null,
      transport: null,
      tools,
      toolNameMapping,
      status,
      lastUsed: new Date(),
      restartCount: 0,
    };
  }
}
