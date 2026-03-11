#!/usr/bin/env bun

/**
 * MCA Dev CLI
 *
 * Debug and test MCAs locally with a mock backend.
 *
 * Usage:
 *   bun scripts/mca-dev/index.ts run <mcaId> [options]
 *
 * Options:
 *   --app-id <id>       App ID to simulate (default: test_app_001)
 *   --user-id <id>      User ID to simulate (default: test_user_001)
 *   --call <tool>       Tool to call after startup
 *   --args <json>       Arguments for the tool call (JSON string)
 *   --secrets <json>    User secrets to inject (JSON string)
 *   --secrets-file <f>  Load secrets from JSON file
 *   --timeout <ms>      Startup timeout in ms (default: 10000)
 *   --verbose           Show all MCA stderr output
 *   --json              Output results as JSON (for agent consumption)
 *
 * Examples:
 *   # Just start and check if MCA is healthy
 *   bun scripts/mca-dev/index.ts run mca.figma --json
 *
 *   # Start with secrets and call a tool
 *   bun scripts/mca-dev/index.ts run mca.figma \
 *     --secrets '{"PERSONAL_ACCESS_TOKEN": "figd_xxx"}' \
 *     --call figma_get-file \
 *     --args '{"fileKey": "abc123"}' \
 *     --json
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { type ChildProcess, spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { parseArgs } from 'util';
import { type WebSocket, WebSocketServer } from 'ws';

// =============================================================================
// TYPES
// =============================================================================

interface RunOptions {
  mcaId: string;
  appId: string;
  userId: string;
  call?: string;
  args?: Record<string, any>;
  secrets: Record<string, string>;
  timeout: number;
  verbose: boolean;
  json: boolean;
}

interface RunResult {
  startup: {
    success: boolean;
    websocket: 'connected' | 'failed' | 'not_used';
    secrets_requested: string[];
    secrets_sent: string[];
    tools_loaded: number;
    tools: string[];
    ready: boolean;
    error?: string;
    duration_ms: number;
  };
  call?: {
    tool: string;
    args: Record<string, any>;
    success: boolean;
    response?: any;
    error?: string;
    duration_ms: number;
  };
  health?: {
    status: string;
    issues?: any[];
  };
  logs: string[];
}

// =============================================================================
// LOGGER
// =============================================================================

class Logger {
  private logs: string[] = [];
  private startTime = Date.now();
  private verbose: boolean;
  private jsonMode: boolean;

  constructor(verbose: boolean, jsonMode: boolean) {
    this.verbose = verbose;
    this.jsonMode = jsonMode;
  }

  log(message: string) {
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(3);
    const line = `[${elapsed}s] ${message}`;
    this.logs.push(line);
    if (!this.jsonMode) {
      console.error(line);
    }
  }

  stderr(data: string) {
    const lines = data.trim().split('\n');
    for (const line of lines) {
      const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(3);
      const logLine = `[${elapsed}s] [MCA] ${line}`;
      this.logs.push(logLine);
      if (this.verbose && !this.jsonMode) {
        console.error(logLine);
      }
    }
  }

  getLogs(): string[] {
    return this.logs;
  }
}

// =============================================================================
// MOCK WEBSOCKET SERVER
// =============================================================================

class MockBackendServer {
  private wss: WebSocketServer | null = null;
  private client: WebSocket | null = null;
  private port: number = 0;
  private logger: Logger;
  private secrets: Record<string, string>;
  private secretsRequested: string[] = [];
  private secretsSent: string[] = [];
  private connected = false;

  constructor(logger: Logger, secrets: Record<string, string>) {
    this.logger = logger;
    this.secrets = secrets;
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ port: 0 });

      this.wss.on('listening', () => {
        const addr = this.wss!.address();
        this.port = typeof addr === 'object' ? addr.port : 0;
        this.logger.log(`🔌 Mock WebSocket server on port ${this.port}`);
        resolve(this.port);
      });

      this.wss.on('error', (err) => {
        this.logger.log(`❌ WebSocket server error: ${err.message}`);
        reject(err);
      });

      this.wss.on('connection', (ws) => {
        this.client = ws;
        this.connected = true;
        this.logger.log(`✅ MCA connected to mock backend`);

        // Send connection ack
        ws.send(
          JSON.stringify({
            type: 'connection_ack',
            serverTime: Date.now(),
          }),
        );

        ws.on('message', (data) => {
          this.handleMessage(data.toString());
        });

        ws.on('close', () => {
          this.connected = false;
          this.logger.log(`🔌 MCA disconnected from mock backend`);
        });
      });
    });
  }

  private handleMessage(data: string) {
    try {
      const message = JSON.parse(data);
      this.logger.log(`📥 MCA → Backend: ${message.type}`);

      switch (message.type) {
        case 'pong':
          // Ignore pongs
          break;

        case 'get_system_secrets':
          this.secretsRequested.push('system');
          this.logger.log(`📤 Backend → MCA: system_secrets (empty)`);
          this.client?.send(
            JSON.stringify({
              type: 'system_secrets',
              requestId: message.requestId,
              secrets: {},
            }),
          );
          break;

        case 'get_user_secrets':
          this.secretsRequested.push('user');
          this.secretsSent = Object.keys(this.secrets);
          this.logger.log(
            `📤 Backend → MCA: user_secrets (${this.secretsSent.join(', ') || 'empty'})`,
          );
          this.client?.send(
            JSON.stringify({
              type: 'user_secrets',
              requestId: message.requestId,
              secrets: Object.keys(this.secrets).length > 0 ? this.secrets : null,
            }),
          );
          break;

        case 'health_update':
          this.logger.log(`💚 MCA health: ${message.status}`);
          break;

        case 'error':
          this.logger.log(`❌ MCA error: ${message.code} - ${message.message}`);
          break;

        default:
          this.logger.log(`❓ Unknown message type: ${message.type}`);
      }
    } catch (err) {
      this.logger.log(`❌ Failed to parse message: ${err}`);
    }
  }

  getSecretsRequested(): string[] {
    return this.secretsRequested;
  }

  getSecretsSent(): string[] {
    return this.secretsSent;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async stop() {
    this.client?.close();
    this.wss?.close();
  }
}

// =============================================================================
// MCA RUNNER
// =============================================================================

async function runMca(options: RunOptions): Promise<RunResult> {
  const logger = new Logger(options.verbose, options.json);
  const result: RunResult = {
    startup: {
      success: false,
      websocket: 'not_used',
      secrets_requested: [],
      secrets_sent: [],
      tools_loaded: 0,
      tools: [],
      ready: false,
      duration_ms: 0,
    },
    logs: [],
  };

  const startTime = Date.now();
  let mockServer: MockBackendServer | null = null;
  let mcpClient: Client | null = null;
  let transport: StdioClientTransport | null = null;

  try {
    // Find MCA directory
    const mcasDir = resolve(process.cwd(), 'mcas');
    const mcaDir = join(mcasDir, options.mcaId);

    if (!existsSync(mcaDir)) {
      throw new Error(`MCA directory not found: ${mcaDir}`);
    }

    // Load manifest
    const manifestPath = join(mcaDir, 'manifest.json');
    if (!existsSync(manifestPath)) {
      throw new Error(`manifest.json not found in ${mcaDir}`);
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

    logger.log(`🚀 Starting ${manifest.name} (${options.mcaId})`);
    logger.log(`   App ID: ${options.appId}`);
    logger.log(`   User ID: ${options.userId}`);
    logger.log(`   Entrypoint: ${manifest.entrypoint}`);

    // Start mock WebSocket server
    mockServer = new MockBackendServer(logger, options.secrets);
    const wsPort = await mockServer.start();

    // Build environment
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      MCA_APP_ID: options.appId,
      MCA_APP_NAME: manifest.name || options.mcaId,
      MCA_MCP_ID: options.mcaId,
      MCA_WS_ENABLED: 'true',
      MCA_WS_URL: `ws://localhost:${wsPort}/mca?appId=${options.appId}&token=mock_token`,
      MCA_BACKEND_URL: `http://localhost:${wsPort}`,
    };

    // Determine command and args
    const entrypoint = manifest.entrypoint || './mcp/index.ts';
    const command = 'bun';
    const args = ['run', entrypoint];

    logger.log(`   Command: ${command} ${args.join(' ')}`);

    // Create transport
    transport = new StdioClientTransport({
      command,
      args,
      cwd: mcaDir,
      env,
    });

    // Capture stderr
    transport.onerror = (err) => {
      logger.log(`❌ Transport error: ${err.message}`);
    };

    // Create MCP client
    mcpClient = new Client({ name: 'mca-dev', version: '1.0.0' }, { capabilities: {} });

    // Connect with timeout
    logger.log(`⏳ Connecting to MCA...`);

    const connectPromise = mcpClient.connect(transport);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`Connection timeout (${options.timeout}ms)`)),
        options.timeout,
      ),
    );

    await Promise.race([connectPromise, timeoutPromise]);

    // Give WebSocket time to connect and exchange secrets
    await new Promise((r) => setTimeout(r, 500));

    logger.log(`✅ MCP connection established`);

    // Get tools
    const toolsResponse = await mcpClient.listTools();
    const tools = toolsResponse.tools.map((t) => t.name);

    result.startup.success = true;
    result.startup.tools_loaded = tools.length;
    result.startup.tools = tools;
    result.startup.websocket = mockServer.isConnected() ? 'connected' : 'failed';
    result.startup.secrets_requested = mockServer.getSecretsRequested();
    result.startup.secrets_sent = mockServer.getSecretsSent();
    result.startup.duration_ms = Date.now() - startTime;

    logger.log(`📋 Tools loaded: ${tools.length}`);
    if (options.verbose) {
      tools.forEach((t) => logger.log(`   - ${t}`));
    }

    // Check health if available
    if (tools.includes('_health_check')) {
      logger.log(`💚 Running health check...`);
      try {
        const healthResult = await mcpClient.callTool({
          name: '_health_check',
          arguments: {},
        });
        const healthText = (healthResult.content as any)[0]?.text;
        if (healthText) {
          const health = JSON.parse(healthText);
          result.health = {
            status: health.status,
            issues: health.issues,
          };
          result.startup.ready = health.status === 'ready';
          logger.log(`   Status: ${health.status}`);
          if (health.issues?.length) {
            health.issues.forEach((issue: any) => {
              logger.log(`   ⚠️ ${issue.code}: ${issue.message}`);
            });
          }
        }
      } catch (err: any) {
        logger.log(`   ❌ Health check failed: ${err.message}`);
      }
    } else {
      result.startup.ready = true;
      logger.log(`   ℹ️ No _health_check tool, assuming ready`);
    }

    // Execute tool call if requested
    if (options.call) {
      logger.log(`\n🔧 Calling tool: ${options.call}`);
      logger.log(`   Args: ${JSON.stringify(options.args || {})}`);

      const callStart = Date.now();
      result.call = {
        tool: options.call,
        args: options.args || {},
        success: false,
        duration_ms: 0,
      };

      try {
        const callResult = await mcpClient.callTool({
          name: options.call,
          arguments: options.args || {},
        });

        result.call.success = !(callResult as any).isError;
        result.call.duration_ms = Date.now() - callStart;

        // Parse response
        const content = (callResult.content as any)[0];
        if (content?.text) {
          try {
            result.call.response = JSON.parse(content.text);
          } catch {
            result.call.response = content.text;
          }
        } else {
          result.call.response = callResult.content;
        }

        if (result.call.success) {
          logger.log(`✅ Tool call succeeded (${result.call.duration_ms}ms)`);
        } else {
          logger.log(`❌ Tool call returned error`);
          result.call.error = result.call.response?.error || 'Unknown error';
        }
      } catch (err: any) {
        result.call.success = false;
        result.call.error = err.message;
        result.call.duration_ms = Date.now() - callStart;
        logger.log(`❌ Tool call failed: ${err.message}`);
      }
    }
  } catch (err: any) {
    result.startup.success = false;
    result.startup.error = err.message;
    result.startup.duration_ms = Date.now() - startTime;
    logger.log(`❌ Startup failed: ${err.message}`);
  } finally {
    // Cleanup
    try {
      await mcpClient?.close();
    } catch {}
    try {
      await mockServer?.stop();
    } catch {}

    result.logs = logger.getLogs();
  }

  return result;
}

// =============================================================================
// CLI
// =============================================================================

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'app-id': { type: 'string', default: 'test_app_001' },
      'user-id': { type: 'string', default: 'test_user_001' },
      call: { type: 'string' },
      args: { type: 'string' },
      secrets: { type: 'string' },
      'secrets-file': { type: 'string' },
      timeout: { type: 'string', default: '10000' },
      verbose: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length < 2) {
    console.log(`
MCA Dev CLI - Debug and test MCAs locally

Usage:
  bun scripts/mca-dev/index.ts run <mcaId> [options]

Options:
  --app-id <id>       App ID to simulate (default: test_app_001)
  --user-id <id>      User ID to simulate (default: test_user_001)
  --call <tool>       Tool to call after startup
  --args <json>       Arguments for the tool call (JSON string)
  --secrets <json>    User secrets to inject (JSON string)
  --secrets-file <f>  Load secrets from JSON file
  --timeout <ms>      Startup timeout in ms (default: 10000)
  --verbose           Show all MCA stderr output
  --json              Output results as JSON (for agent consumption)
  --help, -h          Show this help

Examples:
  # Check if MCA starts correctly
  bun scripts/mca-dev/index.ts run mca.figma --json

  # Test with secrets
  bun scripts/mca-dev/index.ts run mca.figma \\
    --secrets '{"PERSONAL_ACCESS_TOKEN": "figd_xxx"}' \\
    --json

  # Call a tool
  bun scripts/mca-dev/index.ts run mca.figma \\
    --secrets '{"PERSONAL_ACCESS_TOKEN": "figd_xxx"}' \\
    --call figma_get-file \\
    --args '{"fileKey": "abc123"}' \\
    --json
`);
    process.exit(0);
  }

  const command = positionals[0];
  const mcaId = positionals[1];

  if (command !== 'run') {
    console.error(`Unknown command: ${command}`);
    process.exit(1);
  }

  // Parse secrets
  let secrets: Record<string, string> = {};
  if (values['secrets-file']) {
    const secretsPath = resolve(values['secrets-file']);
    if (existsSync(secretsPath)) {
      secrets = JSON.parse(readFileSync(secretsPath, 'utf-8'));
    }
  }
  if (values.secrets) {
    secrets = { ...secrets, ...JSON.parse(values.secrets) };
  }

  // Parse args
  let callArgs: Record<string, any> | undefined;
  if (values.args) {
    callArgs = JSON.parse(values.args);
  }

  const options: RunOptions = {
    mcaId,
    appId: values['app-id']!,
    userId: values['user-id']!,
    call: values.call,
    args: callArgs,
    secrets,
    timeout: parseInt(values.timeout!, 10),
    verbose: values.verbose!,
    json: values.json!,
  };

  const result = await runMca(options);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('\n--- Summary ---');
    console.log(
      `Startup: ${result.startup.success ? '✅' : '❌'} (${result.startup.duration_ms}ms)`,
    );
    console.log(`Tools: ${result.startup.tools_loaded}`);
    console.log(`WebSocket: ${result.startup.websocket}`);
    console.log(`Ready: ${result.startup.ready ? '✅' : '❌'}`);
    if (result.call) {
      console.log(`Tool call: ${result.call.success ? '✅' : '❌'} (${result.call.duration_ms}ms)`);
    }
  }

  process.exit(result.startup.success ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
