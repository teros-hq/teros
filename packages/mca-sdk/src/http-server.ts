/**
 * HTTP Server for MCAs
 *
 * Provides an HTTP interface for MCAs to receive requests from the backend.
 * This allows MCAs to run as independent containers/services.
 *
 * Endpoints:
 * - POST /tools/call - Execute a tool
 * - GET /tools/list - List available tools
 * - GET /health - Health check
 * - POST /shutdown - Graceful shutdown
 *
 * @see docs/RFC-001-mca-protocol.md
 */

import type {
  McaErrorResponse,
  McaExecutionContext,
  McaHealthStatusResponse,
  McaToolCallRequest,
  McaToolDefinition,
  McaToolResultResponse,
  McaToolsListResponse,
} from '@teros/shared';
import { generateMessageId, MCA_PROTOCOL_VERSION, McaErrorCode } from '@teros/shared';
import type { Server as HttpServer } from 'http';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { McaBackendClient } from './backend-client';

// ============================================================================
// TYPES
// ============================================================================

export interface HttpServerConfig {
  /** Port to listen on */
  port: number;
  /** Host to bind to (default: '0.0.0.0') */
  host?: string;
  /** Request timeout in ms (default: 120000) */
  timeout?: number;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  context: ToolContext,
) => Promise<unknown> | unknown;

export interface ToolContext {
  /** Execution context from request */
  execution: McaExecutionContext;
  /** Request ID */
  requestId: string;
  /** Backend client for MCA → Backend calls (null if no callbackUrl) */
  backend: McaBackendClient | null;

  // ==========================================================================
  // SECRETS
  // ==========================================================================

  getSystemSecrets: () => Promise<Record<string, string>>;
  getUserSecrets: () => Promise<Record<string, string>>;
  updateUserSecrets: (secrets: Record<string, string>) => Promise<void>;

  // ==========================================================================
  // RESOURCES: AGENTS
  // ==========================================================================

  agentList: (workspaceId?: string) => Promise<{ agents: any[] }>;
  agentGet: (agentId: string) => Promise<any>;
  agentCreate: (data: {
    coreId: string;
    name: string;
    fullName: string;
    role: string;
    intro: string;
    workspaceId?: string;
  }) => Promise<any>;
  agentUpdate: (
    agentId: string,
    data: {
      name?: string;
      fullName?: string;
      role?: string;
      intro?: string;
      responseStyle?: string;
      avatarUrl?: string;
      context?: string;
    },
  ) => Promise<any>;
  agentDelete: (agentId: string) => Promise<any>;
  agentAppsList: (agentId: string) => Promise<{ apps: any[] }>;

  // ==========================================================================
  // RESOURCES: WORKSPACES
  // ==========================================================================

  workspaceList: () => Promise<{ workspaces: any[] }>;
  workspaceGet: (workspaceId: string) => Promise<any>;
  workspaceCreate: (data: { name: string; description?: string }) => Promise<any>;
  workspaceUpdate: (
    workspaceId: string,
    data: { name?: string; description?: string; context?: string },
  ) => Promise<any>;
  workspaceArchive: (workspaceId: string) => Promise<any>;
  workspaceMemberAdd: (workspaceId: string, userId: string, role: string) => Promise<any>;
  workspaceMemberRemove: (workspaceId: string, userId: string) => Promise<any>;
  workspaceMemberUpdate: (workspaceId: string, userId: string, role: string) => Promise<any>;

  // ==========================================================================
  // RESOURCES: APPS
  // ==========================================================================

  appList: () => Promise<{ apps: any[] }>;
  appGet: (appId: string) => Promise<any>;
  appInstall: (mcaId: string, name?: string, workspaceId?: string) => Promise<any>;
  appUninstall: (appId: string) => Promise<any>;
  appRename: (appId: string, name: string) => Promise<any>;
  appAccessList: (appId: string) => Promise<{ agents: any[] }>;
  workspaceAppList: (workspaceId: string) => Promise<{ apps: any[] }>;
  workspaceAgentList: (workspaceId: string) => Promise<{ agents: any[] }>;

