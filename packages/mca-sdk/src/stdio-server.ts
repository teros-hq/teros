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

  // Secrets
  getSystemSecrets: () => Promise<Record<string, string>>;
  getUserSecrets: () => Promise<Record<string, string>>;
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

export interface ToolConfig {
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: ToolHandler;
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
          })
        : null;

      const context: ToolContext = {
        execution,
        requestId: execution.requestId!,
        backend: backendClient,
        ...buildContextMethods(backendClient),
      };

      try {
        const result = await tool.handler(args || {}, context);

        // Format result as text
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);

        return {
          content: [{ type: 'text', text }],
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
