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
import type { VolumeStorage, ShareAccess, DocumentStorage, ObjectStorage } from './types';
import {
  type RenderFormat,
  type RenderedOutput,
  renderToOutput,
} from './renderer';

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
 * Optional metadata attached to a tool. Enables clients to handle
 * versioning, deprecation and staged rollout.
 */
export interface ToolAnnotations {
  /** Semver-like string (e.g. '1.0.0'). Informational. */
  version?: string;
  /** Stability signal. Clients MAY down-rank 'experimental' / 'deprecated'. */
  stability?: 'experimental' | 'stable' | 'deprecated';
  /** Explanation of the deprecation and suggested replacement. */
  deprecationMessage?: string;
  /** Teros — action cannot be undone (delete, send-with-no-unsend). Frontend shows a badge. */
  irreversible?: boolean;
  /** Teros policy — tool NEVER runs without human confirmation; user 'allow' config is ignored. */
  alwaysAsk?: boolean;
  /** Teros policy hint — mutating tool whose write is reversible/private/non-notifying; seeds 'allow' at install time. */
  safeWriteHint?: boolean;
  /** MCP spec hint — tool only reads, never mutates state. Clients MAY auto-approve. */
  readOnlyHint?: boolean;
  /** MCP spec hint — tool may modify or delete state irreversibly. Clients SHOULD confirm. */
  destructiveHint?: boolean;
  /** MCP spec hint — repeating the call with the same args has no extra effect. */
  idempotentHint?: boolean;
  /** MCP spec hint — tool reaches outside the local environment (network, external services). */
  openWorldHint?: boolean;
  /**
   * Catalog presentation (TER-538), author-curated. `summary` is a short
   * human sentence and `group` a domain label (e.g. 'Pages') shown in the
   * catalog detail. Optional — the sync falls back to a heuristic when absent.
   * These never reach the LLM (the model reads `description`).
   */
  summary?: string;
  group?: string;
  /**
   * Plain-text template for the approval card's intent line, with `{param}`
   * placeholders filled from the call's own arguments — e.g.
   * `'Delete the file at {path}'`. Rendered as text, never as markup, and
   * declined when a placeholder names an absent or non-primitive argument.
   */
  intentTemplate?: string;
}

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
  /**
   * Optional metadata for versioning and stability signals.
   * Example: { version: '1.2.0', stability: 'stable' }
   * When `stability: 'deprecated'`, consider adding `deprecationMessage`.
   */
  annotations?: ToolAnnotations;
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
    userDisplayName?: string;
    userAvatarUrl?: string;
    /** Per-execution credentials for personal apps (MUW-F3) */
    credentials?: Record<string, string>;
  };
  /** Backend client (if callbackUrl available) */
  backend: any;
  /**
   * AbortSignal that fires when the backend caller cancels the request.
   * Handlers SHOULD honor this signal to avoid wasted work / leaked side
   * effects on long-running operations.
   *
   * Transport semantics:
   * - **HTTP transport**: fires on `req.on('close')` (client closed the HTTP
   *   connection mid-call). Implemented in Phase 2.0.
   * - **Stdio transport**: currently a never-aborts stub. Real cancellation
   *   via MCP `notifications/cancelled` is roadmapped for Phase 2.6.
   *
   * Handlers that ignore this signal still work (the backend discards their
   * result via `cancellation_applied` guard) but waste compute and may
   * commit side effects after the cancel point.
   */
  signal: AbortSignal;
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
  /** Volume storage — unified file-system API (list, read, write, delete, stat, getTempPath) */
  volume: VolumeStorage;
  /** Share access — create and revoke public URLs for files (share, revoke) */
  share: ShareAccess;
  /** Document storage — MongoDB-backed key-document store scoped per installation (put, get, query, update, delete) */
  storage: DocumentStorage;
  /** Object storage — filesystem-backed blob store scoped per installation (put, get, delete, list) */
  objects: ObjectStorage;
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
  annotations?: ToolAnnotations;
}

// ============================================================================
// UI RESOURCE TYPES
// ============================================================================

/**
 * The kind of renderable component a resource produces.
 * - `tree`: hierarchical expandable node list (file trees, project structures)
 * - `detail`: flat key-value panel for a single entity (repo details, issue summary)
 * - `form`: interactive form with typed fields that the user fills and submits
 */
export type UiResourceType = 'tree' | 'detail' | 'form';

/**
 * A node in a tree view. `children` omitted = leaf node.
 */
export interface TreeNode {
  id: string;
  label: string;
  icon?: string;
  badge?: string;
  expanded?: boolean;
  children?: TreeNode[];
  meta?: Record<string, unknown>;
}

/**
 * A field in a detail panel.
 */
export interface DetailField {
  label: string;
  value: string | number | boolean;
  type?: 'text' | 'code' | 'date' | 'url' | 'markdown' | 'image';
  linkText?: string;
  alt?: string;
}