  // ==========================================================================
  // RESOURCES: CATALOG & CORES
  // ==========================================================================

  catalogList: (category?: string, includeHidden?: boolean) => Promise<{ catalog: any[] }>;
  agentCoresList: () => Promise<{ cores: any[] }>;

  // ==========================================================================
  // RESOURCES: ACCESS CONTROL
  // ==========================================================================

  accessGrant: (agentId: string, appId: string) => Promise<any>;
  accessRevoke: (agentId: string, appId: string) => Promise<any>;

  // ==========================================================================
  // DATA STORAGE
  // ==========================================================================

  /**
   * Get the scope for data storage (workspaceId if available, otherwise userId)
   */
  getScope: () => string;

  /**
   * Get stored data by key (scoped to workspace or user)
   */
  getData: (key: string) => Promise<{ value: any; exists: boolean }>;

  /**
   * Set data by key (scoped to workspace or user)
   */
  setData: (key: string, value: any) => Promise<{ success: boolean }>;

  /**
   * Delete data by key (scoped to workspace or user)
   */
  deleteData: (key: string) => Promise<{ success: boolean; deleted: boolean }>;

  /**
   * List all data keys for the current scope
   */
  listData: () => Promise<{ keys: Array<{ key: string; updatedAt: string }> }>;
}

export interface RegisteredTool {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: ToolHandler;
}

/**
 * Tool configuration - same API as McaServer for compatibility
 */
export interface ToolConfig {
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: ToolHandler;
}

/**
 * Server configuration - same API as McaServer for compatibility
 */
export interface McaHttpServerConfig {
  /** MCA ID (e.g., 'mca.teros.core') */
  id: string;
  /** Display name */
  name: string;
  /** Version string */
  version: string;
  /** Port to listen on (default: from PORT env or 3000) */
  port?: number;
  /** Host to bind to (default: '0.0.0.0') */
  host?: string;
  /** Request timeout in ms (default: 120000) */
  timeout?: number;
}

export type HealthCheckFn = () =>
  | Promise<{ status: 'ready' | 'not_ready' | 'degraded'; message?: string }>
  | { status: 'ready' | 'not_ready' | 'degraded'; message?: string };

// ============================================================================
// BUILD RESOURCE METHODS
// ============================================================================

/**
 * Build resource methods for ToolContext from a backend client
 */
