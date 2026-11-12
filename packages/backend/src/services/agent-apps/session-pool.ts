/**
 * Agent Apps Adapter — Session Pool
 *
 * Manages the lifecycle of Agent App sessions across stations.
 * Sessions are opened on-demand and closed after idle timeout.
 *
 * Responsibilities:
 * - Open sessions on the best available station
 * - Cache tool definitions per session
 * - Close idle sessions periodically
 * - Re-route to a different station on failure
 *
 * ZERO external dependencies.
 */

import type {
  RawToolDefinition,
  SessionInfo,
  ToolCallContext,
  ToolCallResult,
  InstanceHealth,
  Logger,
  AdapterEventHandler,
} from './types';
import { consoleLogger } from './types';
import type { StationRegistry } from './station-registry';
import * as protocol from './protocol-client';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SessionPoolConfig {
  registry: StationRegistry;
  timeouts?: {
    sessionOpenMs?: number;
    toolCallMs?: number;
    listToolsMs?: number;
    healthCheckMs?: number;
  };
  idleTimeoutMs?: number;
  cleanupIntervalMs?: number;
  logger?: Logger;
  onEvent?: AdapterEventHandler;
}

// ---------------------------------------------------------------------------
// Internal session state
// ---------------------------------------------------------------------------

interface PooledSession {
  sessionId: string;
  appId: string;
  workspaceId?: string;
  stationId: string;
  stationUrl: string;
  stationToken?: string;
  tools: RawToolDefinition[];
  status: 'active' | 'idle' | 'error' | 'closed';
  lastUsedAt: Date;
  createdAt: Date;
  lastError?: string;
  health?: InstanceHealth;
}

// ---------------------------------------------------------------------------
// Session Pool
// ---------------------------------------------------------------------------

export class SessionPool {
  private sessions = new Map<string, PooledSession>();
  /** Coalesces concurrent opens for the same appId (or appId::workspaceId) */
  private inflightOpens = new Map<string, Promise<PooledSession>>();
  private registry: StationRegistry;
  private log: Logger;
  private onEvent?: AdapterEventHandler;

  private sessionOpenMs: number;
  private toolCallMs: number;
  private listToolsMs: number;
  private healthCheckMs: number;
  private idleTimeoutMs: number;
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(config: SessionPoolConfig) {
    this.registry = config.registry;
    this.log = config.logger ?? consoleLogger;
    this.onEvent = config.onEvent;

    this.sessionOpenMs = config.timeouts?.sessionOpenMs ?? 30_000;
    this.toolCallMs = config.timeouts?.toolCallMs ?? 60_000;
    this.listToolsMs = config.timeouts?.listToolsMs ?? 10_000;
    this.healthCheckMs = config.timeouts?.healthCheckMs ?? 10_000;
    this.idleTimeoutMs = config.idleTimeoutMs ?? 30 * 60 * 1000;

    const cleanupMs = config.cleanupIntervalMs ?? 5 * 60 * 1000;
    if (cleanupMs > 0) {
      this.cleanupTimer = setInterval(() => this.cleanupIdle(), cleanupMs);
      if (this.cleanupTimer.unref) this.cleanupTimer.unref();
    }
  }

  // ---------------------------------------------------------------------------
  // Session key helpers
  // ---------------------------------------------------------------------------

  /**
   * Build the session key. Workspace-scoped sessions use `appId::workspaceId`.
   * No fallback scanning — callers must always provide the workspaceId they
   * used when opening the session.
   */
  private sessionKey(appId: string, workspaceId?: string): string {
    return workspaceId ? `${appId}::${workspaceId}` : appId;
  }

  // ---------------------------------------------------------------------------
  // Open / Get
  // ---------------------------------------------------------------------------

