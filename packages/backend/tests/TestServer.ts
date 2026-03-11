/**
 * Test Server - Lightweight server for E2E tests
 *
 * Creates a fully functional server with mocked LLM for testing.
 * Requires a .env.test file in packages/backend/ — create it from the example:
 *
 *   cp packages/backend/.env.test.example packages/backend/.env.test
 *
 * Minimum required content:
 *   PORT=3099
 *   MONGODB_URI=mongodb://localhost:27018
 *   MONGODB_DATABASE=teros_test
 *   SESSION_TOKEN_SECRET=your-secret-here
 */

import { config as dotenvConfig } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// Get the directory of this file to find .env.test relative to it
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '..', '.env.test');

// Load test environment BEFORE any other imports that might use config
dotenvConfig({ path: envPath });

// Import from @teros/core - resolved via workspace
import {
  ConversationManager,
  createSimpleMockAdapter,
  type ILLMClient,
  MockLLMAdapter,
  type Recording,
  SessionLockManager,
  type ToolDefinition,
} from '@teros/core';
import { createServer, type Server } from 'http';
import { type Db, MongoClient } from 'mongodb';
import { WebSocket, WebSocketServer } from 'ws';
import { AuthHandler, type AuthResult } from '../src/handlers/auth-handler';
import { WebSocketHandler } from '../src/handlers/websocket-handler';
import { ChannelManager } from '../src/services/channel-manager';
import { SessionManager } from '../src/services/session-manager';
import { MongoSessionStore } from '../src/session/MongoSessionStore';

/**
 * Get required test environment variable
 */
function requireTestEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required test environment variable: ${name}\n` +
        `Make sure .env.test exists in packages/backend/`,
    );
  }
  return value;
}

/**
 * Mock Tool Executor for tests
 */
class MockToolExecutor {
  private tools: ToolDefinition[] = [
    {
      name: 'bash',
      description: 'Execute bash commands',
      input_schema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The bash command to execute' },
          description: { type: 'string', description: 'Description of what the command does' },
        },
        required: ['command'],
      },
    },
  ];

  getTools(): ToolDefinition[] {
    return this.tools;
  }

  async executeTool(
    toolName: string,
    input: Record<string, any>,
  ): Promise<{ output: string; isError: boolean }> {
    if (toolName === 'bash') {
      // Simulate bash command execution
      const command = input.command as string;
      if (command === 'uptime') {
        return {
          output: ' 10:30:45 up 5 days,  3:42,  2 users,  load average: 0.15, 0.10, 0.08',
          isError: false,
        };
      }
      if (command.includes('ls')) {
        return {
          output: 'file1.txt\nfile2.txt\nfolder1',
          isError: false,
        };
      }
      if (command.includes('df')) {
        return {
          output: 'Filesystem     Size  Used Avail Use%\n/dev/sda1       50G   20G   30G  40%',
          isError: false,
        };
      }
      return {
        output: `Mock output for: ${command}`,
        isError: false,
      };
    }

    return {
      output: `Unknown tool: ${toolName}`,
      isError: true,
    };
  }

  hasTool(toolName: string): boolean {
    return this.tools.some((t) => t.name === toolName);
  }

  getTool(toolName: string): ToolDefinition | undefined {
    return this.tools.find((t) => t.name === toolName);
  }
}

export interface TestServerOptions {
  port?: number;
  mongoUri?: string;
  llmAdapter?: ILLMClient;
  /** Simple mock responses (alternative to llmAdapter) */
  mockResponses?: { text?: string; toolCalls?: any[] }[];
  /** Recording to replay */
  recording?: Recording | string;
  /** Enable mock tools (default: true) */
  enableMockTools?: boolean;
}

/**
 * Mock Auth Handler that accepts any credentials for testing
 */
class MockAuthHandler extends AuthHandler {
  async authenticate(message: any): Promise<AuthResult> {
    // Accept any credentials in test mode (with basic validation)
    if (message.method === 'credentials') {
      // Validate email format
      const email = message.email;
      if (!email || !email.includes('@')) {
        return { success: false, error: 'Invalid credentials' };
      }

      const userId = `user_test_${email.split('@')[0]}` as any;
      return {
        success: true,
        userId,
        sessionToken: `token_${userId}`,
      };
    }

    // Token auth
    if (message.method === 'token' && message.sessionToken) {
      const userId = message.sessionToken.replace('token_', '') as any;
      return {
        success: true,
        userId,
        sessionToken: message.sessionToken,
      };
    }

    return { success: false, error: 'Invalid auth method' };
  }
}

export interface TestServerInstance {
  port: number;
  httpServer: Server;
  wss: WebSocketServer;
  db: Db;
  sessionManager: SessionManager;
  channelManager: ChannelManager;
  conversationManager: ConversationManager;

  /** Create a WebSocket client connected to the server */
  createClient(): Promise<TestWebSocketClient>;

  /** Close the server */
  close(): Promise<void>;

  /** Seed test data */
  seedAgents(): Promise<void>;
}

/**
 * WebSocket client wrapper for testing
 */
export class TestWebSocketClient {
  private ws: WebSocket;
  private messageQueue: any[] = [];
  private waitingResolvers: Array<{
    resolve: (msg: any) => void;
    filter?: (msg: any) => boolean;
    timeout: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(ws: WebSocket) {
    this.ws = ws;

    ws.on('message', (data) => {
      const message = JSON.parse(data.toString());

      // DEBUG: Disabled for cleaner output
      // if (message.type === 'typing') {
      //   console.log('📥 Client received typing:', message.isTyping)
      // }

      // Check if any waiter is interested in this message
      const matchIndex = this.waitingResolvers.findIndex((w) => !w.filter || w.filter(message));

      if (matchIndex >= 0) {
        const waiter = this.waitingResolvers.splice(matchIndex, 1)[0];
        clearTimeout(waiter.timeout);
        waiter.resolve(message);
      } else {
        this.messageQueue.push(message);
      }
    });
  }

  /**
   * Send a message to the server
   */
  send(message: any): void {
    this.ws.send(JSON.stringify(message));
  }

  /**
   * Wait for a specific message type
   */
  waitFor<T = any>(filter?: string | ((msg: any) => boolean), timeoutMs = 5000): Promise<T> {
    return new Promise((resolve, reject) => {
      const filterFn = typeof filter === 'string' ? (msg: any) => msg.type === filter : filter;

      // Check queue first
      const queueIndex = this.messageQueue.findIndex((msg) => !filterFn || filterFn(msg));

      if (queueIndex >= 0) {
        resolve(this.messageQueue.splice(queueIndex, 1)[0]);
        return;
      }

      // Wait for message
      const timeout = setTimeout(() => {
        const index = this.waitingResolvers.findIndex((w) => w.resolve === resolve);
        if (index >= 0) {
          this.waitingResolvers.splice(index, 1);
        }
        reject(new Error(`Timeout waiting for message: ${filter}`));
      }, timeoutMs);

      this.waitingResolvers.push({ resolve, filter: filterFn, timeout });
    });
  }

  /**
   * Authenticate with the server
   */
  async authenticate(
    email = 'test@example.com',
    password = 'password',
  ): Promise<{ userId: string; sessionToken: string }> {
    this.send({
      type: 'auth',
      method: 'credentials',
      email,
      password,
    });

    const response = await this.waitFor<any>(
      (msg) => msg.type === 'auth_success' || msg.type === 'auth_error',
    );

    if (response.type === 'auth_error') {
      throw new Error(`Auth failed: ${response.error}`);
    }

    return {
      userId: response.userId,
      sessionToken: response.sessionToken,
    };
  }

  /**
   * Close the connection
   */
  close(): void {
    this.ws.close();
  }

  /**
   * Get the raw WebSocket
   */
  getRawSocket(): WebSocket {
    return this.ws;
  }

  /**
   * Get all queued messages (for debugging)
   */
  getQueuedMessages(): any[] {
    return [...this.messageQueue];
  }

  /**
   * Clear message queue
   */
  clearQueue(): void {
    this.messageQueue = [];
  }
}

/**
 * Create a test server with mocked dependencies
 */
export async function createTestServer(
  options: TestServerOptions = {},
): Promise<TestServerInstance> {
  const port = options.port || 0; // 0 = random available port

  // Connect to MongoDB using environment variables (no defaults)
  const mongoUri = options.mongoUri || requireTestEnv('MONGODB_URI');
  const mongoClient = new MongoClient(mongoUri);
  await mongoClient.connect();

  // Use unique DB name for test isolation (based on configured test database)
  const baseDbName = requireTestEnv('MONGODB_DATABASE');
  const dbName = `${baseDbName}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const db = mongoClient.db(dbName);

  // Initialize services
  const sessionManager = new SessionManager();
  const channelManager = new ChannelManager(db);

  // Create LLM adapter based on options
  let llmAdapter: ILLMClient;

  if (options.llmAdapter) {
    llmAdapter = options.llmAdapter;
  } else if (options.recording) {
    llmAdapter = new MockLLMAdapter(options.recording);
  } else if (options.mockResponses) {
    llmAdapter = createSimpleMockAdapter(options.mockResponses);
  } else {
    // Default: simple echo response
    llmAdapter = createSimpleMockAdapter([
      { text: 'This is a mock response from the test server.' },
    ]);
  }

  // Create conversation manager with mock LLM
  const sessionStore = new MongoSessionStore(db);
  const lockManager = new SessionLockManager();
  const conversationManager = new ConversationManager(sessionStore, lockManager, llmAdapter);

  // Create HTTP and WebSocket servers
  const httpServer = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  // Create mock auth handler for tests
  const mockAuthHandler = new MockAuthHandler(sessionManager);

  // Create mock tool executor if enabled (default: true)
  const enableMockTools = options.enableMockTools !== false;
  const mockToolExecutor = enableMockTools ? new MockToolExecutor() : undefined;

  // Initialize WebSocket handler with mock auth and mock LLM client
  // Constructor: (wss, sessionManager, channelManager, db, sessionStore?, options?)
  new WebSocketHandler(wss, sessionManager, channelManager, db, sessionStore, {
    authHandler: mockAuthHandler,
    llmClient: llmAdapter,
    toolExecutor: mockToolExecutor,
  });

  // Start server
  await new Promise<void>((resolve) => {
    httpServer.listen(port, () => resolve());
  });

  const actualPort = (httpServer.address() as any).port;

  return {
    port: actualPort,
    httpServer,
    wss,
    db,
    sessionManager,
    channelManager,
    conversationManager,

    async createClient(): Promise<TestWebSocketClient> {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://localhost:${actualPort}/ws`);

        ws.on('open', () => {
          resolve(new TestWebSocketClient(ws));
        });

        ws.on('error', (err) => {
          reject(err);
        });
      });
    },

    async close(): Promise<void> {
      // Close all WebSocket connections
      wss.clients.forEach((client) => client.close());

      // Close servers with timeout to prevent hanging
      await Promise.race([
        new Promise<void>((resolve) => {
          wss.close(() => {
            httpServer.closeAllConnections?.(); // Force close all connections (Node 18.2+)
            httpServer.close(() => resolve());
          });
        }),
        new Promise<void>((resolve) =>
          setTimeout(() => {
            // Force close after 1 second
            httpServer.closeAllConnections?.();
            resolve();
          }, 1000),
        ),
      ]);

      // Drop test database and close connection
      await db.dropDatabase();
      await mongoClient.close();
    },

    async seedAgents(): Promise<void> {
      // Create cores first
      const cores = [
        {
          coreId: 'core:test',
          coreVersion: '1.0.0',
          modelId: 'model:claude-sonnet',
          baseSystemPrompt: 'You are a helpful AI assistant for testing.',
          config: {
            temperature: 0.7,
            maxTokens: 4096,
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ];

      // Create models
      const models = [
        {
          modelId: 'model:claude-sonnet',
          provider: 'anthropic',
          name: 'Claude 3.5 Sonnet',
          description: 'Test model',
          modelString: 'claude-3-5-sonnet-20241022',
          capabilities: {
            streaming: true,
            tools: true,
            vision: false,
            thinking: true,
          },
          context: {
            maxTokens: 200000,
            maxOutputTokens: 8192,
          },
          defaults: {
            temperature: 0.7,
            maxTokens: 4096,
          },
          reservations: {
            systemPrompt: 2000,
            memory: 1000,
            tools: 1000,
          },
          pricing: {
            input: 0,
            output: 0,
            cacheWrite: 0,
            cacheRead: 0,
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ];

      // Create agents
      const agents = [
        {
          agentId: 'agent:iria',
          coreId: 'core:test',
          name: 'Iria',
          fullName: 'Iria Devon',
          role: 'AI Assistant',
          intro: 'I am Iria, your AI assistant.',
          avatarUrl: 'iria.png',
          status: 'active',
          customization: {
            personalityTweaks: ['helpful', 'friendly'],
            additionalCapabilities: ['tools'],
            responseStyle: 'conversational',
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          agentId: 'agent:test',
          coreId: 'core:test',
          name: 'Test',
          fullName: 'Test Agent',
          role: 'Test Assistant',
          intro: 'I am a test agent.',
          avatarUrl: 'test.png',
          status: 'active',
          customization: {
            personalityTweaks: ['helpful'],
            responseStyle: 'concise',
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ];

      await db.collection('models').insertMany(models);
      await db.collection('agent_cores').insertMany(cores);
      await db.collection('agents').insertMany(agents);
    },
  };
}
