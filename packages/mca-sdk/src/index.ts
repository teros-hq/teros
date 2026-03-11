/**
 * @teros/mca-sdk - SDK for building MCAs
 *
 * Provides utilities for MCAs to:
 * - Define tools with a simple API (McaServer)
 * - Communicate with backend via HTTP callbacks
 * - Implement standardized health checks
 * - Handle secrets on-demand
 *
 * @example
 * ```typescript
 * import { McaServer } from '@teros/mca-sdk';
 *
 * const server = new McaServer({
 *   id: 'mca.example.tool',
 *   name: 'Example Tool',
 *   version: '1.0.0',
 * });
 *
 * server.tool('hello', {
 *   description: 'Say hello',
 *   parameters: {
 *     type: 'object',
 *     properties: { name: { type: 'string' } },
 *     required: ['name'],
 *   },
 *   handler: async (args, context) => {
 *     // Get secrets on-demand from backend
 *     const secrets = await context.getSystemSecrets();
 *     return `Hello, ${args.name}!`;
 *   },
 * });
 *
 * server.start();
 * ```
 */

// Re-export shared types for convenience
// Re-export MCA protocol types
// Re-export RFC-003 endpoint types
export type {
  AgentMessage,
  AuthDefinition,
  AuthErrorType,
  // Layer 5: Auth
  AuthType,
  BackendToMcaEndpoint,
  // Type helpers
  BackendToMcaEndpoints,
  // Layer 1: Tools
  CallToolRequest,
  CallToolResponse,
  EmitEventRequest,
  EmitEventResponse,
  EventDefinition,
  // Layer 2: Events
  EventDirection,
  // Common
  ExecutionContext,
  GetSystemSecretsRequest,
  GetSystemSecretsResponse,
  GetUserSecretsRequest,
  GetUserSecretsResponse,
  HealthAction,
  HealthActionType,
  // Lifecycle
  HealthCheckRequest,
  HealthCheckResponse,
  HealthIssue,
  HealthIssueCode,
  HealthStatus,
  ListToolsRequest,
  ListToolsResponse,
  McaError,
  McaEvent,
  McaExecutionContext,
  McaHealthStatus,
  McaRequest,
  McaResponse,
  McaToBackendEndpoint,
  McaToBackendEndpoints,
  McaToolDefinition,
  PushEventRequest,
  PushEventResponse,
  ReportAuthErrorRequest,
  ReportAuthErrorResponse,
  ReportHealthRequest,
  ReportHealthResponse,
  ShutdownRequest,
  ShutdownResponse,
  SubscribeRequest,
  SubscribeResponse,
  ToolDefinition,
  ToolPermissions,
  UnsubscribeRequest,
  UnsubscribeResponse,
  UpdateUserSecretsRequest,
  UpdateUserSecretsResponse,
} from '@teros/shared';
// Backend client (for MCA → Backend communication)
export {
  type BackendClientConfig,
  type BackendClientError,
  createBackendClient,
  McaBackendClient,
} from './backend-client';
// Health check helpers
export {
  authRequired,
  HealthCheckBuilder,
  healthAction,
  healthIssue,
  healthResult,
  notReady,
  ready,
  type SecretsContext,
  systemConfigMissing,
} from './health';
// HTTP server (HTTP transport)
export {
  type HttpServerConfig,
  McaHttpServer,
  type McaHttpServerConfig,
  type ToolConfig as HttpToolConfig,
  type ToolContext as HttpToolContext,
} from './http-server';
// Main server class (wrapper that auto-detects transport)
export {
  createMcaServer,
  type HealthCheckResult,
  McaServer,
  type McaServerConfig,
  type ToolConfig,
  type ToolContext,
  type ToolHandler,
  type TransportType,
} from './server';
// Stdio server (stdio/MCP transport)
export {
  McaStdioServer,
  type McaStdioServerConfig,
  type ToolConfig as StdioToolConfig,
  type ToolContext as StdioToolContext,
} from './stdio-server';
// WebSocket client (for bidirectional MCA ↔ Backend communication)
export {
  createWebSocketClient,
  McaWebSocketClient,
  type McaWebSocketConfig,
  type McaWebSocketEvents,
} from './websocket-client';
