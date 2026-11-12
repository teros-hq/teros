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
  type ToolAnnotations,
  type ToolConfig,
  type ToolContext,
  type ToolHandler,
  type TransportType,
  // UI Resources
  type UiResourceType,
  type UiResourceConfig,
  type UiResourceHandler,
  type UiResourceData,
  type TreeNode,
  type DetailField,
  type DetailSection,
  type UiFormField,
} from './server';
// Renderer — converts UiResourceData to markdown/text/html
export {
  type RenderFormat,
  type RenderedOutput,
  renderToOutput,
  renderUiResourceData,
} from './renderer';
// Stdio server (stdio/MCP transport)
export {
  McaStdioServer,
  type McaStdioServerConfig,
  type ToolConfig as StdioToolConfig,
  type ToolContext as StdioToolContext,
} from './stdio-server';
// Process helpers (child_process spawn with AbortSignal integration)
export {
  spawnWithAbort,
  type SpawnWithAbortOptions,
  type SpawnWithAbortResult,
} from './process';
// Resilience helpers (criterion 18 of MCA-RUNBOOK.md)
export {
  type BackoffStrategy,
  type RetryOptions,
  TimeoutError,
  withRetry,
  withTimeout,
} from './retry';
// SSRF guard for MCAs reaching caller-supplied URLs (S1 — TER-564)
export {
  assertPublicUrl,
  BlockedUrlError,
  isPrivateAddress,
  isPrivateHostLiteral,
  MAX_SAFE_REDIRECTS,
  type NavigablePage,
  navigateSafely,
  type PublicUrlOptions,
  safeFetch,
} from './url-validation';
// Media persistence helpers (WS1b — objects-first standard)
export {
  DEFAULT_MAX_MEDIA_SIZE,
  DEFAULT_MEDIA_CONTENT_TYPE,
  isExternalMediaUrl,
  type MediaPersistenceContext,
  type PersistedMedia,
  type PersistedMediaOutput,
  type PersistExternalMediaOptions,
  persistExternalMedia,
  persistExternalMediaOutput,
} from './media-persistence';
// WebSocket client (for bidirectional MCA ↔ Backend communication)
// MCA streams (spec MCS)
export {
  McaStream,
  type McaStreamEvents,
  McaStreams,
  type StreamOpenOptions,
  type StreamScope,
  type StreamSocket,
  type StreamViewer,
} from './streams';
export {
  createWebSocketClient,
  McaWebSocketClient,
  type McaWebSocketConfig,
  type McaWebSocketEvents,
} from './websocket-client';

// Reserved subscription tools (v1.4.4 — the unified _subscribe API)
export {
  registerSubscriptionTools,
  loadEventsDeclaration,
  type DeclaredEvent,
  type DeclaredFilterField,
  type EventsDeclaration,
} from './subscriptions';

// Storage types — unified volume + sharing API
export type {
  VolumeStorage,
  VolumeEntry,
  VolumeStat,
  VolumeDeleteOptions,
  ShareAccess,
  ShareOptions,
  ShareResult,
  // AgentApps document storage
  DocumentStorage,
  StoragePutResult,
  StorageGetResult,
  StorageQueryResult,
  StorageUpdateResult,
  StorageDeleteResult,
  // AgentApps object storage
  ObjectStorage,
  ObjectListItem,
  ObjectPutResult,
  ObjectGetResult,
  ObjectDeleteResult,
  ObjectListResult,
} from './types';
