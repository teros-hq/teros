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
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type {
  HealthIssue,
  HealthStatus,
  HealthCheckResult as SharedHealthCheckResult,
} from '@teros/shared';
import type { ChildProcess } from 'child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import type { Db } from 'mongodb';
import { join } from 'path';
import { createInterface } from 'readline';
import type { Readable } from 'stream';
import type { AuthManager } from '../auth/auth-manager';
import { captureException, captureMessage } from '../lib/sentry';
import type { SecretsManager } from '../secrets/secrets-manager';
import type { App, McpCatalogEntry } from '../types/database';
import type { McaConnectionManager } from './mca-connection-manager';
import { McaContainerManager } from './mca-container-manager';
import { McaHttpClient } from './mca-http-client';
import { McaService } from './mca-service';
import type { VolumeService } from './volume-service';

/**
 * Maximum characters allowed in tool output.
 * Outputs exceeding this limit will be truncated to prevent:
 * - Context window exhaustion (each char ≈ 0.4 tokens)
 * - Memory issues in the backend
 * - Slow response times
 *
 * 40,000 chars ≈ 16,000 tokens (conservative limit to prevent context bloat).
 */
const MAX_TOOL_OUTPUT_CHARS = 40_000;

/**
 * Maximum tool input parameter size in characters.
 * This limit prevents issues with JSON parsing and transport layer limits.
 * Same as MAX_TOOL_OUTPUT_CHARS for consistency.
 */
const MAX_TOOL_INPUT_CHARS = 40_000;

/**
 * Truncate tool output if it exceeds the maximum allowed characters.
 * Logs to Sentry when truncation occurs for monitoring.
 *
 * @param output - The original tool output
 * @param toolName - Name of the tool (for logging)
 * @param appId - App ID (for logging)
 * @returns Truncated output with suffix if exceeded, original otherwise
 */
function truncateToolOutput(output: string, toolName: string, appId: string): string {
  if (output.length <= MAX_TOOL_OUTPUT_CHARS) {
    return output;
  }

  const originalLength = output.length;
  const truncatedOutput =
    output.slice(0, MAX_TOOL_OUTPUT_CHARS) +
    `\n\n[... OUTPUT TRUNCATED BY SYSTEM: ${originalLength.toLocaleString()} chars exceeded ${MAX_TOOL_OUTPUT_CHARS.toLocaleString()} char limit ...]`;

  // Log to Sentry for monitoring which tools generate excessive output
  captureMessage('Tool output truncated', 'warning', {
    toolName,
    appId,
    originalLength,
    truncatedLength: truncatedOutput.length,
    limit: MAX_TOOL_OUTPUT_CHARS,
  });

  console.warn(
    `[McaManager] Tool output truncated: ${toolName} (${originalLength.toLocaleString()} -> ${MAX_TOOL_OUTPUT_CHARS.toLocaleString()} chars)`,
  );

  return truncatedOutput;
}

/**
 * Validate tool input size to prevent transport layer failures.
 * Returns an error object if input exceeds the limit, null otherwise.
 *
 * @param input - Tool input parameters
 * @param toolName - Name of the tool (for error message)
 * @param appId - App ID (for logging)
 * @returns Error object if validation fails, null if valid
 */
function validateToolInputSize(
  input: Record<string, any>,
  toolName: string,
  appId: string,
): { output: string; isError: boolean } | null {
  try {
    const serialized = JSON.stringify(input);
    const inputSize = serialized.length;

    if (inputSize > MAX_TOOL_INPUT_CHARS) {
      // Find which parameter is too large
      let largestParam = '';
      let largestSize = 0;
      for (const [key, value] of Object.entries(input)) {
        const paramSize = JSON.stringify(value).length;
        if (paramSize > largestSize) {
          largestSize = paramSize;
          largestParam = key;
        }
      }

      const errorMessage = [
        `Error: Tool input exceeds maximum size limit.`,
        ``,
        `Tool: ${toolName}`,
        `Total input size: ${inputSize.toLocaleString()} characters`,
        `Maximum allowed: ${MAX_TOOL_INPUT_CHARS.toLocaleString()} characters`,
        ``,
        `Largest parameter: '${largestParam}' (${largestSize.toLocaleString()} characters)`,
        ``,
        `Suggestion: Reduce the size of the '${largestParam}' parameter or split the operation into smaller chunks.`,
      ].join('\n');

      console.warn(
        `[McaManager] Tool input too large: ${toolName} on ${appId} (${inputSize.toLocaleString()} chars, largest param: ${largestParam})`,
      );

      // Log to Sentry for monitoring
      captureMessage('Tool input size limit exceeded', 'warning', {
        toolName,
        appId,
        inputSize,
        largestParam,
        largestSize,
        limit: MAX_TOOL_INPUT_CHARS,
      });

      return {
        output: errorMessage,
        isError: true,
      };
    }

    return null; // Validation passed
  } catch (error: any) {
    // If we can't serialize the input, that's also a problem
    console.error(`[McaManager] Failed to validate tool input for ${toolName}:`, error);
    return {
      output: `Error: Failed to validate tool input: ${error.message}`,
      isError: true,
    };
  }
}

/**
 * Static tool definition from tools.json
 */
interface StaticToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

/**
 * tools.json file format
 */
interface ToolsJsonFile {
  $schema: string;
  mcaId: string;
  tools: StaticToolDefinition[];
}

/**
 * Tool definition (matches core's ToolDefinition)
 */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

/**
 * MCA Status
 *
 * - starting: Process is starting up
 * - ready: Process running, connected, ready to execute tools
 * - standby: Process not running, tools available from tools.json, will start on demand
 * - error: Process failed or crashed, or missing tools.json - will retry on demand
 * - disabled: User disabled the MCA, won't start
 * - stopping: Process is shutting down
 */
export type McaStatus = 'starting' | 'ready' | 'standby' | 'error' | 'disabled' | 'stopping';

/**
 * Health check result from an MCA
 *
 * Supports both old format (healthy/unhealthy) and new format (ready/not_ready).
 * MCAs can implement a special tool `_health_check` that returns this structure.
 * If the tool doesn't exist, health is inferred from MCA status.
 */
export interface HealthCheckResult {
  /** New format: ready/not_ready/degraded, Old format: healthy/unhealthy/degraded/unknown */
  status: HealthStatus | 'healthy' | 'unhealthy' | 'unknown';
  /** Human-readable message */
  message?: string;
  /** New format: standardized issues with action URLs */
  issues?: HealthIssue[];
  /** Old format: detailed status info */
  details?: {
    secretsConfigured?: boolean;
    credentialsConfigured?: boolean;
    credentialsValid?: boolean;
    credentialsError?: string;
    connectivityOk?: boolean;
    [key: string]: any;
  };
  /** MCA version */
  version?: string;
  /** Uptime in seconds */
  uptime?: number;
  /** When this check was performed */
  checkedAt: Date;
}

/**
 * Normalize health status to the new format
 */
function normalizeHealthStatus(status: string): HealthStatus {
  switch (status) {
    case 'ready':
    case 'healthy':
      return 'ready';
    case 'not_ready':
    case 'unhealthy':
      return 'not_ready';
    case 'degraded':
      return 'degraded';
    default:
      return 'not_ready';
  }
}

/**
 * Check if health result indicates the MCA is ready to execute tools
 */
function isHealthReady(health: HealthCheckResult | undefined): boolean {
  if (!health) return true; // No health info = assume ready (will fail on actual call if not)
  const normalizedStatus = normalizeHealthStatus(health.status);
  return normalizedStatus === 'ready' || normalizedStatus === 'degraded';
}

/**
 * Managed MCA instance
 */
