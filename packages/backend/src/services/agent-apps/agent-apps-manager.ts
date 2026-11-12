/**
 * Agent Apps Adapter — Manager (Facade)
 *
 * High-level API for consuming Agent Apps from any host platform.
 * Coordinates the StationRegistry, SessionPool, and CatalogSync.
 *
 * This is the ONLY class external code needs to import.
 *
 * ZERO external dependencies — no database, no Teros, no framework imports.
 */

import type {
  AgentAppsConfig,
  StationEndpoint,
  StationStatus,
  RawToolDefinition,
  SessionInfo,
  ToolCallContext,
  ToolCallResult,
  InstanceHealth,
  DiscoveredApp,
  AnnouncePayload,
  AnnounceResult,
  AdapterEvent,
  AdapterEventHandler,
  RawUiResourceDefinition,
  UiResourceData,
  UiResourceSubmitResult,
  Logger,
} from './types';
import { consoleLogger } from './types';
import { StationRegistry } from './station-registry';
import { SessionPool } from './session-pool';
import { discoverAll, type SyncResult } from './catalog-sync';

export class AgentAppsManager {
  private registry: StationRegistry;
  private pool: SessionPool;
  private log: Logger;
  private eventHandlers: AdapterEventHandler[] = [];

  constructor(config: AgentAppsConfig) {
    this.log = config.logger ?? consoleLogger;

    const onEvent = (event: AdapterEvent) => {
      for (const handler of this.eventHandlers) {
        try {
          handler(event);
        } catch {
          // swallow listener errors
        }
      }
    };

    this.registry = new StationRegistry({
      stations: config.stations,
      globalToken: config.globalToken,
      host: config.host,
      capabilities: config.capabilities,
      initializeTimeoutMs: config.timeouts?.initializeMs,
      pingIntervalMs: config.health?.pingIntervalMs,
      failureThreshold: config.health?.failureThreshold,
      recoveryThreshold: config.health?.recoveryThreshold,
      logger: this.log,
      onEvent,
    });

    this.pool = new SessionPool({
      registry: this.registry,
      timeouts: {
        sessionOpenMs: config.timeouts?.sessionOpenMs,
        toolCallMs: config.timeouts?.toolCallMs,
        listToolsMs: config.timeouts?.listToolsMs,
        healthCheckMs: config.timeouts?.healthCheckMs,
      },
      idleTimeoutMs: config.sessions?.idleTimeoutMs,
      cleanupIntervalMs: config.sessions?.cleanupIntervalMs,
      logger: this.log,
      onEvent,
    });

    this.log.info('AgentAppsManager created', {
      stations: config.stations.map((c) => ({
        id: c.id,
        url: c.url,
        region: c.region,
      })),
    });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Initialize all stations (handshake). Call on startup.
   * Best-effort — returns which succeeded and which failed.
   */
  async initialize(): Promise<{ ok: string[]; failed: string[] }> {
    return this.registry.initializeAll();
  }

  /**
   * Graceful shutdown: close all sessions, stop health pings.
   */
  async shutdown(): Promise<void> {
    this.log.info('Shutting down AgentAppsManager');
    await this.pool.closeAll('shutdown');
    this.pool.shutdown();
    this.registry.shutdown();
  }

  // ---------------------------------------------------------------------------
  // Tool operations
  // ---------------------------------------------------------------------------

  /**
   * List tools available on an app.
   * Opens a session if needed.
   */
  async listTools(appId: string): Promise<RawToolDefinition[]> {
    const session = await this.pool.getOrOpen(appId);
    return session.tools;
  }

  /**
   * Execute a tool. Opens a session if needed.
   */
  async callTool(
    appId: string,
    toolName: string,
    args: Record<string, unknown>,
    context: ToolCallContext,
    signal?: AbortSignal,
  ): Promise<ToolCallResult> {
    return this.pool.callTool(appId, toolName, args, context, signal);
  }

  // ---------------------------------------------------------------------------
  // UI Resources
  // ---------------------------------------------------------------------------

  /**
   * List UI resources available on an app.
   * Opens a session if needed.
   */
  async listUiResources(appId: string): Promise<RawUiResourceDefinition[]> {
    const session = await this.pool.getOrOpen(appId);
    const stationInfo = this.registry.get(session.stationId);
    const { listUiResources } = await import('./protocol-client');
    const response = await listUiResources(
      session.stationUrl,
      session.sessionId,
      stationInfo?.token,
      undefined,
      this.log,
    );
    const resources = (response as any).resources;
    if (!Array.isArray(resources)) return [];
    return resources as RawUiResourceDefinition[];
  }

  /**
   * Get a specific UI resource's renderable data.
   * Opens a session if needed.
   */
  async getUiResource(
    appId: string,
    name: string,
    params: Record<string, unknown> = {},
  ): Promise<UiResourceData> {
    const session = await this.pool.getOrOpen(appId);
    const stationInfo = this.registry.get(session.stationId);
    const { getUiResource } = await import('./protocol-client');
    const response = await getUiResource(
      session.stationUrl,
      session.sessionId,
      name,
      params,
      stationInfo?.token,
      undefined,
      this.log,
    );
    const data = (response as any).data;
    if (!data) throw new Error(`Station returned no data for UI resource '${name}'`);
    return data as UiResourceData;
  }

  /**
   * Submit a form resource's values.
   * Opens a session if needed.
   */
  async submitUiResource(
    appId: string,
    name: string,
    values: Record<string, unknown>,
  ): Promise<UiResourceSubmitResult> {
    const session = await this.pool.getOrOpen(appId);
    const stationInfo = this.registry.get(session.stationId);
    const { submitUiResource } = await import('./protocol-client');
    const response = await submitUiResource(
      session.stationUrl,
      session.sessionId,
      name,
      values,
      stationInfo?.token,
      undefined,
      this.log,
    );
    return {
      success: (response as any).success ?? false,
      message: (response as any).message,
    };
  }

  // ---------------------------------------------------------------------------
  // Session management
  // ---------------------------------------------------------------------------

  /**
   * Ensure a session exists for an app. Does not execute any tool.
   */
  async warmup(appId: string): Promise<SessionInfo> {
    return this.pool.getOrOpen(appId);
  }

  /**
   * Close a session.
   */
  async closeSession(appId: string, reason = 'explicit', workspaceId?: string): Promise<void> {
    return this.pool.close(appId, reason, workspaceId);
  }

  /**
   * Get session info for an app (null if no session).
   */
  getSession(appId: string, workspaceId?: string): SessionInfo | null {
    return this.pool.getSession(appId, workspaceId);
  }

  /**
   * Get all active sessions.
   */
  getAllSessions(): SessionInfo[] {
    return this.pool.getAllSessions();
  }

  /**
   * Check if a session exists for an app.
   */
  hasSession(appId: string, workspaceId?: string): boolean {
    return this.pool.hasSession(appId, workspaceId);
  }

  // ---------------------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------------------

  /**
   * Health check for a specific app instance.
   */
  async checkInstanceHealth(appId: string, workspaceId?: string): Promise<InstanceHealth> {
    return this.pool.checkHealth(appId, workspaceId);
  }

  /**
   * Get station statuses.
   */
  getStationStatuses(): StationStatus[] {
    return this.registry.getStatuses();
  }

  /**
   * Summary of station health.
   */
  getStationHealthSummary(): {
    total: number;
    healthy: number;
    degraded: number;
    unhealthy: number;
  } {
    return this.registry.getHealthySummary();
  }

  // ---------------------------------------------------------------------------
  // Station management (hot-add/remove for scaling)
  // ---------------------------------------------------------------------------

  /**
   * Add a station at runtime. Useful for auto-scaling.
   */
  addStation(endpoint: StationEndpoint): void {
    this.registry.addStation(endpoint);
  }

  /**
   * Remove a station at runtime.
   * Closes all sessions on that station first.
   */
  async removeStation(stationId: string): Promise<void> {
    // Drain sessions from this station
    const sessions = this.pool.getAllSessions();
    for (const s of sessions) {
      if (s.stationId === stationId) {
        await this.pool.close(s.appId, 'station_removed', s.workspaceId);
      }
    }
    this.registry.removeStation(stationId);
  }

  // ---------------------------------------------------------------------------
  // Catalog discovery
  // ---------------------------------------------------------------------------

  /**
   * Discover apps from all stations.
   * Returns raw data — caller decides how to persist.
   */
  async discoverApps(): Promise<SyncResult> {
    return discoverAll({
      registry: this.registry,
      logger: this.log,
      onEvent: (event) => {
        for (const handler of this.eventHandlers) {
          try {
            handler(event);
          } catch {
            // swallow
          }
        }
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Push announcements (station → host)
  // ---------------------------------------------------------------------------

  /**
   * Handle a push announcement from a station.
   *
   * When a station starts up or registers a new app, it POSTs to the
   * host's announce endpoint. This method processes that payload:
   * - Auto-registers unknown stations
   * - Returns DiscoveredApp[] for the caller to persist however it wants
   *
   * The method itself does NOT touch any database — it returns structured
   * data that the host-specific bridge layer persists.
   */
  handleAnnounce(payload: AnnouncePayload): AnnounceResult & { discovered: DiscoveredApp[] } {
    const { stationId, stationUrl, region, apps } = payload;

    // Auto-register unknown stations
    let stationRegistered = false;
    const existing = this.registry.get(stationId);
    if (!existing) {
      this.registry.addStation({
        id: stationId,
        url: stationUrl,
        region,
        appIds: apps.map((a) => a.appId),
      });
      stationRegistered = true;

      this.log.info('Auto-registered station from announce', {
        stationId,
        stationUrl,
        region,
        appCount: apps.length,
      });

      this.emit({ type: 'station:registered', stationId, url: stationUrl });
    }

    const discovered: DiscoveredApp[] = [];
    const rejected: Array<{ appId: string; reason: string }> = [];

    for (const app of apps) {
      if (!app.appId || !app.name || !Array.isArray(app.tools)) {
        rejected.push({ appId: app.appId ?? '(missing)', reason: 'Invalid payload: missing appId, name, or tools' });
        continue;
      }

      discovered.push({
        appId: app.appId,
        name: app.name,
        version: app.version,
        tools: app.tools,
        stationId,
        stationUrl,
      });
    }

    this.log.info('Processed announce', {
      stationId,
      accepted: discovered.length,
      rejected: rejected.length,
    });

    this.emit({
      type: 'catalog:announced',
      stationId,
      apps: discovered.map((a) => a.appId),
    });

    return { accepted: discovered.length, rejected, stationRegistered, discovered };
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  private emit(event: AdapterEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch {
        // swallow listener errors
      }
    }
  }

  /**
   * Subscribe to adapter events.
   * Returns an unsubscribe function.
   */
  onEvent(handler: AdapterEventHandler): () => void {
    this.eventHandlers.push(handler);
    return () => {
      const idx = this.eventHandlers.indexOf(handler);
      if (idx >= 0) this.eventHandlers.splice(idx, 1);
    };
  }
}
