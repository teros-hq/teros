/**
 * Stdio Server for MCAs
 *
 * Provides a stdio interface (MCP protocol) for MCAs.
 * Used for tool discovery during sync and for MCAs that run in stdio mode.
 *
 * @see docs/RFC-001-mca-protocol.md
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { McaExecutionContext } from '@teros/shared';
import { McaBackendClient } from './backend-client';
import type { VolumeStorage, ShareAccess, VolumeEntry, VolumeStat, ShareResult, DocumentStorage, ObjectStorage } from './types';

// ============================================================================
// TYPES
// ============================================================================

export type ToolHandler = (
  args: Record<string, unknown>,
  context: ToolContext,
) => Promise<unknown> | unknown;

export interface ToolContext {
  /** Execution context */
  execution: McaExecutionContext;
  /** Request ID */
  requestId: string;
  /** Backend client for MCA → Backend calls (null if no callbackUrl) */
  backend: McaBackendClient | null;
  /**
   * AbortSignal — currently a never-aborts stub for stdio transport.
   * Real cancellation via MCP `notifications/cancelled` is roadmapped for
   * Phase 2.6. Handlers can safely check this signal; it will simply never
   * fire today. Documenting via the same shape as HTTP transport so MCAs
   * have a uniform `ToolContext.signal` contract across transports.
   */
  signal: AbortSignal;

  // Secrets
  getSystemSecrets: () => Promise<Record<string, string>>;
  getUserSecrets: () => Promise<Record<string, string>>;

  // Volume storage — unified file-system API
  volume: VolumeStorage;
  // Share access — create and revoke public URLs
  share: ShareAccess;
  // Document storage — MongoDB-backed key-document store scoped per installation
  storage: DocumentStorage;
  // Object storage — filesystem-backed binary store scoped per installation
  objects: ObjectStorage;
}

/**
 * Optional metadata attached to a tool. Mirrors the shape in http-server.ts
 * and server.ts so MCAs can use the same annotations object across transports.
 */
