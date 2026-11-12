/**
 * Agent Apps Adapter — Station Registry
 *
 * Manages multiple stations across regions. Handles:
 * - Handshake initialization per station
 * - Health monitoring (periodic pings)
 * - Routing: which station to use for a given appId
 * - Failover: skip unhealthy stations
 * - Load balancing: weighted round-robin within healthy stations
 *
 * ZERO external dependencies.
 */

import type {
  StationEndpoint,
  StationState,
  StationStatus,
  Logger,
  AdapterEventHandler,
} from './types';
import { consoleLogger } from './types';
import * as protocol from './protocol-client';

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface StationRegistryConfig {
  stations: StationEndpoint[];
  globalToken?: string;
  host: { name: string; version: string };
  capabilities?: { directConnection?: boolean; platformActions?: string[] };
  initializeTimeoutMs?: number;
  pingIntervalMs?: number;
  failureThreshold?: number;
  recoveryThreshold?: number;
  logger?: Logger;
  onEvent?: AdapterEventHandler;
}

interface StationEntry {
  endpoint: StationEndpoint;
  state: StationState;
  negotiatedVersion?: string;
  appId?: string;
  appVersion?: string;
  activeSessions: number;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastSuccessAt?: Date;
  lastFailureAt?: Date;
  lastError?: string;
  /** Set after a successful initialize handshake */
  initialized: boolean;
}

export class StationRegistry {
  private entries = new Map<string, StationEntry>();
  private log: Logger;
  private globalToken?: string;
  private host: { name: string; version: string };
  private capabilities: { directConnection?: boolean; platformActions?: string[] };
  private initializeTimeoutMs: number;
  private failureThreshold: number;
  private recoveryThreshold: number;
  private pingInterval?: ReturnType<typeof setInterval>;
  private onEvent?: AdapterEventHandler;

  constructor(config: StationRegistryConfig) {
    this.log = config.logger ?? consoleLogger;
    this.globalToken = config.globalToken;
    this.host = config.host;
    this.capabilities = config.capabilities ?? {};
    this.initializeTimeoutMs = config.initializeTimeoutMs ?? 30_000;
    this.failureThreshold = config.failureThreshold ?? 3;
    this.recoveryThreshold = config.recoveryThreshold ?? 1;
    this.onEvent = config.onEvent;

    for (const ep of config.stations) {
      this.entries.set(ep.id, {
        endpoint: ep,
        state: 'unknown',
        activeSessions: 0,
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        initialized: false,
      });
    }

    const pingMs = config.pingIntervalMs ?? 60_000;
    if (pingMs > 0 && config.stations.length > 0) {
      this.pingInterval = setInterval(() => this.pingAll(), pingMs);
      if (this.pingInterval.unref) this.pingInterval.unref();
    }

    this.log.info('Station registry created', {
      stationCount: config.stations.length,
      regions: [...new Set(config.stations.map((c) => c.region).filter(Boolean))],
    });
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  /**
   * Initialize the handshake with a station.
   * Idempotent — skips if already initialized.
   */
  async initialize(stationId: string): Promise<void> {
    const entry = this.entries.get(stationId);
    if (!entry) throw new Error(`Unknown station: ${stationId}`);
    if (entry.initialized) return;

    const token = entry.endpoint.token ?? this.globalToken;

    try {
      const response = await protocol.initialize(
        entry.endpoint.url,
        this.host,
        this.capabilities,
        token,
        { timeoutMs: this.initializeTimeoutMs },
        this.log,
      );

      if (response.type === 'error') {
        throw new Error((response as any).error?.message ?? 'Initialize rejected');
      }

      entry.initialized = true;
      entry.negotiatedVersion = (response as any).negotiatedVersion ?? '2.0';
      entry.appId = (response as any).app?.id;
      entry.appVersion = (response as any).app?.version;
      this.markSuccess(entry);

      this.log.info('Station initialized', {
        stationId,
        appId: entry.appId,
        version: entry.appVersion,
      });
    } catch (error: any) {
      this.markFailure(entry, error.message);
      throw error;
    }
  }

  /**
   * Initialize ALL stations (best-effort, does not throw).
   */
  async initializeAll(): Promise<{ ok: string[]; failed: string[] }> {
    const ok: string[] = [];
    const failed: string[] = [];

    const promises = Array.from(this.entries.keys()).map(async (id) => {
      try {
        await this.initialize(id);
        ok.push(id);
      } catch {
        failed.push(id);
      }
    });

    await Promise.allSettled(promises);
    return { ok, failed };
  }

  // ---------------------------------------------------------------------------
  // Routing
  // ---------------------------------------------------------------------------

  /**
   * Find the best station for a given appId (and optionally workspaceId).
   *
   * Routing order:
   * 1. Stations that explicitly list this workspaceId (highest priority)
   * 2. Stations that explicitly list this appId (exact match)
   * 3. Stations with no filters (accept any)
   * 4. Among candidates: prefer healthy > degraded, then lowest load
   */
  resolve(appId: string, workspaceId?: string): { stationId: string; url: string; token?: string } | null {
    const candidates: Array<{ entry: StationEntry; score: number }> = [];

    for (const entry of this.entries.values()) {
      if (entry.state === 'unhealthy') continue;

      const ep = entry.endpoint;
      const isAppExplicit = ep.appIds && ep.appIds.includes(appId);
      const isAppWildcard = !ep.appIds || ep.appIds.length === 0;
      const isWorkspaceExplicit = workspaceId && ep.workspaceIds && ep.workspaceIds.includes(workspaceId);
      const hasWorkspaceFilter = ep.workspaceIds && ep.workspaceIds.length > 0;

      // Skip stations with a workspace filter that doesn't match
      if (hasWorkspaceFilter && !isWorkspaceExplicit) continue;
      // Skip stations with an app filter that doesn't match
      if (!isAppExplicit && !isAppWildcard) continue;

      // Check capacity
      if (ep.maxSessions && entry.activeSessions >= ep.maxSessions) continue;

      // Score: workspace match > app match > wildcard, healthy > degraded > unknown
      let score = 0;
      if (isWorkspaceExplicit) score += 2000;
      if (isAppExplicit) score += 1000;
      if (entry.state === 'healthy') score += 100;
      else if (entry.state === 'degraded') score += 50;
      else if (entry.state === 'unknown') score += 25;
      // Prefer less loaded stations
      score -= entry.activeSessions;
      // Apply weight
      score += (ep.weight ?? 1) * 10;

      candidates.push({ entry, score });
    }

    if (candidates.length === 0) return null;

    // Sort by score descending
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0].entry;

    return {
      stationId: best.endpoint.id,
      url: best.endpoint.url,
      token: best.endpoint.token ?? this.globalToken,
    };
  }

