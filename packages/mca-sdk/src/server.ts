/**
 * MCA Server (Wrapper)
 *
 * Unified class for building MCAs that auto-detects transport.
 * Delegates to McaHttpServer or McaStdioServer based on configuration.
 *
 * Transport selection (in order of priority):
 * 1. config.transport (explicit)
 * 2. MCA_TRANSPORT env var ('http' or 'stdio')
 * 3. Default: 'http'
 *
 * Usage:
 * ```typescript
 * const server = new McaServer({
 *   id: 'mca.example.tool',
 *   name: 'Example Tool',
 *   version: '1.0.0',
 * });
 *
 * server.tool('my_tool', {
 *   description: 'Does something useful',
 *   parameters: {
 *     type: 'object',
 *     properties: {
 *       input: { type: 'string' }
 *     },
 *     required: ['input']
 *   },
 *   handler: async (args, context) => {
 *     return { result: args.input.toUpperCase() };
 *   }
 * });
 *
 * server.start();
 * ```
 *
 * @see docs/RFC-001-mca-protocol.md
 */

import {
  type ToolConfig as HttpToolConfig,
  type ToolContext as HttpToolContext,
  McaHttpServer,
} from './http-server';
import {
  McaStdioServer,
  type ToolConfig as StdioToolConfig,
  type ToolContext as StdioToolContext,
} from './stdio-server';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Transport type
 * - 'http': HTTP server (default)
 * - 'stdio': MCP over stdio
 * - 'auto': Auto-detect from environment
 */
export type TransportType = 'http' | 'stdio' | 'auto';

/**
 * Tool handler function (unified type)
 */
export type ToolHandler<TArgs = Record<string, unknown>, TResult = unknown> = (
  args: TArgs,
  context: ToolContext,
) => Promise<TResult> | TResult;

/**
 * Tool configuration
 */
export interface ToolConfig<TArgs = Record<string, unknown>, TResult = unknown> {
  /** Human-readable description */
  description: string;
  /** JSON Schema for parameters */
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  /** Handler function */
  handler: ToolHandler<TArgs, TResult>;
}

/**
 * Context passed to tool handlers (unified type)
 */
export interface ToolContext {
  /** Execution context from request */
  execution: {
    userId: string;
    appId: string;
    mcaId?: string;
    channelId?: string;
    agentId?: string;
    workspaceId?: string;
    requestId?: string;
    callbackUrl?: string;
  };
  /** Backend client (if callbackUrl available) */
  backend: any;
  /** Get system secrets */
  getSystemSecrets: () => Promise<Record<string, string>>;
  /** Get user secrets */
  getUserSecrets: () => Promise<Record<string, string>>;
  /** Update user secrets (e.g. after token refresh) */
  updateUserSecrets: (secrets: Record<string, string>) => Promise<void>;
  /** Get the scope for data storage (workspaceId or userId) */
  getScope: () => string;
  /** Get stored data by key (scoped to workspace or user) */
  getData: (key: string) => Promise<{ value: any; exists: boolean }>;
  /** Set data by key (scoped to workspace or user) */
  setData: (key: string, value: any) => Promise<{ success: boolean }>;
  /** Delete data by key (scoped to workspace or user) */
  deleteData: (key: string) => Promise<{ success: boolean; deleted: boolean }>;
  /** List all data keys for the current scope */
  listData: () => Promise<{ keys: Array<{ key: string; updatedAt: string }> }>;
}

/**
 * MCA Server configuration
 */
export interface McaServerConfig {
  /** MCA ID (e.g., 'mca.teros.bash') */
  id: string;
  /** Display name */
  name: string;
  /** Version string */
  version: string;
  /** Transport type (default: 'auto' which checks MCA_TRANSPORT env, then defaults to 'http') */
  transport?: TransportType;
  /** HTTP port (for HTTP transport, defaults to PORT env or 10001) */
  port?: number;
  /** HTTP host (for HTTP transport, defaults to '0.0.0.0') */
  host?: string;
}

/**
 * Health check result
 */
export interface HealthCheckResult {
  status: 'ready' | 'not_ready' | 'degraded';
  message?: string;
}

// ============================================================================
// REGISTERED TOOL (internal)
// ============================================================================

interface RegisteredTool {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: ToolHandler;
}