interface ManagedMca {
  appId: string;
  mcaId: string;
  appName: string; // User-defined app name (used as tool prefix)
  client: Client | null;
  transport: StdioClientTransport | null;
  process?: ChildProcess;
  tools: ToolDefinition[];
  toolNameMapping: Map<string, string>; // sanitized name -> original name
  status: McaStatus;
  lastUsed: Date;
  lastError?: string;
  restartCount: number;
  /** Last health check result */
  health?: HealthCheckResult;
  /** Container key for HTTP MCAs (mcpId for shared, appId for per-app) */
  containerKey?: string;
}

/**
 * MCA Manager configuration
 */
export interface McaManagerConfig {
  /** Base path where MCAs are installed (e.g., '/path/to/mcas') */
  mcaBasePath: string;
  /** SecretsManager for loading system secrets */
  secretsManager?: SecretsManager;
  /** AuthManager for loading user credentials */
  authManager?: AuthManager;
  /** VolumeService for resolving volume mounts */
  volumeService?: VolumeService;
  /** Max idle time before cleanup (default: 30 minutes) */
  maxIdleMs?: number;
  /** Max restart attempts before giving up (default: 3) */
  maxRestarts?: number;
  /** Cleanup interval (default: 5 minutes) */
  cleanupIntervalMs?: number;
  /** Server port for WebSocket URL generation */
  serverPort?: number;
  /** Directory for MCA logs (default: <mcaBasePath>/../logs/mcas) */
  logDir?: string;
  /** Enable file logging for MCAs (default: true) */
  enableMcaLogs?: boolean;
}

/**
 * MCA Manager
 *
 * Singleton-ish manager for all MCA processes.
 * Create one instance and reuse across the application.
 */
export class McaManager {
  private mcas = new Map<string, ManagedMca>();
  private mcaService: McaService;
  private config: McaManagerConfig & {
    maxIdleMs: number;
    maxRestarts: number;
    cleanupIntervalMs: number;
    serverPort: number;
    logDir: string;
    enableMcaLogs: boolean;
    volumeService?: VolumeService;
  };
  private cleanupInterval?: NodeJS.Timeout;
  private isShuttingDown = false;

  /** Cache of static tools loaded from tools.json files (by mcpId) */
  private staticToolsCache = new Map<string, StaticToolDefinition[]>();

  /** Reference to McaConnectionManager for WebSocket communication */
  private connectionManager?: McaConnectionManager;

  /** Container manager for HTTP-based MCAs */
  private containerManager: McaContainerManager;

  /** HTTP clients for containerized MCAs (keyed by appId) */
  private httpClients = new Map<string, McaHttpClient>();

  constructor(db: Db, config: McaManagerConfig) {
    this.mcaService = new McaService(db, { secretsManager: config.secretsManager });
    const logDir = config.logDir ?? join(config.mcaBasePath, '..', 'logs', 'mcas');
    this.config = {
      mcaBasePath: config.mcaBasePath,
      secretsManager: config.secretsManager,
      volumeService: config.volumeService,
      maxIdleMs: config.maxIdleMs ?? 30 * 60 * 1000, // 30 minutes
      maxRestarts: config.maxRestarts ?? 3,
      cleanupIntervalMs: config.cleanupIntervalMs ?? 5 * 60 * 1000, // 5 minutes
      serverPort: config.serverPort ?? 3000,
      logDir,
      enableMcaLogs: config.enableMcaLogs !== false,
    };

    // Create log directory if enabled
    if (this.config.enableMcaLogs && !existsSync(logDir)) {
      try {
        mkdirSync(logDir, { recursive: true });
        console.log(`[McaManager] Created MCA log directory: ${logDir}`);
      } catch (error) {
        console.warn(`[McaManager] Failed to create log directory: ${logDir}`, error);
        this.config.enableMcaLogs = false;
      }
    }

    // Initialize container manager for HTTP-based MCAs
    this.containerManager = new McaContainerManager({
      mcaBasePath: config.mcaBasePath,
      backendPort: this.config.serverPort,
    });

    // Start cleanup interval
    this.startCleanupInterval();
  }

  /**
   * Set the connection manager for WebSocket communication with MCAs
   */
  setConnectionManager(connectionManager: McaConnectionManager): void {
    this.connectionManager = connectionManager;
    console.log('[McaManager] Connection manager set');
  }

  /**
   * Get the connection manager
   */
  getConnectionManager(): McaConnectionManager | undefined {
    return this.connectionManager;
  }

  /**
   * Log output from an MCA process
   * Outputs to console with prefix and optionally to per-MCA log file
   */
  private logMcaOutput(appId: string, appName: string, mcaId: string, line: string): void {
    const timestamp = new Date().toISOString();
    const prefix = `[${appName}]`;

    // Console output (prefixed with app name for easy filtering)
    console.log(`${prefix} ${line}`);

    // File output (if enabled)
    // Structure: logs/mcas/<mcaId>/<appId>/<date>.log
    if (this.config.enableMcaLogs) {
      try {
        const today = timestamp.substring(0, 10); // Extract YYYY-MM-DD from ISO timestamp
        const appLogDir = join(this.config.logDir, mcaId, appId);
        const logFile = join(appLogDir, `${today}.log`);

        // Ensure app log directory exists
        if (!existsSync(appLogDir)) {
          mkdirSync(appLogDir, { recursive: true });
        }

        // Append to log file
        appendFileSync(logFile, `[${timestamp}] ${line}\n`);
      } catch (error) {
        // Don't spam console if file logging fails
        // Just silently skip file logging
      }
    }
  }

  /**
   * Setup stderr logging for an MCA transport
   */
  private setupStderrLogging(
    appId: string,
    appName: string,
    mcaId: string,
    transport: StdioClientTransport,
  ): void {
    const stderr = transport.stderr;
    if (!stderr) {
      console.warn(`[McaManager] No stderr stream available for ${appId}`);
      return;
    }

    // Cast to Readable since the SDK returns a PassThrough stream when stderr: 'pipe'
    const rl = createInterface({ input: stderr as Readable });
    rl.on('line', (line) => {
      this.logMcaOutput(appId, appName, mcaId, line);
    });

    rl.on('error', (error: Error) => {
      console.warn(`[McaManager] stderr readline error for ${appId}:`, error.message);
    });
  }