  /**
   * Get station info by ID.
   */
  get(stationId: string): { url: string; token?: string; initialized: boolean } | null {
    const entry = this.entries.get(stationId);
    if (!entry) return null;
    return {
      url: entry.endpoint.url,
      token: entry.endpoint.token ?? this.globalToken,
      initialized: entry.initialized,
    };
  }

  // ---------------------------------------------------------------------------
  // Session tracking
  // ---------------------------------------------------------------------------

  incrementSessions(stationId: string): void {
    const entry = this.entries.get(stationId);
    if (entry) entry.activeSessions++;
  }

  decrementSessions(stationId: string): void {
    const entry = this.entries.get(stationId);
    if (entry && entry.activeSessions > 0) entry.activeSessions--;
  }

  // ---------------------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------------------

  private async pingAll(): Promise<void> {
    for (const [id, entry] of this.entries) {
      try {
        const token = entry.endpoint.token ?? this.globalToken;
        const response = await protocol.stationHealth(
          entry.endpoint.url,
          token,
          false,
          { timeoutMs: 10_000 },
          this.log,
        );

        if (response.type === 'error') {
          this.markFailure(entry, (response as any).error?.message ?? 'health check failed');
        } else {
          const status = (response as any).status;
          if (status === 'degraded') {
            entry.state = 'degraded';
          }
          this.markSuccess(entry);
        }
      } catch (error: any) {
        this.markFailure(entry, error.message);
      }
    }
  }

  private markSuccess(entry: StationEntry): void {
    const wasUnhealthy = entry.state === 'unhealthy';
    entry.consecutiveFailures = 0;
    entry.consecutiveSuccesses++;
    entry.lastSuccessAt = new Date();

    if (entry.consecutiveSuccesses >= this.recoveryThreshold) {
      if (entry.state !== 'healthy') {
        entry.state = 'healthy';
        if (wasUnhealthy) {
          this.log.info('Station recovered', { stationId: entry.endpoint.id });
          this.onEvent?.({
            type: 'station:recovered',
            stationId: entry.endpoint.id,
          });
        } else {
          this.onEvent?.({
            type: 'station:healthy',
            stationId: entry.endpoint.id,
          });
        }
      }
    }
  }

  private markFailure(entry: StationEntry, error: string): void {
    entry.consecutiveSuccesses = 0;
    entry.consecutiveFailures++;
    entry.lastFailureAt = new Date();
    entry.lastError = error;

    if (entry.consecutiveFailures >= this.failureThreshold && entry.state !== 'unhealthy') {
      entry.state = 'unhealthy';
      this.log.error('Station marked unhealthy', {
        stationId: entry.endpoint.id,
        error,
        failures: entry.consecutiveFailures,
      });
      this.onEvent?.({
        type: 'station:unhealthy',
        stationId: entry.endpoint.id,
        error,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------

  getStatuses(): StationStatus[] {
    return Array.from(this.entries.values()).map((e) => ({
      id: e.endpoint.id,
      url: e.endpoint.url,
      state: e.state,
      region: e.endpoint.region,
      negotiatedVersion: e.negotiatedVersion,
      appId: e.appId,
      appVersion: e.appVersion,
      activeSessions: e.activeSessions,
      maxSessions: e.endpoint.maxSessions,
      consecutiveFailures: e.consecutiveFailures,
      lastSuccessAt: e.lastSuccessAt,
      lastFailureAt: e.lastFailureAt,
      lastError: e.lastError,
    }));
  }

  getHealthySummary(): { total: number; healthy: number; degraded: number; unhealthy: number } {
    let healthy = 0;
    let degraded = 0;
    let unhealthy = 0;
    for (const e of this.entries.values()) {
      if (e.state === 'healthy') healthy++;
      else if (e.state === 'degraded') degraded++;
      else if (e.state === 'unhealthy') unhealthy++;
    }
    return { total: this.entries.size, healthy, degraded, unhealthy };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Add a station at runtime (hot-add).
   */
  addStation(endpoint: StationEndpoint): void {
    if (this.entries.has(endpoint.id)) {
      this.log.warn('Station already registered, updating', { stationId: endpoint.id });
    }
    this.entries.set(endpoint.id, {
      endpoint,
      state: 'unknown',
      activeSessions: 0,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      initialized: false,
    });
    this.log.info('Station added', { stationId: endpoint.id, url: endpoint.url });
  }

  /**
   * Remove a station at runtime (hot-remove).
   * Does NOT close sessions — caller must drain sessions first.
   */
  removeStation(stationId: string): boolean {
    const removed = this.entries.delete(stationId);
    if (removed) {
      this.log.info('Station removed', { stationId });
    }
    return removed;
  }

  shutdown(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = undefined;
    }
  }
}