// ============================================================================
// MCA SERVER (WRAPPER)
// ============================================================================

export class McaServer {
  private config: McaServerConfig;
  private tools = new Map<string, RegisteredTool>();
  private httpServer: McaHttpServer | null = null;
  private stdioServer: McaStdioServer | null = null;
  private activeTransport: 'http' | 'stdio' = 'http';
  private healthCheckFn: (() => Promise<HealthCheckResult> | HealthCheckResult) | null = null;

  constructor(config: McaServerConfig) {
    this.config = config;
  }

  // ==========================================================================
  // TOOL REGISTRATION
  // ==========================================================================

  /**
   * Register a tool
   */
  tool<TArgs = Record<string, unknown>, TResult = unknown>(
    name: string,
    config: ToolConfig<TArgs, TResult>,
  ): void {
    this.tools.set(name, {
      name,
      description: config.description,
      parameters: config.parameters,
      handler: config.handler as ToolHandler,
    });
  }

  /**
   * Set health check function
   */
  setHealthCheck(fn: () => Promise<HealthCheckResult> | HealthCheckResult): void {
    this.healthCheckFn = fn;
  }

  // ==========================================================================
  // TRANSPORT DETECTION
  // ==========================================================================

  /**
   * Determine which transport to use
   */
  private determineTransport(): 'http' | 'stdio' {
    const configTransport = this.config.transport || 'auto';

    // Explicit transport in config
    if (configTransport === 'stdio') return 'stdio';
    if (configTransport === 'http') return 'http';

    // Auto-detect from environment
    const envTransport = process.env.MCA_TRANSPORT?.toLowerCase();
    if (envTransport === 'stdio') return 'stdio';
    if (envTransport === 'http') return 'http';

    // Default to HTTP
    return 'http';
  }

  // ==========================================================================
  // LIFECYCLE
  // ==========================================================================

  /**
   * Start the MCA server
   */
  async start(): Promise<void> {
    this.activeTransport = this.determineTransport();
    console.error(
      `[McaServer:${this.config.id}] Starting with ${this.activeTransport} transport...`,
    );

    if (this.activeTransport === 'http') {
      await this.startHttpTransport();
    } else {
      await this.startStdioTransport();
    }

    console.error(
      `[McaServer:${this.config.id}] Started with ${this.tools.size} tools (${this.activeTransport})`,
    );
  }

  /**
   * Start HTTP transport
   */
  private async startHttpTransport(): Promise<void> {
    const port =
      this.config.port || parseInt(process.env.PORT || process.env.MCA_HTTP_PORT || '10001', 10);
    const host = this.config.host || process.env.MCA_HTTP_HOST || '0.0.0.0';

    this.httpServer = new McaHttpServer({
      id: this.config.id,
      name: this.config.name,
      version: this.config.version,
      port,
      host,
    });

    // Register all tools with HTTP server
    for (const [name, tool] of this.tools) {
      this.httpServer.tool(name, {
        description: tool.description,
        parameters: tool.parameters,
        handler: tool.handler as any,
      });
    }

    // Set health check if configured
    if (this.healthCheckFn) {
      this.httpServer.setHealthCheck(this.healthCheckFn);
    }

    await this.httpServer.start();
  }

  /**
   * Start stdio transport
   */
  private async startStdioTransport(): Promise<void> {
    this.stdioServer = new McaStdioServer({
      id: this.config.id,
      name: this.config.name,
      version: this.config.version,
    });

    // Register all tools with stdio server
    for (const [name, tool] of this.tools) {
      this.stdioServer.tool(name, {
        description: tool.description,
        parameters: tool.parameters,
        handler: tool.handler as any,
      });
    }

    await this.stdioServer.start();
  }

  /**
   * Stop the MCA server
   */
  async stop(): Promise<void> {
    console.error(`[McaServer:${this.config.id}] Stopping...`);

    if (this.httpServer) {
      await this.httpServer.stop();
      this.httpServer = null;
    }

    if (this.stdioServer) {
      await this.stdioServer.stop();
      this.stdioServer = null;
    }
  }
}

// ============================================================================
// FACTORY FUNCTION
// ============================================================================

/**
 * Create an MCA server
 */
export function createMcaServer(config: McaServerConfig): McaServer {
  return new McaServer(config);
}