  /**
   * Convert a key to environment variable format
   * e.g., "admin_api_url" -> "SECRET_MCA_ADMIN_API_URL"
   */
  private toEnvKey(prefix: 'SECRET_MCA' | 'SECRET_USER', key: string): string {
    return `${prefix}_${key.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  }

  /**
   * Invalidate the static tools cache for a specific MCA.
   *
   * Called by McaBootSync when a tools.json changes, so the next
   * conversation picks up the updated tools without restarting the backend.
   *
   * Also evicts any in-memory ManagedMca entries in standby state so they
   * are re-registered with the new tool list on next use.
   */
  invalidateStaticToolsCache(mcaId: string): void {
    if (this.staticToolsCache.has(mcaId)) {
      this.staticToolsCache.delete(mcaId);
      console.log(`[McaManager] Invalidated static tools cache for ${mcaId}`);
    }

    // Also evict standby entries for this MCA so they are re-registered
    // with the updated tools on next getOrSpawn() call
    for (const [appId, managed] of this.mcas.entries()) {
      if (managed.mcaId === mcaId && managed.status === 'standby') {
        this.mcas.delete(appId);
        console.log(`[McaManager] Evicted standby entry for app ${appId} (${mcaId})`);
      }
    }
  }

  /**
   * Load static tool definitions from tools.json file
   * These are used as fallback when MCA process is not running
   */
  private loadStaticTools(mcaId: string): StaticToolDefinition[] {
    // Check cache first
    if (this.staticToolsCache.has(mcaId)) {
      return this.staticToolsCache.get(mcaId)!;
    }

    const toolsPath = join(this.config.mcaBasePath, mcaId, 'tools.json');

    if (!existsSync(toolsPath)) {
      console.warn(`[McaManager] No tools.json found for ${mcaId}`);
      return [];
    }

    try {
      const content = readFileSync(toolsPath, 'utf-8');
      const toolsFile: ToolsJsonFile = JSON.parse(content);

      // Cache the result
      this.staticToolsCache.set(mcaId, toolsFile.tools);
      console.log(`[McaManager] Loaded ${toolsFile.tools.length} static tools for ${mcaId}`);

      return toolsFile.tools;
    } catch (error: any) {
      console.error(`[McaManager] Failed to load tools.json for ${mcaId}:`, error.message);
      return [];
    }
  }

  /**
   * Convert static tools to ToolDefinition format with app name prefix
   * Internal tools (starting with _) are kept in mapping but not exposed to LLM
   */
  private convertStaticTools(
    staticTools: StaticToolDefinition[],
    appName: string,
  ): { tools: ToolDefinition[]; mapping: Map<string, string> } {
    const tools: ToolDefinition[] = [];
    const mapping = new Map<string, string>();

    for (const tool of staticTools) {
      const originalName = tool.name;
      // Convert tool name to kebab-case: read_email -> read-email
      const kebabToolName = originalName.replace(/_/g, '-');
      const sanitizedName = `${appName}_${kebabToolName}`;

      // Always add to mapping (needed for health check and internal tools)
      mapping.set(sanitizedName, originalName);

      // Skip internal tools (starting with _) from public tool list
      if (originalName.startsWith('_')) {
        continue;
      }

      tools.push({
        name: sanitizedName,
        description: tool.description,
        input_schema: {
          type: 'object' as const,
          properties: tool.inputSchema.properties || {},
          required: tool.inputSchema.required,
        },
      });
    }

    return { tools, mapping };
  }

  /**
   * Register an app with static tools (no process spawned)
   * Used when we want tools available but MCA process failed to start
   *
   * This creates a ManagedMca entry with status='standby' so that:
   * 1. getToolsForApp() returns the static tools
   * 2. executeTool() can find the tool via toolNameMapping and attempt to spawn
   */
  async registerApp(appId: string): Promise<ManagedMca | null> {
    // Check if already registered
    const existing = this.mcas.get(appId);
    if (existing) {
      return existing;
    }

    // Get app and MCA info
    const app = await this.mcaService.getApp(appId);
    if (!app) {
      console.warn(`[McaManager] Cannot register app, not found: ${appId}`);
      return null;
    }

    // Load static tools
    const staticTools = this.loadStaticTools(app.mcaId);
    if (staticTools.length === 0) {
      console.warn(`[McaManager] No static tools found for ${app.mcaId}`);
      return null;
    }

    // Convert to ToolDefinition format with mapping
    const { tools, mapping } = this.convertStaticTools(staticTools, app.name);

    // Create managed entry with status='standby'
    const managed: ManagedMca = {
      appId,
      mcaId: app.mcaId,
      appName: app.name,
      client: null,
      transport: null,
      tools,
      toolNameMapping: mapping,
      status: 'standby',
      lastUsed: new Date(),
      restartCount: 0,
    };

    this.mcas.set(appId, managed);
    console.log(`[McaManager] Registered app ${appId} with ${tools.length} tools (standby)`);

    return managed;
  }

  /**
   * Get or spawn an MCA process for the given appId
   */
  async getOrSpawn(appId: string): Promise<ManagedMca> {
    // Check if already running and healthy
    const existing = this.mcas.get(appId);
    if (existing && existing.status === 'ready') {
      existing.lastUsed = new Date();
      return existing;
    }

    // If disabled, throw
    if (existing && existing.status === 'disabled') {
      throw new Error(`MCA ${appId} is disabled`);
    }

    // If starting, wait for it
    if (existing && existing.status === 'starting') {
      return this.waitForReady(appId);
    }

    // If error and too many restarts, throw
    if (
      existing &&
      existing.status === 'error' &&
      existing.restartCount >= this.config.maxRestarts
    ) {
      throw new Error(
        `MCA ${appId} failed after ${existing.restartCount} restart attempts: ${existing.lastError}`,
      );
    }

    // If standby, spawn fresh (restartCount = 0)
    if (existing && existing.status === 'standby') {
      return this.spawn(appId, 0);
    }

    // Spawn new or restart (for error state, keep restartCount)
    return this.spawn(appId, existing?.restartCount ?? 0);
  }

  /**
   * Spawn a new MCA process (stdio or container based on runtime config)
   */
  private async spawn(appId: string, restartCount: number): Promise<ManagedMca> {
    console.log(`[McaManager] Spawning MCA: ${appId} (restart #${restartCount})`);

    // Get app and MCA catalog info
    const app = await this.mcaService.getApp(appId);
    if (!app) {
      throw new Error(`App not found: ${appId}`);
    }

    const mca = await this.mcaService.getMcaFromCatalog(app.mcaId);
    if (!mca) {
      throw new Error(`MCA not found in catalog: ${app.mcaId}`);
    }

    // Check if this MCA should run in a container
    if (mca.runtime?.transport === 'http') {
      return this.spawnContainer(appId, app, mca, restartCount);
    }

    // Otherwise, spawn as stdio process (legacy mode)
    return this.spawnStdio(appId, app, mca, restartCount);
  }

  /**
   * Spawn MCA as a Docker container (HTTP transport)
   */
  private async spawnContainer(
    appId: string,
    app: App,
    mca: McpCatalogEntry,
    restartCount: number,
  ): Promise<ManagedMca> {
    const containerMode = mca.runtime?.containerMode || 'shared';
    console.log(`[McaManager] Spawning container for MCA: ${appId} (mode: ${containerMode})`);

    // Create placeholder entry
    const managed: ManagedMca = {
      appId,
      mcaId: app.mcaId,
      appName: app.name,
      client: null,
      transport: null,
      tools: [],
      toolNameMapping: new Map(),
      status: 'starting',
      lastUsed: new Date(),
      restartCount,
    };
    this.mcas.set(appId, managed);

    try {
      // Resolve volume mounts from app configuration
      const volumes: Array<{ hostPath: string; containerPath: string; readOnly: boolean }> = [];

      if (app.volumes?.length && this.config.volumeService) {
        const resolvedMounts = await this.config.volumeService.resolveVolumeMounts(
          app.volumes,
          app.ownerId,
        );
        volumes.push(...resolvedMounts);
        console.log(`[McaManager] Resolved ${volumes.length} volume mounts for ${appId}`);
      }

      // Build environment variables for the container
      const environment: Record<string, string> = {
        MCA_APP_NAME: app.name,
        MCA_MCP_ID: app.mcaId,
        MCA_OWNER_ID: app.ownerId,
        MCA_OWNER_TYPE: app.ownerType || 'user',
      };

      // Add MongoDB connection info (for MCAs that need direct DB access)
      // Replace localhost with teros-mongodb (container name) for container-to-container access
      if (process.env.MONGODB_URI) {
        environment.MONGODB_URI = process.env.MONGODB_URI.replace('localhost', 'teros-mongodb');
      }
      if (process.env.MONGODB_DATABASE) {
        environment.MONGODB_DATABASE = process.env.MONGODB_DATABASE;
      }

      // Add WebSocket connection info if connection manager is available
      if (this.connectionManager) {
        const wsToken = this.connectionManager.registerPendingConnection(
          app.appId,
          app.mcaId,
          app.ownerId,
        );
        environment.MCA_WS_URL = `ws://host.docker.internal:${this.config.serverPort}/mca?appId=${app.appId}&token=${wsToken}`;
        environment.MCA_WS_TOKEN = wsToken;
        console.log(
          `[McaManager] WebSocket configured for container ${appId}: ${environment.MCA_WS_URL}`,
        );
      }

      // Add backend URL for OAuth redirects
      const staticBaseUrl =
        process.env.STATIC_BASE_URL || `http://localhost:${this.config.serverPort}/static`;
      const backendUrl = staticBaseUrl.replace('/static', '');
      environment.MCA_BACKEND_URL = backendUrl;

      // Inject system-level environment variables from manifest (e.g. DOCKER_HOST, DOCKER_ENV_DOMAIN)
      // These are merged before per-MCA overrides so the latter can take precedence.
      // Values support $VAR or ${VAR} interpolation against the backend process environment.
      if (mca.runtime?.systemEnvironment) {
        for (const [key, value] of Object.entries(mca.runtime.systemEnvironment)) {
          const resolved = value.replace(/\$\{([^}]+)\}|\$([A-Z_][A-Z0-9_]*)/g, (_, braced, bare) => {
            const envKey = braced ?? bare;
            return process.env[envKey] ?? '';
          });
          environment[key] = resolved;
        }
        console.log(
          `[McaManager] Injected ${Object.keys(mca.runtime.systemEnvironment).length} systemEnvironment vars for ${app.mcaId}`,
        );
      }

      // Inject WORKSPACE_HOST_PATH for MCAs that need to translate /workspace paths for Docker.
      // The value is the real host-side path of the owner's volume so that Docker
      // bind mounts work correctly (the Docker daemon runs on the host, not in the container).
      // Supports both user-owned apps (ownerId = userId) and workspace-owned apps (ownerId = workspaceId).
      if (app.mcaId === 'mca.teros.docker-env') {
        if (this.config.volumeService) {
          let workspaceHostPath: string | undefined;

          if (app.ownerId.startsWith('work_')) {
            // Workspace-owned app: look up the workspace volume via DB
            const db = (this.config.volumeService as any).db as import('mongodb').Db;
            const workspace = await db
              .collection('workspaces')
              .findOne({ workspaceId: app.ownerId });
            if (workspace?.volumeId) {
              const vol = await this.config.volumeService.getVolume(workspace.volumeId);
              workspaceHostPath = vol?.hostPath;
            }
          } else {
            // User-owned app: use the user's personal volume
            const userVolume = await this.config.volumeService.getUserVolume(app.ownerId);
            workspaceHostPath = userVolume?.hostPath;
          }

          if (!workspaceHostPath) {
            throw new Error(
              `Cannot start mca.teros.docker-env: failed to resolve workspace host path for owner ${app.ownerId}`,
            );
          }
          environment.WORKSPACE_HOST_PATH = workspaceHostPath;
          console.log(
            `[McaManager] Injected WORKSPACE_HOST_PATH=${workspaceHostPath} for ${appId}`,
          );
        } else {
          throw new Error(
            'Cannot start mca.teros.docker-env: VolumeService is not available. WORKSPACE_HOST_PATH cannot be resolved.',
          );
        }
      }

      // Add system-level volume mounts from manifest (e.g. Docker socket for docker-env)
      if (mca.runtime?.systemVolumes?.length) {
        for (const sv of mca.runtime.systemVolumes) {
          volumes.push({
            hostPath: sv.hostPath,
            containerPath: sv.containerPath,
            readOnly: sv.readOnly ?? false,
          });
        }
        console.log(
          `[McaManager] Added ${mca.runtime.systemVolumes.length} systemVolumes for ${app.mcaId}`,
        );
      }

      // Determine if this MCA needs network access (MongoDB, Qdrant, etc.)
      const mcasWithNetworkAccess = ['mca.teros.scheduler', 'mca.teros.memory', 'mca.teros.docker-env'];
      const needsMongoAccess = mcasWithNetworkAccess.includes(app.mcaId);

      // Start container with resolved volumes, container mode, custom image, and environment
      const dockerImage = mca.runtime?.dockerImage;
      const containerInfo = await this.containerManager.getOrStart(app.mcaId, {
        volumes: volumes.map((v) => ({
          hostPath: v.hostPath,
          containerPath: v.containerPath,
          readOnly: v.readOnly,
        })),
        appId,
        containerMode,
        dockerImage,
        environment,
        dockerNetwork: needsMongoAccess ? 'teros_teros-network' : undefined,
      });
      console.log(
        `[McaManager] Container started: ${containerInfo.name} on port ${containerInfo.hostPort} (mode: ${containerMode})`,
      );

      // Store container key for later use (touch, etc.)
      // For shared mode: mcpId, for per-app mode: appId
      managed.containerKey = containerMode === 'per-app' ? appId : app.mcaId;

      // Create HTTP client
      const httpClient = new McaHttpClient({ baseUrl: containerInfo.baseUrl });
      this.httpClients.set(appId, httpClient);

      // Discover tools via HTTP
      const toolsResponse = await httpClient.listTools();
      const toolNameMapping = new Map<string, string>();
      const tools: ToolDefinition[] = [];

      for (const tool of toolsResponse.tools) {
        const originalName = tool.name;
        const kebabToolName = originalName.replace(/_/g, '-');
        const sanitizedName = `${managed.appName}_${kebabToolName}`;

        toolNameMapping.set(sanitizedName, originalName);

        if (originalName.startsWith('_')) {
          console.log(`[McaManager] Skipping internal tool: ${originalName}`);
          continue;
        }

        tools.push({
          name: sanitizedName,
          description: tool.description || '',
          input_schema: {
            type: 'object' as const,
            properties: tool.parameters?.properties || {},
            required: tool.parameters?.required,
          },
        });
      }

      console.log(`[McaManager] Discovered ${tools.length} tools from container ${appId}:`);
      tools.forEach((tool) => console.log(`   - ${tool.name}`));

      // Update managed entry
      managed.tools = tools;
      managed.toolNameMapping = toolNameMapping;
      managed.status = 'ready';

      return managed;
    } catch (error: any) {
      console.error(`[McaManager] Failed to spawn container for ${appId}:`, error.message);
      captureException(error, { context: 'spawnContainer', appId, mcaId: app.mcaId });
      managed.status = 'error';
      managed.lastError = error.message;
      throw error;
    }
  }