export interface ToolAnnotations {
  version?: string;
  stability?: 'experimental' | 'stable' | 'deprecated';
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

export interface RegisteredTool {
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

export interface ToolConfig {
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: ToolHandler;
  /** Optional metadata for versioning and stability signals. */
  annotations?: ToolAnnotations;
}

export interface McaStdioServerConfig {
  /** MCA ID (e.g., 'mca.teros.bash') */
  id: string;
  /** Display name */
  name: string;
  /** Version string */
  version: string;
}

/**
 * Callback the transport calls after a tool succeeds.
 * If it returns a rendered output object, the transport includes it
 * alongside the tool result content.
 *
 * Set by `McaServer` via `setRendererDispatch()` when UI resources
 * are registered.
 */
export type RendererDispatchFn = (
  toolName: string,
  toolResult: unknown,
  context: ToolContext,
) => Promise<{ format: string; content: string; resource: string; resourceType: string } | undefined>;

// ============================================================================
// BUILD CONTEXT METHODS
// ============================================================================

function buildContextMethods(
  backendClient: McaBackendClient | null,
): Pick<ToolContext, 'getSystemSecrets' | 'getUserSecrets' | 'volume' | 'share' | 'storage' | 'objects'> {
  const requireClient = () => {
    if (!backendClient) {
      throw new Error('Cannot access resources: no callbackUrl configured');
    }
    return backendClient;
  };

  // Workspace scope for volume/share calls
  const workspaceId = process.env.MCA_WORKSPACE_ID || process.env.MCA_USER_ID || 'unknown';
  const sessionId = process.env.MCA_REQUEST_ID || process.env.MCA_USER_ID || 'unknown';

  return {
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

    // Volume Storage
    volume: {
      list: async (path: string): Promise<VolumeEntry[]> => {
        const res = await requireClient().volumeList(path, workspaceId);
        return res.entries;
      },
      read: async (path: string): Promise<string | null> => {
        const res = await requireClient().volumeRead(path, workspaceId);
        return res.data;
      },
      write: async (path: string, data: string): Promise<void> => {
        await requireClient().volumeWrite(path, data, workspaceId);
      },
      delete: async (path: string, options?: { recursive?: boolean }): Promise<void> => {
        await requireClient().volumeDelete(path, workspaceId, options?.recursive);
      },
      stat: async (path: string): Promise<VolumeStat | null> => {
        const res = await requireClient().volumeStat(path, workspaceId);
        return res.stat;
      },
      mkdir: async (path: string): Promise<void> => {
        await requireClient().volumeMkdir(path, workspaceId);
      },
      getTempPath: (filename: string): string => {
        return `/tmp/${sessionId}/${filename}`;
      },
    },

    // Share
    share: {
      share: async (path: string, options?: { mutable?: boolean; expiresIn?: number }): Promise<ShareResult> => {
        return requireClient().fileShare(path, workspaceId, options);
      },
      revoke: async (url: string): Promise<void> => {
        await requireClient().fileRevoke(url);
      },
    },

    // Document Storage — MongoDB-backed document store
    storage: {
      put: (collection: string, documentId: string, document: Record<string, unknown>) =>
        requireClient().storagePut(collection, documentId, document),
      get: (collection: string, documentId: string) =>
        requireClient().storageGet(collection, documentId),
      query: (collection: string, filter?: Record<string, unknown>, limit?: number) =>
        requireClient().storageQuery(collection, filter, limit),
      update: (collection: string, documentId: string, patch: Record<string, unknown>) =>
        requireClient().storageUpdate(collection, documentId, patch),
      delete: (collection: string, documentId: string) =>
        requireClient().storageDelete(collection, documentId),
    },

    // Object Storage — filesystem-backed blob store
    objects: {
      put: (data: Buffer, contentType: string, metadata?: Record<string, string>) =>
        requireClient().objectPut(data, contentType, metadata),
      get: (objectId: string) =>
        requireClient().objectGet(objectId),
      delete: (objectId: string) =>
        requireClient().objectDelete(objectId),
      list: () =>
        requireClient().objectList(),
    },
  };
}

// ============================================================================
// STDIO MCA SERVER
// ============================================================================

export class McaStdioServer {
  private config: McaStdioServerConfig;
  private tools = new Map<string, RegisteredTool>();
  private mcpServer: Server | null = null;
  private rendererDispatchFn: RendererDispatchFn | null = null;

  constructor(config: McaStdioServerConfig) {
    this.config = config;
  }

  /**
   * Register a tool
   */
  tool(name: string, toolConfig: ToolConfig): void {
    this.tools.set(name, {
      name,
      description: toolConfig.description,
      parameters: toolConfig.parameters,
      handler: toolConfig.handler,
      annotations: toolConfig.annotations,
    });
  }

  /**
   * Get all registered tools (for wrapper access)
   */
  getTools(): Map<string, RegisteredTool> {
    return this.tools;
  }

  /**
   * Get config (for wrapper access)
   */
  getConfig(): McaStdioServerConfig {
    return this.config;
  }

  /**
   * Set the renderer dispatch callback.
   *
   * Called by `McaServer` when UI resources are registered. After a tool
   * handler succeeds, the transport calls this callback with the tool
   * name and result. If it returns a rendered output, the transport
   * appends it as a text content block.
   */
  setRendererDispatch(fn: RendererDispatchFn): void {
    this.rendererDispatchFn = fn;
  }

  /**
   * Start the stdio server
   */
  async start(): Promise<void> {
    console.error(`[McaStdioServer:${this.config.id}] Starting...`);

    // Create MCP server
    this.mcpServer = new Server(
      {
        name: this.config.name,
        version: this.config.version,
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    // Register list_tools handler
    this.mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = Array.from(this.tools.values()).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: {
          type: 'object' as const,
          properties: tool.parameters.properties,
          required: tool.parameters.required,
        },
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      }));

      return { tools };
    });

    // Register call_tool handler
    this.mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      const tool = this.tools.get(name);
      if (!tool) {
        return {
          content: [{ type: 'text', text: `Error: Tool '${name}' not found` }],
          isError: true,
        };
      }

