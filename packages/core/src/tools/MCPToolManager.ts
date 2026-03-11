/**
 * MCP Tool Manager
 *
 * Manages connections to MCP servers and provides tool discovery.
 * Each MCP server runs as a separate process and communicates via stdio.
 *
 * Architecture:
 * - MCPToolManager: Manages all MCP server connections
 * - Each server runs as child process
 * - Communicates via stdio transport
 * - Discovers tools on startup
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { type ChildProcess, spawn } from 'child_process';
import type { ToolDefinition } from '../llm/ILLMClient';

/**
 * MCP Server Configuration
 */
export interface MCPServerConfig {
  type: 'local';
  command: string[];
  /** Working directory for the MCP process */
  cwd?: string;
  environment?: Record<string, string>;
  enabled: boolean;
}

/**
 * MCP Server Connection
 */
interface MCPServerConnection {
  name: string;
  config: MCPServerConfig;
  client: Client;
  transport: StdioClientTransport;
  process?: ChildProcess; // Optional - transport manages process internally
  tools: ToolDefinition[];
  toolNameMapping: Map<string, string>; // sanitized name -> original name
}

/**
 * MCP Tool Manager
 *
 * Manages lifecycle of MCP servers and tool discovery
 */
export class MCPToolManager {
  private servers = new Map<string, MCPServerConnection>();
  private allTools: ToolDefinition[] = [];

  /**
   * Initialize MCP servers from configuration
   */
  async initialize(config: Record<string, MCPServerConfig>): Promise<void> {
    console.log(`🔧 Initializing MCP Tool Manager...`);
    console.log(`📋 Found ${Object.keys(config).length} MCP servers in config`);

    for (const [name, serverConfig] of Object.entries(config)) {
      if (!serverConfig.enabled) {
        console.log(`⏭️  Skipping disabled server: ${name}`);
        continue;
      }

      try {
        await this.connectServer(name, serverConfig);
      } catch (error: any) {
        console.error(`❌ Failed to connect to MCP server '${name}':`, error.message);
        // Continue with other servers even if one fails
      }
    }

    console.log(`✅ MCP Tool Manager initialized`);
    console.log(`🔧 Total tools available: ${this.allTools.length}`);
  }

  /**
   * Connect to a single MCP server
   */
  private async connectServer(name: string, config: MCPServerConfig): Promise<void> {
    console.log(`🔌 Connecting to MCP server: ${name}`);
    console.log(`   Command: ${config.command.join(' ')}`);
    if (config.cwd) {
      console.log(`   Working dir: ${config.cwd}`);
    }

    const [command, ...args] = config.command;

    // Create stdio transport (it will spawn the process internally)
    const transport = new StdioClientTransport({
      command,
      args,
      env: config.environment,
      cwd: config.cwd,
    });

    // Create MCP client
    const client = new Client(
      {
        name: `teros-core-${name}`,
        version: '1.0.0',
      },
      {
        capabilities: {},
      },
    );

    // Connect
    await client.connect(transport);
    console.log(`✅ Connected to MCP server: ${name}`);

    // Discover tools
    const toolsResponse = await client.listTools();
    const toolNameMapping = new Map<string, string>();

    const tools: ToolDefinition[] = toolsResponse.tools.map((tool) => {
      const originalName = tool.name;
      // Replace all invalid characters with underscores for Anthropic compatibility
      // Anthropic only accepts: ^[a-zA-Z0-9_-]{1,128}$
      const sanitizedName = `${name}_${originalName}`.replace(/[^a-zA-Z0-9_-]/g, '_');

      // Store mapping for execution
      toolNameMapping.set(sanitizedName, originalName);

      return {
        name: sanitizedName,
        description: tool.description || '',
        input_schema: tool.inputSchema as any,
      };
    });

    console.log(`📦 Discovered ${tools.length} tools from ${name}:`);
    tools.forEach((tool) => console.log(`   - ${tool.name}`));

    // Store connection
    const connection: MCPServerConnection = {
      name,
      config,
      client,
      transport,
      tools,
      toolNameMapping,
    };

    this.servers.set(name, connection);
    this.allTools.push(...tools);
  }

  /**
   * Get all available tools from all MCP servers
   */
  getTools(): ToolDefinition[] {
    return this.allTools;
  }

  /**
   * Execute a tool call
   */
  async executeTool(
    toolName: string,
    input: Record<string, any>,
  ): Promise<{ output: string; isError: boolean }> {
    // Find which server owns this tool by checking prefixes
    // Tool names are formatted as: "serverName_originalToolName"
    let connection: MCPServerConnection | undefined;
    let serverName: string | undefined;

    for (const [name, conn] of this.servers.entries()) {
      if (toolName.startsWith(`${name}_`)) {
        connection = conn;
        serverName = name;
        break;
      }
    }

    if (!connection || !serverName) {
      throw new Error(`No MCP server found for tool: ${toolName}`);
    }

    // Get the original tool name from mapping (may contain dots, etc)
    const originalToolName = connection.toolNameMapping.get(toolName);
    if (!originalToolName) {
      throw new Error(`Tool mapping not found for: ${toolName}`);
    }

    console.log(`🔧 Executing tool: ${toolName} (original: ${originalToolName})`);
    console.log(`   Input:`, JSON.stringify(input));

    try {
      const result = await connection.client.callTool({
        name: originalToolName,
        arguments: input,
      });

      // MCP returns content array, extract text
      let output = '';
      const content = result.content as Array<{ type: string; text?: string }>;
      for (const item of content) {
        if (item.type === 'text' && item.text) {
          output += item.text;
        }
      }

      // Check if MCP returned isError flag
      const isError = result.isError === true;

      console.log(`✅ Tool executed: ${toolName} (isError: ${isError})`);
      return { output, isError };
    } catch (error: any) {
      console.error(`❌ Tool execution failed: ${toolName}`, error);
      throw new Error(`Tool execution failed: ${error.message}`);
    }
  }

  /**
   * Shutdown all MCP servers
   */
  async shutdown(): Promise<void> {
    console.log(`🛑 Shutting down MCP Tool Manager...`);

    for (const [name, connection] of this.servers.entries()) {
      try {
        await connection.client.close();
        if (connection.process) {
          connection.process.kill();
        }
        console.log(`✅ Shut down MCP server: ${name}`);
      } catch (error: any) {
        console.error(`⚠️  Error shutting down '${name}':`, error.message);
      }
    }

    this.servers.clear();
    this.allTools = [];
    console.log(`✅ MCP Tool Manager shut down`);
  }
}