/**
 * A section within a detail panel.
 */
export interface DetailSection {
  title?: string;
  fields: DetailField[];
  icon?: string;
}

/**
 * A field in a form.
 */
export interface UiFormField {
  name: string;
  label: string;
  fieldType:
    | 'text'
    | 'textarea'
    | 'number'
    | 'select'
    | 'checkbox'
    | 'radio'
    | 'date'
    | 'time'
    | 'datetime';
  options?: Array<{ value: string; label: string }>;
  placeholder?: string;
  defaultValue?: string | number | boolean;
  helpText?: string;
  required?: boolean;
  min?: number;
  max?: number;
  pattern?: string;
}

/**
 * The renderable data a UI resource handler returns.
 * The discriminated union on `type` tells the host which renderer to use.
 */
export type UiResourceData =
  | { type: 'tree'; nodes: TreeNode[]; title?: string; multiSelect?: boolean }
  | {
      type: 'detail';
      title?: string;
      subtitle?: string;
      sections: DetailSection[];
      imageUrl?: string;
      badge?: string;
    }
  | {
      type: 'form';
      title?: string;
      description?: string;
      fields: UiFormField[];
      submitLabel?: string;
      cancelLabel?: string;
      submitTool?: string;
    };

/**
 * Handler function for a UI resource.
 * Called by the host when it needs to display the resource.
 * Receives the params the host passed and the tool context (for secrets, etc).
 */
export type UiResourceHandler<
  TParams = Record<string, unknown>,
  TData extends UiResourceData = UiResourceData,
> = (params: TParams, context: ToolContext) => Promise<TData> | TData;

/**
 * Configuration for a UI resource.
 *
 * @example
 * ```typescript
 * server.ui('tree', {
 *   name: 'repo-tree',
 *   description: 'GitHub repository file tree',
 *   parameters: {
 *     type: 'object',
 *     properties: { repo: { type: 'string' } },
 *     required: ['repo'],
 *   },
 *   boundTools: ['list-files'],
 *   handler: async (params) => ({
 *     type: 'tree',
 *     nodes: await fetchTree(params.repo),
 *   }),
 * });
 * ```
 */
export interface UiResourceConfig<
  TParams = Record<string, unknown>,
  TData extends UiResourceData = UiResourceData,
> {
  /** Unique name within the app (e.g. 'repo-tree', 'issue-detail') */
  name: string;
  /** Human-readable description */
  description: string;
  /** JSON Schema for parameters the handler accepts */
  parameters?: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  /** Tools this resource is associated with (host may offer "view as tree" on results) */
  boundTools?: string[];
  /** Events that trigger a refresh of this resource */
  refreshOnEvents?: string[];
  /** Handler that produces the renderable data */
  handler: UiResourceHandler<TParams, TData>;
}

/**
 * Internal representation of a registered UI resource.
 */
interface RegisteredUiResource {
  name: string;
  resourceType: UiResourceType;
  description: string;
  parameters?: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  boundTools?: string[];
  refreshOnEvents?: string[];
  handler: UiResourceHandler;
}

// ============================================================================
// MCA SERVER (WRAPPER)
// ============================================================================