  /**
   * Get an active session for an appId (scoped to workspaceId if provided),
   * or open one.
   */
  async getOrOpen(
    appId: string,
    tenant?: { userId?: string; workspaceId?: string },
  ): Promise<SessionInfo> {
    const key = this.sessionKey(appId, tenant?.workspaceId);

    // Return existing active session
    const existing = this.sessions.get(key);
    if (existing && existing.status === 'active') {
      existing.lastUsedAt = new Date();
      return this.toInfo(existing);
    }

    // Coalesce concurrent opens
    const inflight = this.inflightOpens.get(key);
    if (inflight) {
      const session = await inflight;
      return this.toInfo(session);
    }

    const openPromise = this.doOpen(appId, tenant);
    this.inflightOpens.set(key, openPromise);

    try {
      const session = await openPromise;
      return this.toInfo(session);
    } finally {
      this.inflightOpens.delete(key);
    }
  }

  private async doOpen(
    appId: string,
    tenant?: { userId?: string; workspaceId?: string },
  ): Promise<PooledSession> {
    const key = this.sessionKey(appId, tenant?.workspaceId);

    // Find a station (workspace-aware routing)
    const route = this.registry.resolve(appId, tenant?.workspaceId);
    if (!route) {
      throw new Error(`No healthy station available for app '${appId}'`);
    }

    // Ensure handshake
    await this.registry.initialize(route.stationId);

    // Open session
    const response = await protocol.sessionOpen(
      route.url,
      appId,
      { userId: tenant?.userId ?? 'system', workspaceId: tenant?.workspaceId },
      route.token,
      { timeoutMs: this.sessionOpenMs },
      this.log,
    );

    if (response.type === 'error') {
      throw new Error(
        `Failed to open session: ${(response as any).error?.message ?? JSON.stringify(response)}`,
      );
    }

    const sessionId = (response as any).sessionId as string;

    // Fetch tools
    const tools = await this.fetchTools(route.url, route.token, sessionId);

    const session: PooledSession = {
      sessionId,
      appId,
      workspaceId: tenant?.workspaceId,
      stationId: route.stationId,
      stationUrl: route.url,
      stationToken: route.token,
      tools,
      status: 'active',
      lastUsedAt: new Date(),
      createdAt: new Date(),
    };

    this.sessions.set(key, session);
    this.registry.incrementSessions(route.stationId);

    this.log.info('Session opened', {
      sessionId,
      appId,
      stationId: route.stationId,
      toolCount: tools.length,
    });

    this.onEvent?.({
      type: 'session:opened',
      sessionId,
      appId,
      stationId: route.stationId,
    });

    return session;
  }