  /**
   * Spawn MCA as a stdio process (legacy mode)
   */
  private async spawnStdio(
    appId: string,
    app: App,
    mca: McpCatalogEntry,
    restartCount: number,
  ): Promise<ManagedMca> {
    console.log(`[McaManager] Spawning stdio process for MCA: ${appId}`);

    // Create placeholder entry
    const managed: ManagedMca = {
      appId,
      mcaId: app.mcaId,
      appName: app.name,
      client: null as any, // Will be set below
      transport: null as any, // Will be set below
      tools: [],
      toolNameMapping: new Map(),
      status: 'starting',
      lastUsed: new Date(),
      restartCount,
    };
    this.mcas.set(appId, managed);

    try {
      // Build execution config
      const { command, args, cwd, environment } = await this.buildExecutionConfig(app, mca);

      console.log(`[McaManager] Command: ${command} ${args.join(' ')}`);
      console.log(`[McaManager] CWD: ${cwd}`);

      // Log SECRET_MCA_* and SECRET_USER_* vars for debugging (hide sensitive values)
      const secretEnvVars = Object.entries(environment)
        .filter(([k]) => k.startsWith('SECRET_MCA_') || k.startsWith('SECRET_USER_'))
        .map(
          ([k, v]) =>
            `${k}=${k.includes('KEY') || k.includes('TOKEN') || k.includes('PASSWORD') ? '***' : v}`,
        );
      console.log(`[McaManager] Secret env vars: ${secretEnvVars.join(', ') || 'none'}`);

      // Verify CWD exists
      const { existsSync } = await import('fs');
      if (!existsSync(cwd)) {
        throw new Error(`CWD does not exist: ${cwd}`);
      }
      console.log(`[McaManager] CWD exists: true`);

      // Create stdio transport with stderr piped for logging
      const transport = new StdioClientTransport({
        command,
        args,
        env: environment,
        cwd,
        stderr: 'pipe', // Capture stderr for per-MCA logging
      });

      // Create MCP client
      const client = new Client(
        {
          name: `teros-mca-${appId}`,
          version: '1.0.0',
        },
        {
          capabilities: {},
        },
      );

      // Connect
      console.log(`[McaManager] Connecting to MCA process...`);
      await client.connect(transport);
      console.log(`[McaManager] Connected to MCA: ${appId}`);

      // Setup stderr logging after connection
      this.setupStderrLogging(appId, managed.appName, managed.mcaId, transport);

      // Discover tools
      const toolsResponse = await client.listTools();
      const toolNameMapping = new Map<string, string>();

      // Prefix tool names with app name (user-defined, unique per user)
      // Format: <app-name>_<tool-kebab> e.g., bash_bash, gmail-work_read-email
      // Tool names use kebab-case (underscores converted to hyphens)
      // Internal tools (starting with _) are kept in mapping but not exposed to LLM
      const tools: ToolDefinition[] = [];

      for (const tool of toolsResponse.tools) {
        const originalName = tool.name;
        // Convert tool name to kebab-case: read_email -> read-email
        const kebabToolName = originalName.replace(/_/g, '-');
        const sanitizedName = `${managed.appName}_${kebabToolName}`;

        // Always add to mapping (needed for health check and internal tools)
        toolNameMapping.set(sanitizedName, originalName);

        // Skip internal tools (starting with _) from public tool list
        if (originalName.startsWith('_')) {
          console.log(`[McaManager] Skipping internal tool: ${originalName}`);
          continue;
        }

        // MCP tools return JSON Schema which should have type: 'object'
        const inputSchema = tool.inputSchema as {
          type: 'object';
          properties: Record<string, any>;
          required?: string[];
        };

        tools.push({
          name: sanitizedName,
          description: tool.description || '',
          input_schema: {
            type: 'object' as const,
            properties: inputSchema.properties || {},
            required: inputSchema.required,
          },
        });
      }

      console.log(`[McaManager] Discovered ${tools.length} public tools from ${appId}:`);
      tools.forEach((tool) => console.log(`   - ${tool.name}`));

      // Update managed entry
      managed.client = client;
      managed.transport = transport;
      managed.tools = tools;
      managed.toolNameMapping = toolNameMapping;
      managed.status = 'ready';

      // Setup watchdog for this process
      this.setupWatchdog(appId, transport);

      // Perform initial health check (async, don't block spawn)
      this.performInitialHealthCheck(appId).catch((err) => {
        console.warn(`[McaManager] Initial health check failed for ${appId}:`, err.message);
      });

      return managed;
    } catch (error: any) {
      console.error(`[McaManager] Failed to spawn MCA ${appId}:`, error.message);
      console.error(`[McaManager] Full error:`, error);
      captureException(error, { context: 'spawnStdio', appId, mcaId: app.mcaId });
      managed.status = 'error';
      managed.lastError = error.message;
      throw error;
    }
  }

