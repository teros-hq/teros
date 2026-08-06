/**
 * Stdio Server for MCAs
 *
 * Provides a stdio interface (MCP protocol) for MCAs.
 * Used for tool discovery during sync and for MCAs that run in stdio mode.
 *
 *
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { McaExecutionContext } from '@teros/shared';
import { McaBackendClient } from './backend-client';

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
  /** MCP spec hint — tool only reads, never mutates state. Clients MAY auto-approve. */
  readOnlyHint?: boolean;
  /** MCP spec hint — tool may modify or delete state irreversibly. Clients SHOULD confirm. */
  destructiveHint?: boolean;
  /** MCP spec hint — repeating the call with the same args has no extra effect. */
  idempotentHint?: boolean;
  /** MCP spec hint — tool reaches outside the local environment (network, external services). */
  openWorldHint?: boolean;
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

// ============================================================================
// BUILD CONTEXT METHODS
// ============================================================================

function buildContextMethods(
  backendClient: McaBackendClient | null,
): Pick<ToolContext, 'getSystemSecrets' | 'getUserSecrets'> {
  const requireClient = () => {
    if (!backendClient) {
      throw new Error('Cannot access secrets: no callbackUrl configured');
    }
    return backendClient;
  };

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
  };
}

// ============================================================================
// STDIO MCA SERVER
// ============================================================================

export class McaStdioServer {
  private config: McaStdioServerConfig;
  private tools = new Map<string, RegisteredTool>();
  private mcpServer: Server | null = null;

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

      try {
        const result = await tool.handler(args || {}, context);

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