  private async fetchTools(
    stationUrl: string,
    token: string | undefined,
    sessionId: string,
  ): Promise<RawToolDefinition[]> {
    try {
      const response = await protocol.listTools(
        stationUrl,
        sessionId,
        token,
        { timeoutMs: this.listToolsMs },
        this.log,
      );

      if (response.type === 'error') {
        this.log.warn('list_tools failed', { sessionId, error: response });
        return [];
      }

      return ((response as any).tools ?? []) as RawToolDefinition[];
    } catch (error: any) {
      this.log.warn('Failed to fetch tools', { sessionId, error: error.message });
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Tool execution
  // ---------------------------------------------------------------------------

  /**
   * Execute a tool on an active session.
   * Opens the session if needed.
   */
  async callTool(
    appId: string,
    toolName: string,
    args: Record<string, unknown>,
    context: ToolCallContext,
    signal?: AbortSignal,
  ): Promise<ToolCallResult> {
    const session = await this.ensureActive(appId, context);
    const startTime = Date.now();

    try {
      session.lastUsedAt = new Date();

      const response = await protocol.callTool(
        session.stationUrl,
        session.sessionId,
        toolName,
        args,
        {
          userId: context.userId ?? 'system',
          workspaceId: context.workspaceId,
          installationId: context.installationId,
          channelId: context.channelId,
          agentId: context.agentId,
          requestId: context.requestId,
          userDisplayName: context.userDisplayName,
          userAvatarUrl: context.userAvatarUrl,
        },
        session.stationToken,
        { timeoutMs: this.toolCallMs, signal },
        this.log,
      );

      const durationMs = Date.now() - startTime;

      if (response.type === 'error') {
        const errorMsg = (response as any).error?.message ?? 'Unknown error';
        const errorCode = (response as any).error?.code ?? 'UNKNOWN';

        this.onEvent?.({
          type: 'tool:executed',
          sessionId: session.sessionId,
          toolName,
          durationMs,
          success: false,
        });

        return {
          success: false,
          output: `[${errorCode}] ${errorMsg}`,
          duration: durationMs,
          error: { code: errorCode, message: errorMsg },
        };
      }

      const result = this.parseToolResult(response, durationMs);

      this.onEvent?.({
        type: 'tool:executed',
        sessionId: session.sessionId,
        toolName,
        durationMs,
        success: result.success,
      });

      return result;
    } catch (error: any) {
      const durationMs = Date.now() - startTime;

      // Mark session as error for potential re-open
      session.status = 'error';
      session.lastError = error.message;

      this.onEvent?.({
        type: 'session:error',
        sessionId: session.sessionId,
        appId,
        error: error.message,
      });

      return {
        success: false,
        output: `Error: ${error.message}`,
        duration: durationMs,
        error: { code: error.code ?? 'INTERNAL_ERROR', message: error.message },
      };
    }
  }

  private parseToolResult(
    response: Record<string, unknown>,
    durationMs: number,
  ): ToolCallResult {
    const success = (response as any).success !== false;
    let output = '';
    const attachments: Array<{ url: string; mime: string; filename?: string }> = [];

    // Result (string or JSON)
    if ((response as any).result !== undefined) {
      output =
        typeof (response as any).result === 'string'
          ? (response as any).result
          : JSON.stringify((response as any).result);
    }

    // Structured content (text/image/resource items)
    if (Array.isArray((response as any).structuredContent)) {
      for (const item of (response as any).structuredContent) {
        if (item.type === 'text' && item.text) {
          output += item.text;
        } else if (item.type === 'image' && item.data && item.mimeType) {
          attachments.push({
            url: `data:${item.mimeType};base64,${item.data}`,
            mime: item.mimeType,
          });
        } else if (item.type === 'resource' && item.resource?.uri) {
          attachments.push({
            url: item.resource.uri,
            mime: item.resource.mimeType ?? 'application/octet-stream',
            filename: item.resource.text,
          });
        }
      }
    }

    // Attachments
    if (Array.isArray((response as any).attachments)) {
      for (const att of (response as any).attachments) {
        attachments.push({ url: att.url, mime: att.mime, filename: att.filename });
      }
    }

    // Error fallback
    if (!output && (response as any).error) {
      output = (response as any).error.message ?? JSON.stringify((response as any).error);
    }

    return {
      success,
      output,
      attachments: attachments.length > 0 ? attachments : undefined,
      duration: (response as any).duration ?? durationMs,
    };
  }

  // ---------------------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------------------

  async checkHealth(appId: string, workspaceId?: string): Promise<InstanceHealth> {
    const key = this.sessionKey(appId, workspaceId);
    const session = this.sessions.get(key);
    if (!session || session.status !== 'active') {
      return { status: 'not_ready', message: 'No active session', checkedAt: new Date() };
    }

    try {
      const response = await protocol.healthCheck(
        session.stationUrl,
        session.sessionId,
        session.stationToken,
        { timeoutMs: this.healthCheckMs },
        this.log,
      );

      const health: InstanceHealth = {
        status: (response as any).status ?? 'ready',
        message: (response as any).message,
        issues: (response as any).issues,
        version: (response as any).version,
        uptime: (response as any).uptime,
        checkedAt: new Date(),
      };

      session.health = health;
      return health;
    } catch (error: any) {
      const health: InstanceHealth = {
        status: 'not_ready',
        message: error.message,
        checkedAt: new Date(),
      };
      session.health = health;
      return health;
    }
  }

  // ---------------------------------------------------------------------------
  // Query
  // ---------------------------------------------------------------------------

  hasSession(appId: string, workspaceId?: string): boolean {
    const key = this.sessionKey(appId, workspaceId);
    const s = this.sessions.get(key);
    return !!s && s.status === 'active';
  }

  getSession(appId: string, workspaceId?: string): SessionInfo | null {
    const key = this.sessionKey(appId, workspaceId);
    const s = this.sessions.get(key);
    return s ? this.toInfo(s) : null;
  }

  getTools(appId: string, workspaceId?: string): RawToolDefinition[] {
    const key = this.sessionKey(appId, workspaceId);
    return this.sessions.get(key)?.tools ?? [];
  }

  getAllSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => this.toInfo(s));
  }