  /**
   * Build execution config from app and MCA catalog
   */
  private async buildExecutionConfig(
    app: App,
    mca: McpCatalogEntry,
  ): Promise<{
    command: string;
    args: string[];
    cwd: string;
    environment: Record<string, string>;
  }> {
    const execution = mca.execution;

    // Build CWD (MCA's configured working directory)
    const cwd = execution.cwd
      ? `${this.config.mcaBasePath}/${execution.cwd}`
      : this.config.mcaBasePath;

    // Build environment variables
    const environment: Record<string, string> = {
      ...(process.env as Record<string, string>),
      MCA_APP_ID: app.appId,
      MCA_APP_NAME: app.name,
      MCA_MCP_ID: app.mcaId,
      MCA_CWD: cwd,
      MCA_OWNER_ID: app.ownerId,
      MCA_OWNER_TYPE: app.ownerType || 'user',
    };

    // Resolve and pass the workspace/user volume path as MCA_WORKSPACE_PATH
    // This allows stdio MCAs to access the correct filesystem for both user and workspace apps
    if (this.config.volumeService) {
      try {
        let volumePath: string | undefined;

        if (app.ownerType === 'workspace') {
          // Workspace app: get workspace's volume
          const workspaceService = this.mcaService['workspaceService'];
          if (workspaceService) {
            const workspace = await workspaceService.getWorkspace(app.ownerId);
            if (workspace?.volumeId) {
              const volume = await this.config.volumeService.getVolume(workspace.volumeId);
              volumePath = volume?.hostPath;
            }
          }
        } else {
          // User app: get user's personal volume
          const userVolume = await this.config.volumeService.getUserVolume(app.ownerId);
          volumePath = userVolume?.hostPath;
        }

        if (volumePath) {
          environment.MCA_WORKSPACE_PATH = volumePath;
          console.log(
            `[McaManager] Set MCA_WORKSPACE_PATH=${volumePath} for ${app.ownerType || 'user'} app ${app.appId}`,
          );
        }
      } catch (error) {
        console.warn(
          `[McaManager] Failed to resolve workspace path for ${app.appId}:`,
          error,
        );
      }
    }

    // Add WebSocket connection info if connection manager is available
    if (this.connectionManager) {
      const wsToken = this.connectionManager.registerPendingConnection(
        app.appId,
        app.mcaId,
        app.ownerId,
      );
      environment.MCA_WS_URL = `ws://localhost:${this.config.serverPort}/mca?appId=${app.appId}&token=${wsToken}`;
      environment.MCA_WS_TOKEN = wsToken;
    }

    // Add backend URL for OAuth redirects (MCAs use this to build auth URLs)
    // Derive from STATIC_BASE_URL or use localhost as fallback
    const staticBaseUrl =
      process.env.STATIC_BASE_URL || `http://localhost:${this.config.serverPort}/static`;
    const backendUrl = staticBaseUrl.replace('/static', '');
    environment.MCA_BACKEND_URL = backendUrl;

    // Add callback URL for stdio MCAs to access secrets via HTTP
    environment.MCA_CALLBACK_URL = `http://localhost:${this.config.serverPort}/mca/callback/${app.appId}`;

    // Add secrets as SECRET_MCA_* (loaded from filesystem via SecretsManager)
    const secrets = this.config.secretsManager?.mca(app.mcaId);
    if (secrets) {
      for (const [key, value] of Object.entries(secrets)) {
        if (value !== undefined && value !== null) {
          environment[this.toEnvKey('SECRET_MCA', key)] = String(value);
        }
      }
    }

    // Add user auth as SECRET_USER_* (loaded from AuthManager or fallback to app.auth)
    let userAuth = app.auth; // Fallback to legacy app.auth

    // Try to load from AuthManager if available
    const authManager = this.mcaService['authManager'];
    console.log(
      `[McaManager] AuthManager available: ${!!authManager}, ownerId: ${app.ownerId}, appId: ${app.appId}`,
    );

    if (authManager && app.ownerId) {
      try {
        const credentials = await authManager.get(app.ownerId, app.appId);
        console.log(
          `[McaManager] Loaded credentials for ${app.ownerId}/${app.appId}:`,
          credentials ? Object.keys(credentials) : 'null',
        );
        if (credentials) {
          userAuth = credentials; // Override with decrypted user credentials
        }
      } catch (error) {
        console.warn(
          `[McaManager] Failed to load user credentials for ${app.ownerId}/${app.appId}:`,
          error,
        );
      }
    }

    if (userAuth) {
      for (const [key, value] of Object.entries(userAuth)) {
        if (value !== undefined && value !== null) {
          environment[this.toEnvKey('SECRET_USER', key)] = String(value);
        }
      }
    }

    return {
      command: execution.command,
      args: execution.args,
      cwd,
      environment,
    };
  }