function buildResourceMethods(
  backendClient: McaBackendClient | null,
  execution: { workspaceId?: string; userId: string },
  errorPrefix: string,
): Omit<ToolContext, 'execution' | 'requestId' | 'backend'> {
  const requireClient = () => {
    if (!backendClient) {
      throw new Error(`${errorPrefix}: no callbackUrl configured`);
    }
    return backendClient;
  };

  // Scope for data storage: prefer workspaceId, fallback to userId
  const scope = execution.workspaceId || execution.userId;

  return {
    // Secrets
    getSystemSecrets: async () => {
      const response = await requireClient().getSystemSecrets();
      if (!response.secrets) {
        throw new Error(response.error || 'No system secrets available');
      }
      return response.secrets;
    },
    getUserSecrets: async () => {
      const response = await requireClient().getUserSecrets();
      if (!response.secrets) {
        throw new Error(response.error || 'No user secrets available');
      }
      return response.secrets;
    },
    updateUserSecrets: async (secrets: Record<string, string>) => {
      await requireClient().updateUserSecrets(secrets);
    },

    // Agents
    agentList: (workspaceId) => requireClient().agentList(workspaceId),
    agentGet: (agentId) => requireClient().agentGet(agentId),
    agentCreate: (data) => requireClient().agentCreate(data),
    agentUpdate: (agentId, data) => requireClient().agentUpdate(agentId, data),
    agentDelete: (agentId) => requireClient().agentDelete(agentId),
    agentAppsList: (agentId) => requireClient().agentAppsList(agentId),

    // Workspaces
    workspaceList: () => requireClient().workspaceList(),
    workspaceGet: (workspaceId) => requireClient().workspaceGet(workspaceId),
    workspaceCreate: (data) => requireClient().workspaceCreate(data),
    workspaceUpdate: (workspaceId, data) => requireClient().workspaceUpdate(workspaceId, data),
    workspaceArchive: (workspaceId) => requireClient().workspaceArchive(workspaceId),
    workspaceMemberAdd: (workspaceId, userId, role) =>
      requireClient().workspaceMemberAdd(workspaceId, userId, role),
    workspaceMemberRemove: (workspaceId, userId) =>
      requireClient().workspaceMemberRemove(workspaceId, userId),
    workspaceMemberUpdate: (workspaceId, userId, role) =>
      requireClient().workspaceMemberUpdate(workspaceId, userId, role),

    // Apps
    appList: () => requireClient().appList(),
    appGet: (appId) => requireClient().appGet(appId),
    appInstall: (mcaId, name, workspaceId) => requireClient().appInstall(mcaId, name, workspaceId),
    appUninstall: (appId) => requireClient().appUninstall(appId),
    appRename: (appId, name) => requireClient().appRename(appId, name),
    appAccessList: (appId) => requireClient().appAccessList(appId),
    workspaceAppList: (workspaceId) => requireClient().workspaceAppList(workspaceId),
    workspaceAgentList: (workspaceId) => requireClient().workspaceAgentList(workspaceId),

    // Catalog & Cores
    catalogList: (category, includeHidden) => requireClient().catalogList(category, includeHidden),
    agentCoresList: () => requireClient().agentCoresList(),

    // Access Control
    accessGrant: (agentId, appId) => requireClient().accessGrant(agentId, appId),
    accessRevoke: (agentId, appId) => requireClient().accessRevoke(agentId, appId),

    // Data Storage
    getScope: () => scope,
    getData: (key) => requireClient().getData(key, scope),
    setData: (key, value) => requireClient().setData(key, value, scope),
    deleteData: (key) => requireClient().deleteData(key, scope),
    listData: () => requireClient().listData(scope),
  };
}

// ============================================================================
// HTTP MCA SERVER
// ============================================================================

export class McaHttpServer {
  private httpConfig: Required<HttpServerConfig>;
  private server: HttpServer | null = null;
  private tools = new Map<string, RegisteredTool>();
  private healthCheckFn: HealthCheckFn | null = null;
  private startTime = Date.now();
  private mcaId: string;
  private mcaName: string;
  private mcaVersion: string;
  private isShuttingDown = false;

  /**
   * Create an MCA HTTP server
   *
   * @example
   * // New unified API (same as McaServer)
   * const server = new McaHttpServer({
   *   id: 'mca.teros.core',
   *   name: 'Teros Core',
   *   version: '1.0.0',
   * });
   *
   * // Legacy API (deprecated)
   * const server = new McaHttpServer('mca.teros.core', '1.0.0', { port: 3000 });
   */
  constructor(
    configOrId: McaHttpServerConfig | string,
    versionOrConfig?: string | HttpServerConfig,
    legacyConfig?: HttpServerConfig,
  ) {
    // Handle both new and legacy constructor signatures
    if (typeof configOrId === 'string') {
      // Legacy: new McaHttpServer(id, version, config)
      this.mcaId = configOrId;
      this.mcaName = configOrId;
      this.mcaVersion = versionOrConfig as string;
      const config = legacyConfig || { port: parseInt(process.env.PORT || '3000', 10) };
      this.httpConfig = {
        port: config.port,
        host: config.host ?? '0.0.0.0',
        timeout: config.timeout ?? 120000,
      };
    } else {
      // New: new McaHttpServer({ id, name, version, port?, host?, timeout? })
      this.mcaId = configOrId.id;
      this.mcaName = configOrId.name;
      this.mcaVersion = configOrId.version;
      this.httpConfig = {
        port: configOrId.port ?? parseInt(process.env.PORT || '3000', 10),
        host: configOrId.host ?? '0.0.0.0',
        timeout: configOrId.timeout ?? 120000,
      };
    }
  }