export class McaServer {
  private config: McaServerConfig;
  private tools = new Map<string, RegisteredTool>();
  private uiResources = new Map<string, RegisteredUiResource>();
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
      annotations: config.annotations,
    });
  }

  /**
   * Set health check function
   */
  setHealthCheck(fn: () => Promise<HealthCheckResult> | HealthCheckResult): void {
    this.healthCheckFn = fn;
  }

  // ==========================================================================
  // UI RESOURCE REGISTRATION
  // ==========================================================================

  /**
   * Register a UI resource — a declarative renderable component.
   *
   * The first argument is the resource type ('tree', 'detail', 'form'),
   * making it immediately obvious what the resource renders:
   *
   *   server.ui('tree', { name: 'repo-tree', description: '...', handler: ... })
   *   server.ui('detail', { name: 'issue-detail', description: '...', handler: ... })
   *   server.ui('form', { name: 'create-issue', description: '...', handler: ... })
   *
   * The host discovers resources via `list_ui_resources` and fetches
   * renderable data via `get_ui_resource`. The handler runs on the app
   * side and returns structured data the host interprets with its own
   * theme and components.
   *
   * @param resourceType - 'tree', 'detail', or 'form'
   * @param config - resource configuration (name, description, handler, etc.)
   */
  ui<TParams = Record<string, unknown>, TData extends UiResourceData = UiResourceData>(
    resourceType: UiResourceType,
    config: UiResourceConfig<TParams, TData>,
  ): void {
    this.uiResources.set(config.name, {
      name: config.name,
      resourceType,
      description: config.description,
      parameters: config.parameters,
      boundTools: config.boundTools,
      refreshOnEvents: config.refreshOnEvents,
      handler: config.handler as UiResourceHandler,
    });
  }

  /**
   * Get all registered UI resource definitions (static metadata only).
   * Used by the HTTP/stdio server to respond to `list_ui_resources`.
   */
  getUiResourceDefinitions(): Array<Omit<RegisteredUiResource, 'handler'>> {
    return Array.from(this.uiResources.values()).map(({ handler, ...rest }) => rest);
  }

  /**
   * Get a registered UI resource by name (including handler).
   * Used by the HTTP/stdio server to handle `get_ui_resource` requests.
   */
  getUiResource(name: string): RegisteredUiResource | undefined {
    return this.uiResources.get(name);
  }

  /**
   * Alias for `ui()` — registers a UI resource using the `renderer()` name.
   *
   * Some developers prefer `server.renderer()` for readability:
   *
   *   server.renderer('tree', { name: 'repo-tree', ... })
   *
   * This is semantically identical to `server.ui('tree', { ... })`.
   * The `renderer` name emphasises that the resource produces rendered
   * output when a bound tool returns.
   *
   * @param resourceType - 'tree', 'detail', or 'form'
   * @param config - resource configuration (name, description, handler, etc.)
   */
  renderer<TParams = Record<string, unknown>, TData extends UiResourceData = UiResourceData>(
    resourceType: UiResourceType,
    config: UiResourceConfig<TParams, TData>,
  ): void {
    this.ui(resourceType, config);
  }

  // ==========================================================================
  // RENDERER DISPATCH
  // ==========================================================================

  /**
   * Find all UI resources bound to a given tool name.
   *
   * A resource is "bound" to a tool when the tool's name appears in the
   * resource's `boundTools` array. Multiple resources can be bound to the
   * same tool (e.g. a tree view and a detail panel for the same data).
   *
   * @param toolName - the name of the tool that just returned
   * @returns array of matching registered UI resources (may be empty)
   */
  findUiResourcesForTool(toolName: string): RegisteredUiResource[] {
    return Array.from(this.uiResources.values()).filter(
      (res) => res.boundTools?.includes(toolName),
    );
  }

  /**
   * Dispatch the renderer for a tool result.
   *
   * After a tool handler returns, the dispatch logic:
   * 1. Finds all UI resources bound to the tool via `boundTools`.
   * 2. For each bound resource, calls the resource handler with the tool
   *    result as the `params` argument (so the handler can transform the
   *    raw tool output into structured `UiResourceData`).
   * 3. Renders the `UiResourceData` into the requested format.
   * 4. Returns the first successful `RenderedOutput` (or undefined if no
   *    bound resources exist or all handlers fail).
   *
   * Errors in the resource handler are caught and logged — they never
   * affect the tool result itself. The tool already succeeded; rendering
   * is a best-effort enhancement.
   *
   * @param toolName - the name of the tool that just returned
   * @param toolResult - the raw result from the tool handler
   * @param context - the tool context (for secrets, etc.)
   * @param format - the output format (default: 'markdown')
   * @returns the rendered output, or undefined if no bound resources
   */
  async dispatchRenderer(
    toolName: string,
    toolResult: unknown,
    context: ToolContext,
    format: RenderFormat = 'markdown',
  ): Promise<RenderedOutput | undefined> {
    const resources = this.findUiResourcesForTool(toolName);
    if (resources.length === 0) return undefined;

    for (const resource of resources) {
      try {
        const data = await resource.handler(toolResult as Record<string, unknown>, context);
        return renderToOutput(data, resource.name, format);
      } catch (error) {
        console.error(
          `[McaServer:${this.config.id}] Renderer '${resource.name}' failed for tool '${toolName}':`,
          error instanceof Error ? error.message : String(error),
        );
        // Continue to next bound resource — rendering is best-effort
      }
    }

    return undefined;
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
      `[McaServer:${this.config.id}] Started with ${this.tools.size} tools, ${this.uiResources.size} UI resources (${this.activeTransport})`,
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
        annotations: tool.annotations,
      });
    }

    // Set health check if configured
    if (this.healthCheckFn) {
      this.httpServer.setHealthCheck(this.healthCheckFn);
    }

    // Wire renderer dispatch if any UI resources are registered
    if (this.uiResources.size > 0) {
      this.httpServer.setRendererDispatch(async (toolName, toolResult, ctx) => {
        return this.dispatchRenderer(toolName, toolResult, ctx as unknown as ToolContext);
      });
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
        annotations: tool.annotations,
      });
    }

    // Wire renderer dispatch if any UI resources are registered
    if (this.uiResources.size > 0) {
      this.stdioServer.setRendererDispatch(async (toolName, toolResult, ctx) => {
        return this.dispatchRenderer(toolName, toolResult, ctx as unknown as ToolContext);
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