  /**
   * Setup watchdog to detect process crash and trigger restart
   */
  private setupWatchdog(appId: string, transport: StdioClientTransport): void {
    // The transport emits 'close' when the process exits
    transport.onclose = () => {
      if (this.isShuttingDown) return;

      const managed = this.mcas.get(appId);
      if (!managed) return; // Already cleaned up

      // If status is 'stopping', this is an intentional cleanup (idle timeout)
      // Don't count as a crash - just put back to standby for lazy restart
      if (managed.status === 'stopping') {
        console.log(
          `[McaManager] MCA ${appId} stopped gracefully (idle cleanup) - returning to standby`,
        );
        managed.status = 'standby';
        managed.restartCount = 0; // Reset restart count for clean shutdowns
        managed.client = null;
        managed.process = undefined;
        return;
      }

      console.warn(`[McaManager] MCA process died: ${appId}`);
      managed.status = 'error';
      managed.lastError = 'Process exited unexpectedly';

      // Auto-restart if under limit
      if (managed.restartCount < this.config.maxRestarts) {
        console.log(
          `[McaManager] Auto-restarting MCA: ${appId} (attempt ${managed.restartCount + 1}/${this.config.maxRestarts})`,
        );
        this.spawn(appId, managed.restartCount + 1).catch((err) => {
          console.error(`[McaManager] Failed to restart MCA ${appId}:`, err);
        });
      } else {
        console.error(
          `[McaManager] MCA ${appId} exceeded max restarts (${this.config.maxRestarts})`,
        );
      }
    };
  }

  /**
   * Wait for MCA to be ready (when it's starting)
   */
  private async waitForReady(appId: string, timeoutMs: number = 30000): Promise<ManagedMca> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const managed = this.mcas.get(appId);
      if (!managed) {
        throw new Error(`MCA disappeared while waiting: ${appId}`);
      }

      if (managed.status === 'ready') {
        managed.lastUsed = new Date();
        return managed;
      }

      if (managed.status === 'error') {
        throw new Error(`MCA failed to start: ${appId} - ${managed.lastError}`);
      }