      // Build execution context from environment
      const execution: McaExecutionContext = {
        userId: process.env.MCA_USER_ID || 'unknown',
        appId: process.env.MCA_APP_ID || 'unknown',
        mcaId: this.config.id,
        channelId: process.env.MCA_CHANNEL_ID,
        agentId: process.env.MCA_AGENT_ID,
        requestId: `stdio-${Date.now()}`,
        callbackUrl: process.env.MCA_CALLBACK_URL,
      };

      const backendClient = execution.callbackUrl
        ? new McaBackendClient({
            callbackUrl: execution.callbackUrl,
            appId: execution.appId,
            mcaId: this.config.id,
            callbackToken: process.env.MCA_CALLBACK_TOKEN,
          })
        : null;

      // Never-aborts AbortSignal stub for stdio transport. Phase 2.6 wires
      // real cancellation via MCP notifications/cancelled.
      const neverAbortsController = new AbortController();

      const context: ToolContext = {
        execution,
        requestId: execution.requestId!,
        backend: backendClient,
        signal: neverAbortsController.signal,
        ...buildContextMethods(backendClient),
      };

      // MUW-F3: Per-execution credential override for personal apps (stdio path).
      //
      // The backend injects per-user credentials into tool arguments under
      // the `_teros_credentials` reserved key. Extract them here, strip from
      // the args so the tool handler never sees them, and override
      // `getUserSecrets()` to return them directly — no WS roundtrip, no
      // global state, no race between concurrent users on the same MCA.
      let handlerArgs = args || {};
      if (handlerArgs && typeof handlerArgs === 'object' && '_teros_credentials' in handlerArgs) {
        const injectedCredentials = (handlerArgs as Record<string, unknown>)._teros_credentials as Record<string, string>;
        // Strip the reserved key so the tool handler receives clean args
        const { _teros_credentials, ...cleanArgs } = handlerArgs as Record<string, unknown>;
        handlerArgs = cleanArgs;
        // Override getUserSecrets to return the injected credentials
        context.getUserSecrets = async () => injectedCredentials;
      }

      try {
        const result = await tool.handler(handlerArgs, context);

        // Build MCP content array
        const content: Array<{ type: string; [key: string]: any }> = [];

        if (result && typeof result === 'object' && 'attachments' in result && Array.isArray((result as any).attachments)) {
          // Handler returned { text, attachments } shape — serialize text + attachments
          const text = (result as any).text ?? JSON.stringify(result, null, 2);
          if (text) content.push({ type: 'text', text });
          for (const a of (result as any).attachments) {
            if (a?.url && a?.mime) {
              if (a.url.startsWith('data:')) {
                const base64 = a.url.split(',')[1];
                content.push({ type: 'image', data: base64, mimeType: a.mime });
              } else {
                content.push({ type: 'resource', resource: { uri: a.url, mimeType: a.mime, text: a.filename || '' } });
              }
            }
          }
        } else {
          // Legacy: plain string or object → single text block
          const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
          content.push({ type: 'text', text });
        }

        // ── Renderer dispatch ──────────────────────────────────────────
        //
        // After the tool succeeds, if a renderer dispatch callback is
        // registered (set by McaServer when UI resources exist), call it
        // with the tool name and result. If a bound UI resource exists,
        // the callback invokes its handler, renders the UiResourceData,
        // and appends the rendered output as an additional text block.
        //
        // Rendering is best-effort: errors never affect the tool result.
        if (this.rendererDispatchFn) {
          try {
            const rendered = await this.rendererDispatchFn(name, result, context);
            if (rendered) {
              content.push({ type: 'text', text: rendered.content });
            }
          } catch {
            // Renderer dispatch failed — continue without rendered output
          }
        }

        return {
          content,
          isError: false,
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[McaStdioServer:${this.config.id}] Tool '${name}' error:`, message);

        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          isError: true,
        };
      }
    });

    // Connect stdio transport
    const transport = new StdioServerTransport();
    await this.mcpServer.connect(transport);

    console.error(`[McaStdioServer:${this.config.id}] Started with ${this.tools.size} tools`);
  }

  /**
   * Stop the server
   */
  async stop(): Promise<void> {
    console.error(`[McaStdioServer:${this.config.id}] Stopping...`);
    if (this.mcpServer) {
      await this.mcpServer.close();
      this.mcpServer = null;
    }
  }
}