  /**
   * Register a tool (same API as McaServer)
   *
   * @example
   * server.tool('my-tool', {
   *   description: 'Does something',
   *   parameters: { type: 'object', properties: { input: { type: 'string' } } },
   *   handler: async (args, context) => { return 'result'; }
   * });
   */
  tool(name: string, config: ToolConfig): void {
    console.log(`[McaHttpServer:${this.mcaId}] Registered tool: ${name}`);
    this.tools.set(name, {
      name,
      description: config.description,
      parameters: config.parameters,
      handler: config.handler,
    });
  }

  /**
   * Register a tool (legacy method, use tool() instead)
   * @deprecated Use tool(name, config) instead
   */
  registerTool(tool: RegisteredTool): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * Set health check function
   */
  setHealthCheck(fn: HealthCheckFn): void {
    this.healthCheckFn = fn;
  }

  /**
   * Start the HTTP server
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handleRequest(req, res).catch((error) => {
          console.error(`[McaHttpServer] Unhandled error:`, error);
          this.sendError(res, 500, McaErrorCode.INTERNAL_ERROR, error.message);
        });
      });

      this.server.timeout = this.httpConfig.timeout;

      this.server.on('error', (error) => {
        reject(error);
      });

      this.server.listen(this.httpConfig.port, this.httpConfig.host, () => {
        console.log(
          `[McaHttpServer:${this.mcaId}] Listening on http://${this.httpConfig.host}:${this.httpConfig.port}`,
        );
        resolve();
      });
    });
  }

  /**
   * Stop the HTTP server
   */
  async stop(): Promise<void> {
    this.isShuttingDown = true;

    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }

      this.server.close(() => {
        console.log(`[McaHttpServer:${this.mcaId}] Stopped`);
        this.server = null;
        resolve();
      });
    });
  }

  /**
   * Handle incoming HTTP request
   */
  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url || '/';
    const method = req.method || 'GET';

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Route requests
    if (url === '/health' && method === 'GET') {
      await this.handleHealth(req, res);
    } else if (url === '/tools/list' && method === 'GET') {
      await this.handleListTools(req, res);
    } else if (url === '/tools/call' && method === 'POST') {
      await this.handleToolCall(req, res);
    } else if (url === '/shutdown' && method === 'POST') {
      await this.handleShutdown(req, res);
    } else {
      this.sendError(res, 404, 'NOT_FOUND', `Unknown endpoint: ${method} ${url}`);
    }
  }

  /**
   * Handle GET /health
   */
  private async handleHealth(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = generateMessageId();

    let status: 'ready' | 'not_ready' | 'degraded' = 'ready';
    let message = 'MCA is running';

    if (this.isShuttingDown) {
      status = 'not_ready';
      message = 'MCA is shutting down';
    } else if (this.healthCheckFn) {
      try {
        const result = await this.healthCheckFn();
        status = result.status;
        message = result.message || message;
      } catch (error: unknown) {
        status = 'not_ready';
        message = error instanceof Error ? error.message : 'Health check failed';
      }
    }

    const response: McaHealthStatusResponse = {
      id: requestId,
      type: 'health_status',
      timestamp: new Date().toISOString(),
      version: MCA_PROTOCOL_VERSION,
      status,
      message,
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
    };

    this.sendJson(res, 200, response);
  }

  /**
   * Handle GET /tools/list
   */
  private async handleListTools(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = generateMessageId();

    const tools: McaToolDefinition[] = Array.from(this.tools.values())
      .filter((tool) => !tool.name.startsWith('_'))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));

    const response: McaToolsListResponse = {
      id: requestId,
      type: 'tools_list',
      timestamp: new Date().toISOString(),
      version: MCA_PROTOCOL_VERSION,
      tools,
    };

    this.sendJson(res, 200, response);
  }

  /**
   * Handle POST /tools/call
   */
  private async handleToolCall(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startTime = Date.now();

    // Parse request body
    let body: McaToolCallRequest;
    try {
      body = await this.parseJsonBody<McaToolCallRequest>(req);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Invalid JSON';
      this.sendError(res, 400, McaErrorCode.INVALID_MESSAGE, message);
      return;
    }

    const requestId = body.id || generateMessageId();
    const toolName = body.tool;
    const args = body.arguments || {};
    const context = body.context;

    // Find tool
    const tool = this.tools.get(toolName);
    if (!tool) {
      this.sendError(
        res,
        404,
        McaErrorCode.TOOL_NOT_FOUND,
        `Tool not found: ${toolName}`,
        requestId,
      );
      return;
    }

    // Execute tool
    try {
      // Create backend client if callbackUrl is available
      const backendClient = context.callbackUrl
        ? new McaBackendClient({
            callbackUrl: context.callbackUrl,
            appId: context.appId,
            mcaId: this.mcaId,
          })
        : null;

      // Build full tool context with resource methods
      const toolContext: ToolContext = {
        execution: context,
        requestId,
        backend: backendClient,
        ...buildResourceMethods(backendClient, context, 'Cannot access resources'),
      };

      const result = await tool.handler(args, toolContext);
      const duration = Date.now() - startTime;

      const response: McaToolResultResponse = {
        id: requestId,
        type: 'tool_result',
        timestamp: new Date().toISOString(),
        version: MCA_PROTOCOL_VERSION,
        success: true,
        result,
        duration,
      };

      this.sendJson(res, 200, response);
    } catch (error: unknown) {
      const duration = Date.now() - startTime;
      const message = error instanceof Error ? error.message : String(error);

      const response: McaToolResultResponse = {
        id: requestId,
        type: 'tool_result',
        timestamp: new Date().toISOString(),
        version: MCA_PROTOCOL_VERSION,
        success: false,
        error: {
          code: McaErrorCode.INTERNAL_ERROR,
          message,
        },
        duration,
      };

      this.sendJson(res, 200, response); // 200 because tool executed, just returned error
    }
  }

  /**
   * Handle POST /shutdown
   */
  private async handleShutdown(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = generateMessageId();

    this.sendJson(res, 200, {
      id: requestId,
      type: 'shutdown_ack',
      timestamp: new Date().toISOString(),
      version: MCA_PROTOCOL_VERSION,
    });

    // Graceful shutdown after response
    setTimeout(() => {
      this.stop();
    }, 100);
  }

  /**
   * Parse JSON body from request
   */
  private parseJsonBody<T>(req: IncomingMessage): Promise<T> {
    return new Promise((resolve, reject) => {
      let body = '';

      req.on('data', (chunk) => {
        body += chunk.toString();

        // Limit body size (10MB)
        if (body.length > 10 * 1024 * 1024) {
          reject(new Error('Request body too large'));
        }
      });

      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve(parsed);
        } catch (error) {
          reject(new Error('Invalid JSON body'));
        }
      });

      req.on('error', reject);
    });
  }

  /**
   * Send JSON response
   */
  private sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  /**
   * Send error response
   */
  private sendError(
    res: ServerResponse,
    statusCode: number,
    code: string,
    message: string,
    requestId?: string,
  ): void {
    const response: McaErrorResponse = {
      id: requestId || generateMessageId(),
      type: 'error',
      timestamp: new Date().toISOString(),
      version: MCA_PROTOCOL_VERSION,
      error: { code, message },
    };

    this.sendJson(res, statusCode, response);
  }

  /**
   * Get server info
   */
  get info(): { host: string; port: number; url: string } {
    return {
      host: this.httpConfig.host,
      port: this.httpConfig.port,
      url: `http://${this.httpConfig.host}:${this.httpConfig.port}`,
    };
  }

  /** Get MCA configuration */
  get config(): { id: string; name: string; version: string } {
    return {
      id: this.mcaId,
      name: this.mcaName,
      version: this.mcaVersion,
    };
  }
}