      // Wait a bit before checking again
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error(`Timeout waiting for MCA to start: ${appId}`);
  }

  /**
   * Execute a tool on the appropriate MCA
   * Returns output, error status, and mcaId for renderer matching
   *
   * If the MCA is not ready, attempts to spawn it first.
   * If spawn fails, returns a descriptive error.
   */
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
    },
  ): Promise<{ output: string; isError: boolean; mcaId: string }> {
    // SECURITY: If appId is provided, use it directly to prevent cross-user access
    // This is the secure path - the caller (McaToolExecutor) knows exactly which app to use
    let managed: ManagedMca | undefined;

    if (context?.appId) {
      managed = this.mcas.get(context.appId);
      if (!managed) {
        // App not registered yet, try to register it
        console.log(`[McaManager] App ${context.appId} not registered, attempting to register...`);
        try {
          managed = (await this.registerApp(context.appId)) ?? undefined;
        } catch (error: any) {
          // Return a clear, descriptive error instead of leaking internal Node.js errors
          // (e.g. "path must be a string or TypedArray" when mcaId is undefined)
          const appNamePrefix = toolName.split('_')[0];
          return {
            output: `Error: Cannot execute tool '${toolName}'. The app '${appNamePrefix}' is not installed or you don't have access to it.`,
            isError: true,
            mcaId: 'unknown',
          };
        }
        // registerApp returns null when the app doesn't exist or has no tools configured
        if (!managed) {
          const appNamePrefix = toolName.split('_')[0];
          return {
            output: `Error: Cannot execute tool '${toolName}'. The app '${appNamePrefix}' is not installed or you don't have access to it.`,
            isError: true,
            mcaId: 'unknown',
          };
        }
      }
    }

    // Fallback: Find by tool name (DEPRECATED - only for backwards compatibility)
    // This path is less secure as it can match wrong apps with same name
    if (!managed) {
      console.warn(
        `[McaManager] executeTool called without appId for tool '${toolName}' - using fallback lookup`,
      );

      for (const mca of this.mcas.values()) {
        if (mca.toolNameMapping.has(toolName)) {
          managed = mca;
          break;
        }
      }

      // If no managed MCA found, try to find by tool name prefix (appName_toolName)
      if (!managed) {
        const appName = toolName.split('_')[0];

        // Search for an app with this name
        for (const mca of this.mcas.values()) {
          if (mca.appName === appName) {
            managed = mca;
            break;
          }
        }
      }
    }

    if (!managed) {
      // Tool not found in any managed MCA
      return {
        output: `Error: Tool '${toolName}' not found. The MCA may not be installed or configured.`,
        isError: true,
        mcaId: 'unknown',
      };
    }

    // If MCA is disabled, don't even try
    if (managed.status === 'disabled') {
      return {
        output: `Error: Tool '${toolName}' is disabled. The MCA has been disabled by the user.`,
        isError: true,
        mcaId: managed.mcaId,
      };
    }

    // Check cached health - if not ready, return error immediately without calling MCA
    const cachedHealth = this.getCachedHealthIfNotReady(managed.appId);
    if (cachedHealth) {
      console.log(
        `[McaManager] MCA ${managed.appId} not ready (cached health: ${cachedHealth.status})`,
      );
      return {
        output: JSON.stringify({
          error: 'MCA_NOT_READY',
          message: cachedHealth.message || 'MCA is not ready',
          status: cachedHealth.status,
          issues: cachedHealth.issues,
        }),
        isError: true,
        mcaId: managed.mcaId,
      };
    }

    // If MCA is not ready (standby or error), try to spawn it
    if (managed.status !== 'ready') {
      console.log(
        `[McaManager] MCA ${managed.appId} not ready (status: ${managed.status}), attempting to spawn...`,
      );

      try {
        await this.getOrSpawn(managed.appId);
        // Re-fetch the managed MCA after spawn
        managed = this.mcas.get(managed.appId);

        if (!managed || managed.status !== 'ready') {
          return {
            output: `Error: Failed to start MCA for tool '${toolName}'. ${managed?.lastError || 'Unknown error'}`,
            isError: true,
            mcaId: managed?.mcaId || 'unknown',
          };
        }
      } catch (error: any) {
        return {
          output: `Error: Cannot execute tool '${toolName}'. The MCA failed to start: ${error.message}`,
          isError: true,
          mcaId: managed?.mcaId || 'unknown',
        };
      }
    }

    // Safety check - managed should be defined and ready at this point
    if (!managed) {
      return {
        output: `Error: Internal error - MCA not found after spawn attempt`,
        isError: true,
        mcaId: 'unknown',
      };
    }

    // Get original tool name
    const originalToolName = managed.toolNameMapping.get(toolName);
    if (!originalToolName) {
      return {
        output: `Error: Tool mapping not found for '${toolName}'. This may be a configuration issue.`,
        isError: true,
        mcaId: managed.mcaId,
      };
    }

    console.log(
      `[McaManager] Executing tool: ${toolName} (original: ${originalToolName}) on ${managed.appId}`,
    );

    // Validate input size before execution
    const validationError = validateToolInputSize(input, toolName, managed.appId);
    if (validationError) {
      return {
        ...validationError,
        mcaId: managed.mcaId,
      };
    }

    // Set execution context for agent-to-agent communication
    // This allows the MCA to know which agent is currently using it
    if (this.connectionManager && context) {
      this.connectionManager.setContext(managed.appId, {
        agentId: context.agentId,
        channelId: context.channelId,
        workspaceId: context.workspaceId,
      });
    }

    // Check if this is an HTTP-based MCA (container)
    const httpClient = this.httpClients.get(managed.appId);
    if (httpClient) {
      return this.executeToolViaHttp(managed, originalToolName, input, httpClient, context);
    }

    // Otherwise use stdio client
    if (!managed.client) {
      return {
        output: `Error: MCA client not available for tool '${toolName}'. The MCA may not be running.`,
        isError: true,
        mcaId: managed.mcaId,
      };
    }

    try {
      managed.lastUsed = new Date();

      const result = await managed.client.callTool({
        name: originalToolName,
        arguments: input,
      });

      // Extract text from content array
      let output = '';
      const content = result.content as Array<{ type: string; text?: string }>;
      for (const item of content) {
        if (item.type === 'text' && item.text) {
          output += item.text;
        }
      }

      // Truncate output if it exceeds the limit
      output = truncateToolOutput(output, toolName, managed.appId);

      const isError = result.isError === true;
      console.log(
        `[McaManager] Tool executed: ${toolName} (isError: ${isError}, length: ${output.length})`,
      );

      return { output, isError, mcaId: managed.mcaId };
    } catch (error: any) {
      console.error(`[McaManager] Tool execution failed: ${toolName}`, error);
      captureException(error, { context: 'executeToolStdio', toolName, appId: managed.appId });
      return {
        output: `Error executing tool '${toolName}': ${error.message}`,
        isError: true,
        mcaId: managed.mcaId,
      };
    }
  }

  /**
   * Execute a tool via HTTP (for containerized MCAs)
   */
  private async executeToolViaHttp(
    managed: ManagedMca,
    toolName: string,
    input: Record<string, any>,
    httpClient: McaHttpClient,
    context?: {
      agentId?: string;
      channelId?: string;
      appId?: string;
      userId?: string;
      workspaceId?: string;
      userDisplayName?: string;
      userAvatarUrl?: string;
    },
  ): Promise<{ output: string; isError: boolean; mcaId: string }> {
    try {
      managed.lastUsed = new Date();
      // Use containerKey if available (for proper shared/per-app tracking)
      this.containerManager.touch(managed.containerKey || managed.mcaId);

      // Build execution context with callbackUrl
      // Use host.docker.internal for Docker containers, localhost for local processes
      const callbackHost = managed.containerKey ? 'host.docker.internal' : 'localhost';
      const executionContext = {
        userId: context?.userId || 'system',
        workspaceId: context?.workspaceId,
        userDisplayName: context?.userDisplayName,
        userAvatarUrl: context?.userAvatarUrl,
        agentId: context?.agentId,
        appId: managed.appId,
        requestId: `req-${Date.now()}`,
        callbackUrl: `http://${callbackHost}:${this.config.serverPort}/mca/callback/${managed.appId}`,
      };

      const result = await httpClient.callTool(toolName, input, executionContext);

      // Extract result from response
      let output = '';
      if (result.success && result.result !== undefined) {
        output =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result, null, 2);
      } else if (result.error) {
        output = `Error: ${result.error.message || result.error.code}`;
      }

      // Truncate output if it exceeds the limit
      output = truncateToolOutput(output, toolName, managed.appId);

      const isError = !result.success;
      console.log(
        `[McaManager] Tool executed via HTTP: ${toolName} (isError: ${isError}, length: ${output.length})`,
      );

      return { output, isError, mcaId: managed.mcaId };
    } catch (error: any) {
      console.error(`[McaManager] HTTP tool execution failed: ${toolName}`, error);
      captureException(error, { context: 'executeToolHttp', toolName, appId: managed.appId });
      return {
        output: `Error executing tool '${toolName}': ${error.message}`,
        isError: true,
        mcaId: managed.mcaId,
      };
    }
  }

  /**
   * Get mcaId for a tool name (for streaming metadata)
   *
   * Searches all registered MCAs (including standby) since toolNameMapping
   * is populated from tools.json even before the MCA process is spawned.
   */
  getMcaIdForTool(toolName: string): string | undefined {
    for (const mca of this.mcas.values()) {
      // Check all MCAs that have tool mappings, not just 'ready' ones
      // toolNameMapping is populated from tools.json even in 'standby' status
      if (mca.toolNameMapping.has(toolName)) {
        return mca.mcaId;
      }
    }
    return undefined;
  }

  /**
   * Get tools for a specific app
   * Falls back to tools from tools.json if MCA is not ready (standby)
   */
  async getToolsForApp(
    appId: string,
  ): Promise<{
    tools: ToolDefinition[];
    status: 'ready' | 'standby' | 'error' | 'disabled';
    error?: string;
  }> {
    const managed = this.mcas.get(appId);

    // If MCA is disabled, return no tools
    if (managed && managed.status === 'disabled') {
      return { tools: [], status: 'disabled' };
    }

    // If MCA is ready, use live tools
    if (managed && managed.status === 'ready') {
      return { tools: managed.tools, status: 'ready' };
    }

    // If MCA is in standby, return its cached tools
    if (managed && managed.status === 'standby') {
      return { tools: managed.tools, status: 'standby' };
    }

    // If MCA is in error state or not registered, try to load tools from tools.json
    const app = await this.mcaService.getApp(appId);
    if (!app) {
      return { tools: [], status: 'error', error: `App not found: ${appId}` };
    }

    const staticTools = this.loadStaticTools(app.mcaId);
    if (staticTools.length === 0) {
      return {
        tools: [],
        status: 'error',
        error: managed?.lastError || `No tools.json found for ${app.mcaId}`,
      };
    }

    const { tools } = this.convertStaticTools(staticTools, app.name);
    return {
      tools,
      status: 'standby',
      error: managed?.lastError,
    };
  }

  /**
   * Kill a specific MCA process
   */
  async kill(appId: string): Promise<void> {
    const managed = this.mcas.get(appId);
    if (!managed) return;

    console.log(`[McaManager] Killing MCA: ${appId}`);
    managed.status = 'stopping';

    try {
      await managed.client?.close();
      managed.process?.kill();
    } catch (error: any) {
      console.warn(`[McaManager] Error killing MCA ${appId}:`, error.message);
    }

    // Don't delete - let onclose handler transition to standby
    // this.mcas.delete(appId);
  }

  /**
   * Cleanup inactive MCAs
   *
   * MCAs with active subscriptions are kept alive even if idle.
   */
  async cleanupInactive(): Promise<string[]> {
    const now = Date.now();
    const toKill: string[] = [];

    for (const [appId, managed] of this.mcas.entries()) {
      const idleTime = now - managed.lastUsed.getTime();

      // Skip if not idle enough or not ready
      if (idleTime <= this.config.maxIdleMs || managed.status !== 'ready') {
        continue;
      }

      // Check for active subscriptions (keep alive if has subscriptions)
      if (this.connectionManager) {
        const hasSubscriptions = await this.connectionManager.hasActiveSubscriptions(appId);
        if (hasSubscriptions) {
          console.log(`[McaManager] Keeping ${appId} alive (has active subscriptions)`);
          continue;
        }
      }

      toKill.push(appId);
    }

    for (const appId of toKill) {
      console.log(`[McaManager] Cleaning up inactive MCA: ${appId}`);
      await this.kill(appId);
    }

    return toKill;
  }

  /**
   * Start cleanup interval
   */
  private startCleanupInterval(): void {
    this.cleanupInterval = setInterval(async () => {
      try {
        const cleaned = await this.cleanupInactive();
        if (cleaned.length > 0) {
          console.log(`[McaManager] Cleaned up ${cleaned.length} inactive MCAs`);
        }
      } catch (error) {
        console.error('[McaManager] Error in cleanup interval:', error);
      }
    }, this.config.cleanupIntervalMs);
  }

  /**
   * Shutdown all MCAs
   */
  async shutdown(): Promise<void> {
    console.log('[McaManager] Shutting down all MCAs...');
    this.isShuttingDown = true;

    // Stop cleanup interval
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    // Kill all stdio MCAs
    const appIds = Array.from(this.mcas.keys());
    for (const appId of appIds) {
      await this.kill(appId);
    }

    // Shutdown all containers
    await this.containerManager.shutdown();

    // Clear HTTP clients
    this.httpClients.clear();

    console.log('[McaManager] All MCAs shut down');
  }

  /**
   * Get the host port for a running MCA by mcaId
   * Returns undefined if MCA is not running
   * Used to directly access MCA HTTP endpoints (e.g., for memory context)
   */
  getMcaPort(mcaId: string): number | undefined {
    return this.containerManager.getContainerPort(mcaId);
  }

  /**
   * Get status of all managed MCAs (for debugging/monitoring)
   */
  getStatus(): Array<{
    appId: string;
    mcaId: string;
    status: string;
    toolCount: number;
    lastUsed: Date;
    restartCount: number;
    health?: HealthCheckResult;
  }> {
    return Array.from(this.mcas.values()).map((m) => ({
      appId: m.appId,
      mcaId: m.mcaId,
      status: m.status,
      toolCount: m.tools.length,
      lastUsed: m.lastUsed,
      restartCount: m.restartCount,
      health: m.health,
    }));
  }

  /**
   * Check health of an MCA
   *
   * This spawns the MCA if not running and calls the special `_health_check` tool.
   * If the tool doesn't exist, health is inferred from MCA status.
   *
   * @param appId - The app ID to check
   * @param forceSpawn - If true, spawns the MCA even if in standby (default: true)
   * @returns Health check result
   */
  async checkHealth(appId: string, forceSpawn: boolean = true): Promise<HealthCheckResult> {
    console.log(`[McaManager] Checking health for app: ${appId}`);

    let managed = this.mcas.get(appId);

    // If not registered, try to register it first
    if (!managed) {
      const registered = await this.registerApp(appId);
      if (!registered) {
        return {
          status: 'unhealthy',
          message: `App not found: ${appId}`,
          checkedAt: new Date(),
        };
      }
      managed = registered;
    }

    // If disabled, return unhealthy
    if (managed.status === 'disabled') {
      const result: HealthCheckResult = {
        status: 'unhealthy',
        message: 'MCA is disabled',
        checkedAt: new Date(),
      };
      managed.health = result;
      return result;
    }

    // If not ready and forceSpawn, try to spawn
    if (managed.status !== 'ready' && forceSpawn) {
      try {
        await this.getOrSpawn(appId);
        managed = this.mcas.get(appId);
      } catch (error: any) {
        const result: HealthCheckResult = {
          status: 'unhealthy',
          message: `Failed to start MCA: ${error.message}`,
          details: {
            secretsConfigured: undefined,
            credentialsConfigured: undefined,
            credentialsError: error.message,
          },
          checkedAt: new Date(),
        };
        if (managed) {
          managed.health = result;
        }
        return result;
      }
    }

    // If still not ready after spawn attempt
    if (!managed || managed.status !== 'ready' || !managed.client) {
      const result: HealthCheckResult = {
        status: 'unknown',
        message: `MCA not running (status: ${managed?.status || 'unknown'})`,
        checkedAt: new Date(),
      };
      if (managed) {
        managed.health = result;
      }
      return result;
    }

    // Check if MCA has _health_check tool
    const hasHealthCheck =
      managed.toolNameMapping.has(`${managed.appName}__health-check`) ||
      Array.from(managed.toolNameMapping.values()).includes('_health_check');

    if (!hasHealthCheck) {
      // No health check tool - infer from MCA status
      const result: HealthCheckResult = {
        status: managed.status === 'ready' ? 'healthy' : 'unknown',
        message:
          managed.status === 'ready'
            ? 'MCA is running (no health check tool available)'
            : `MCA status: ${managed.status}`,
        checkedAt: new Date(),
      };
      managed.health = result;
      return result;
    }

    // Call the health check tool
    try {
      const toolResult = await managed.client.callTool({
        name: '_health_check',
        arguments: {},
      });

      // Parse result
      const content = toolResult.content as Array<{ type: string; text?: string }>;
      let healthData: any = {};

      for (const item of content) {
        if (item.type === 'text' && item.text) {
          try {
            healthData = JSON.parse(item.text);
          } catch {
            healthData = { message: item.text };
          }
        }
      }

      const result: HealthCheckResult = {
        status: toolResult.isError ? 'not_ready' : healthData.status || 'ready',
        message: healthData.message,
        issues: healthData.issues, // New format
        details: healthData.details, // Old format
        version: healthData.version,
        uptime: healthData.uptime,
        checkedAt: new Date(),
      };

      managed.health = result;
      console.log(`[McaManager] Health check for ${appId}: ${result.status}`);
      return result;
    } catch (error: any) {
      const result: HealthCheckResult = {
        status: 'not_ready',
        message: `Health check failed: ${error.message}`,
        checkedAt: new Date(),
      };
      managed.health = result;
      return result;
    }
  }

  /**
   * Get cached health result for an app (without running a new check)
   */
  getHealth(appId: string): HealthCheckResult | undefined {
    return this.mcas.get(appId)?.health;
  }

  /**
   * Check health of all registered MCAs
   *
   * @param forceSpawn - If true, spawns MCAs that are in standby
   * @returns Map of appId -> HealthCheckResult
   */
  async checkAllHealth(forceSpawn: boolean = false): Promise<Map<string, HealthCheckResult>> {
    const results = new Map<string, HealthCheckResult>();

    for (const appId of this.mcas.keys()) {
      const result = await this.checkHealth(appId, forceSpawn);
      results.set(appId, result);
    }

    return results;
  }

  /**
   * Perform initial health check after spawn (async, non-blocking)
   * This caches the health status so we don't need to check on every tool call
   */
  private async performInitialHealthCheck(appId: string): Promise<void> {
    const managed = this.mcas.get(appId);
    if (!managed || managed.status !== 'ready') return;

    // Check if MCA has _health_check tool
    const hasHealthCheck =
      managed.toolNameMapping.has(`${managed.appName}__health-check`) ||
      Array.from(managed.toolNameMapping.values()).includes('_health_check');

    if (!hasHealthCheck) {
      // No health check tool - assume ready
      managed.health = {
        status: 'ready',
        message: 'MCA is running (no health check tool)',
        checkedAt: new Date(),
      };
      return;
    }

    // Perform health check
    try {
      await this.checkHealth(appId, false);
      console.log(
        `[McaManager] Initial health check completed for ${appId}: ${managed.health?.status}`,
      );
    } catch (error: any) {
      console.warn(`[McaManager] Initial health check failed for ${appId}:`, error.message);
    }
  }

  /**
   * Update health status from WebSocket notification
   * Called by McaConnectionManager when MCA sends health_update
   */
  updateHealthFromWebSocket(appId: string, status: HealthStatus, issues?: HealthIssue[]): void {
    const managed = this.mcas.get(appId);
    if (!managed) {
      console.warn(`[McaManager] Cannot update health for unknown appId: ${appId}`);
      return;
    }

    managed.health = {
      status,
      issues,
      message: issues?.[0]?.message,
      checkedAt: new Date(),
    };

    console.log(`[McaManager] Health updated via WebSocket for ${appId}: ${status}`);
  }

  /**
   * Check if an MCA is ready to execute tools (using cached health)
   * Returns the cached health result if not ready, null if ready
   */
  getCachedHealthIfNotReady(appId: string): HealthCheckResult | null {
    const managed = this.mcas.get(appId);
    if (!managed) return null;

    // If no health info, assume ready
    if (!managed.health) return null;

    // Check if ready
    if (isHealthReady(managed.health)) return null;

    // Not ready - return the cached health result
    return managed.health;
  }
}