  // ---------------------------------------------------------------------------
  // Close
  // ---------------------------------------------------------------------------

  async close(appId: string, reason = 'explicit', workspaceId?: string): Promise<void> {
    const key = this.sessionKey(appId, workspaceId);
    await this.closeByKey(key, reason);
  }

  /**
   * Close a session by its exact pool key (appId or appId::workspaceId).
   */
  private async closeByKey(key: string, reason: string): Promise<void> {
    const session = this.sessions.get(key);
    if (!session) return;

    try {
      if (session.sessionId && session.status !== 'closed') {
        await protocol.sessionClose(
          session.stationUrl,
          session.sessionId,
          reason,
          session.stationToken,
          { timeoutMs: 10_000 },
          this.log,
        ).catch(() => {}); // best-effort
      }
    } finally {
      this.registry.decrementSessions(session.stationId);
      session.status = 'closed';
      this.sessions.delete(key);

      this.log.info('Session closed', { appId: session.appId, sessionId: session.sessionId, reason });
      this.onEvent?.({
        type: 'session:closed',
        sessionId: session.sessionId,
        appId: session.appId,
        reason,
      });
    }
  }

  async closeAll(reason = 'shutdown'): Promise<void> {
    const keys = Array.from(this.sessions.keys());
    await Promise.allSettled(keys.map((key) => this.closeByKey(key, reason)));
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  private async cleanupIdle(): Promise<void> {
    const now = Date.now();
    const toClose: string[] = [];

    for (const [key, session] of this.sessions) {
      const idleMs = now - session.lastUsedAt.getTime();
      if (idleMs > this.idleTimeoutMs && session.status === 'active') {
        toClose.push(key);
      }
    }

    for (const key of toClose) {
      const session = this.sessions.get(key);
      this.log.info('Closing idle session', { appId: session?.appId, key });
      await this.closeByKey(key, 'idle_timeout');
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async ensureActive(
    appId: string,
    context: ToolCallContext,
  ): Promise<PooledSession> {
    const key = this.sessionKey(appId, context.workspaceId);
    const existing = this.sessions.get(key);

    if (existing && existing.status === 'active') {
      return existing;
    }

    // Session doesn't exist or is in error — (re)open
    if (existing) {
      // Close the broken session first
      await this.closeByKey(key, 'reopen');
    }

    await this.getOrOpen(appId, {
      userId: context.userId,
      workspaceId: context.workspaceId,
    });

    const session = this.sessions.get(key);
    if (!session || session.status !== 'active') {
      throw new Error(`Failed to establish session for app '${appId}'`);
    }

    return session;
  }

  private toInfo(s: PooledSession): SessionInfo {
    return {
      sessionId: s.sessionId,
      appId: s.appId,
      workspaceId: s.workspaceId,
      stationId: s.stationId,
      stationUrl: s.stationUrl,
      tools: s.tools,
      status: s.status,
      lastUsedAt: s.lastUsedAt,
      createdAt: s.createdAt,
      lastError: s.lastError,
    };
  }

  shutdown(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }
}
