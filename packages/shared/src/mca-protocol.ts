/**
 * MCA Protocol v1.0
 *
 * Communication protocol between Teros Backend and MCAs (Model Context Apps).
 * Transport-agnostic: works over WebSocket, HTTP, stdio, or any future transport.
 *
 * @see docs/RFC-001-mca-protocol.md
 */

import { z } from 'zod';

// ============================================================================
// PROTOCOL VERSION
// ============================================================================

export const MCA_PROTOCOL_VERSION = '1.0' as const;

// ============================================================================
// BASE MESSAGE ENVELOPE
// ============================================================================

/**
 * Base envelope for all MCA protocol messages
 */
export const McaMessageBaseSchema = z.object({
  /** Unique identifier for request/response correlation */
  id: z.string(),
  /** Message type discriminator */
  type: z.string(),
  /** ISO 8601 timestamp */
  timestamp: z.string(),
  /** Protocol version */
  version: z.literal('1.0'),
});

export type McaMessageBase = z.infer<typeof McaMessageBaseSchema>;

// ============================================================================
// TOOL DEFINITION
// ============================================================================

/**
 * JSON Schema for tool parameters
 */
export const JsonSchemaSchema: z.ZodType<Record<string, unknown>> = z.record(z.unknown());

/**
 * Tool definition as exposed by MCAs
 */
export const McaToolDefinitionSchema = z.object({
  /** Tool name (unique within MCA) */
  name: z.string(),
  /** Human-readable description */
  description: z.string(),
  /** JSON Schema for parameters */
  parameters: z.object({
    type: z.literal('object'),
    properties: z.record(z.unknown()),
    required: z.array(z.string()).optional(),
  }),
});

export type McaToolDefinition = z.infer<typeof McaToolDefinitionSchema>;

// ============================================================================
// EXECUTION CONTEXT
// ============================================================================

/**
 * Context passed with tool calls
 */
export const McaExecutionContextSchema = z.object({
  /** User who initiated the request */
  userId: z.string(),
  /** Workspace ID if the request is in a workspace context */
  workspaceId: z.string().optional(),
  /** App instance ID */
  appId: z.string(),
  /** MCA catalog ID (e.g., 'mca.perplexity') */
  mcaId: z.string().optional(),
  /** Channel where the request originated (optional) */
  channelId: z.string().optional(),
  /** Agent handling the request (optional) */
  agentId: z.string().optional(),
  /** Unique request ID for correlation */
  requestId: z.string().optional(),
  /** Callback URL for MCA → Backend communication */
  callbackUrl: z.string().optional(),
});

export type McaExecutionContext = z.infer<typeof McaExecutionContextSchema>;

// ============================================================================
// REQUEST MESSAGES (Backend → MCA)
// ============================================================================

/**
 * Execute a tool
 */
export const McaToolCallRequestSchema = McaMessageBaseSchema.extend({
  type: z.literal('tool_call'),
  /** Tool to execute */
  tool: z.string(),
  /** Tool arguments */
  arguments: z.record(z.unknown()),
  /** Execution context */
  context: McaExecutionContextSchema,
});

export type McaToolCallRequest = z.infer<typeof McaToolCallRequestSchema>;

/**
 * Get available tools
 */
export const McaListToolsRequestSchema = McaMessageBaseSchema.extend({
  type: z.literal('list_tools'),
});

export type McaListToolsRequest = z.infer<typeof McaListToolsRequestSchema>;

/**
 * Check MCA health
 */
export const McaHealthCheckRequestSchema = McaMessageBaseSchema.extend({
  type: z.literal('health_check'),
});

export type McaHealthCheckRequest = z.infer<typeof McaHealthCheckRequestSchema>;

/**
 * Graceful shutdown request
 */
export const McaShutdownRequestSchema = McaMessageBaseSchema.extend({
  type: z.literal('shutdown'),
  /** Timeout in ms before force kill */
  gracePeriod: z.number(),
});

export type McaShutdownRequest = z.infer<typeof McaShutdownRequestSchema>;

/**
 * Cancel an in-flight request
 */
export const McaCancelRequestSchema = McaMessageBaseSchema.extend({
  type: z.literal('cancel'),
  /** Request ID to cancel */
  requestId: z.string(),
  /** Reason for cancellation */
  reason: z.string().optional(),
});

export type McaCancelRequest = z.infer<typeof McaCancelRequestSchema>;

/**
 * Subscribe to events
 */
export const McaSubscribeRequestSchema = McaMessageBaseSchema.extend({
  type: z.literal('subscribe'),
  /** Subscription type (MCA-specific) */
  subscription: z.string(),
  /** Subscription parameters */
  params: z.record(z.unknown()),
  /** Channel to receive events */
  channelId: z.string(),
});

export type McaSubscribeRequest = z.infer<typeof McaSubscribeRequestSchema>;

/**
 * Unsubscribe from events
 */
export const McaUnsubscribeRequestSchema = McaMessageBaseSchema.extend({
  type: z.literal('unsubscribe'),
  /** Subscription ID to remove */
  subscriptionId: z.string(),
});

export type McaUnsubscribeRequest = z.infer<typeof McaUnsubscribeRequestSchema>;

/**
 * Union of all request types
 */
export const McaRequestSchema = z.discriminatedUnion('type', [
  McaToolCallRequestSchema,
  McaListToolsRequestSchema,
  McaHealthCheckRequestSchema,
  McaShutdownRequestSchema,
  McaCancelRequestSchema,
  McaSubscribeRequestSchema,
  McaUnsubscribeRequestSchema,
]);

export type McaRequest = z.infer<typeof McaRequestSchema>;

// ============================================================================
// RESPONSE MESSAGES (MCA → Backend)
// ============================================================================

/**
 * Error details
 */
export const McaErrorSchema = z.object({
  /** Machine-readable error code */
  code: z.string(),
  /** Human-readable message */
  message: z.string(),
  /** Additional error context */
  details: z.unknown().optional(),
});

export type McaError = z.infer<typeof McaErrorSchema>;

/**
 * Tool execution result
 */
export const McaToolResultResponseSchema = McaMessageBaseSchema.extend({
  type: z.literal('tool_result'),
  /** Whether the tool executed successfully */
  success: z.boolean(),
  /** Tool output (if success) */
  result: z.unknown().optional(),
  /** Error details (if !success) */
  error: McaErrorSchema.optional(),
  /** Execution time in milliseconds */
  duration: z.number(),
});

export type McaToolResultResponse = z.infer<typeof McaToolResultResponseSchema>;

/**
 * Available tools list
 */
export const McaToolsListResponseSchema = McaMessageBaseSchema.extend({
  type: z.literal('tools_list'),
  tools: z.array(McaToolDefinitionSchema),
});

export type McaToolsListResponse = z.infer<typeof McaToolsListResponseSchema>;

/**
 * Health status
 */
export const McaHealthStatusSchema = z.enum(['ready', 'not_ready', 'degraded']);
export type McaHealthStatus = z.infer<typeof McaHealthStatusSchema>;

/**
 * Health issue with optional action
 */
export const McaHealthIssueSchema = z.object({
  code: z.string(),
  message: z.string(),
  severity: z.enum(['error', 'warning']),
  action: z
    .object({
      type: z.enum(['link', 'oauth']),
      url: z.string(),
      label: z.string(),
    })
    .optional(),
});

export type McaHealthIssue = z.infer<typeof McaHealthIssueSchema>;

/**
 * Health check response
 */
export const McaHealthStatusResponseSchema = McaMessageBaseSchema.extend({
  type: z.literal('health_status'),
  status: McaHealthStatusSchema,
  /** Human-readable message */
  message: z.string().optional(),
  /** Structured issues for UI display */
  issues: z.array(McaHealthIssueSchema).optional(),
  /** Uptime in seconds */
  uptime: z.number().optional(),
  /** MCA version */
  version: z.string().optional(),
  /** Memory usage in bytes */
  memoryUsage: z.number().optional(),
});

export type McaHealthStatusResponse = z.infer<typeof McaHealthStatusResponseSchema>;

/**
 * Shutdown acknowledged
 */
export const McaShutdownAckResponseSchema = McaMessageBaseSchema.extend({
  type: z.literal('shutdown_ack'),
});

export type McaShutdownAckResponse = z.infer<typeof McaShutdownAckResponseSchema>;

/**
 * Cancellation result
 */
export const McaCancelResultResponseSchema = McaMessageBaseSchema.extend({
  type: z.literal('cancel_result'),
  /** Original request ID */
  requestId: z.string(),
  /** Whether cancellation was successful */
  cancelled: z.boolean(),
  /** If not cancelled, why */
  reason: z.string().optional(),
});

export type McaCancelResultResponse = z.infer<typeof McaCancelResultResponseSchema>;

/**
 * Subscription created
 */
export const McaSubscribeResultResponseSchema = McaMessageBaseSchema.extend({
  type: z.literal('subscribe_result'),
  /** Subscription ID for management */
  subscriptionId: z.string(),
  success: z.boolean(),
  error: z.string().optional(),
});

export type McaSubscribeResultResponse = z.infer<typeof McaSubscribeResultResponseSchema>;

/**
 * Subscription removed
 */
export const McaUnsubscribeResultResponseSchema = McaMessageBaseSchema.extend({
  type: z.literal('unsubscribe_result'),
  subscriptionId: z.string(),
  success: z.boolean(),
});

export type McaUnsubscribeResultResponse = z.infer<typeof McaUnsubscribeResultResponseSchema>;

/**
 * Protocol-level error
 */
export const McaErrorResponseSchema = McaMessageBaseSchema.extend({
  type: z.literal('error'),
  error: McaErrorSchema,
});

export type McaErrorResponse = z.infer<typeof McaErrorResponseSchema>;

/**
 * Union of all response types
 */
export const McaResponseSchema = z.discriminatedUnion('type', [
  McaToolResultResponseSchema,
  McaToolsListResponseSchema,
  McaHealthStatusResponseSchema,
  McaShutdownAckResponseSchema,
  McaCancelResultResponseSchema,
  McaSubscribeResultResponseSchema,
  McaUnsubscribeResultResponseSchema,
  McaErrorResponseSchema,
]);

export type McaResponse = z.infer<typeof McaResponseSchema>;

// ============================================================================
// EVENT MESSAGES (MCA → Backend, unsolicited)
// ============================================================================

/**
 * Log message
 */
export const McaLogEventSchema = McaMessageBaseSchema.extend({
  type: z.literal('log'),
  level: z.enum(['debug', 'info', 'warn', 'error']),
  message: z.string(),
  data: z.unknown().optional(),
  appId: z.string(),
});

export type McaLogEvent = z.infer<typeof McaLogEventSchema>;

/**
 * Credentials expired
 */
export const McaCredentialsExpiredEventSchema = McaMessageBaseSchema.extend({
  type: z.literal('credentials_expired'),
  appId: z.string(),
  reason: z.enum(['token_expired', 'token_revoked', 'refresh_failed']),
  canRefresh: z.boolean(),
});

export type McaCredentialsExpiredEvent = z.infer<typeof McaCredentialsExpiredEventSchema>;

/**
 * Performance metric
 */
export const McaMetricEventSchema = McaMessageBaseSchema.extend({
  type: z.literal('metric'),
  appId: z.string(),
  name: z.string(),
  value: z.number(),
  unit: z.string(),
  tags: z.record(z.string()).optional(),
});

export type McaMetricEvent = z.infer<typeof McaMetricEventSchema>;

/**
 * Progress update for long-running tool
 */
export const McaToolProgressEventSchema = McaMessageBaseSchema.extend({
  type: z.literal('tool_progress'),
  /** Original request ID */
  requestId: z.string(),
  /** Progress percentage (0-100), or null if indeterminate */
  progress: z.number().nullable(),
  /** Current status message */
  status: z.string(),
  /** Estimated time remaining in ms */
  eta: z.number().optional(),
  /** Partial result */
  partial: z.unknown().optional(),
});

export type McaToolProgressEvent = z.infer<typeof McaToolProgressEventSchema>;

/**
 * Streaming text output chunk
 */
export const McaToolStreamEventSchema = McaMessageBaseSchema.extend({
  type: z.literal('tool_stream'),
  /** Original request ID */
  requestId: z.string(),
  /** Stream chunk */
  chunk: z.string(),
  /** Is this the final chunk? */
  done: z.boolean(),
});

export type McaToolStreamEvent = z.infer<typeof McaToolStreamEventSchema>;

/**
 * Event from subscription
 */
export const McaSubscriptionEventSchema = McaMessageBaseSchema.extend({
  type: z.literal('subscription_event'),
  subscriptionId: z.string(),
  /** Event type (MCA-specific) */
  event: z.string(),
  /** Event payload */
  data: z.unknown(),
});

export type McaSubscriptionEvent = z.infer<typeof McaSubscriptionEventSchema>;

/**
 * Proactive health status change
 */
export const McaHealthUpdateEventSchema = McaMessageBaseSchema.extend({
  type: z.literal('health_update'),
  appId: z.string(),
  status: McaHealthStatusSchema,
  issues: z.array(McaHealthIssueSchema).optional(),
});

export type McaHealthUpdateEvent = z.infer<typeof McaHealthUpdateEventSchema>;

/**
 * Union of all event types (MCA → Backend)
 */
export const McaEventSchema = z.discriminatedUnion('type', [
  McaLogEventSchema,
  McaCredentialsExpiredEventSchema,
  McaMetricEventSchema,
  McaToolProgressEventSchema,
  McaToolStreamEventSchema,
  McaSubscriptionEventSchema,
  McaHealthUpdateEventSchema,
]);

export type McaEvent = z.infer<typeof McaEventSchema>;

// ============================================================================
// BACKEND → MCA PUSHED EVENTS
// ============================================================================

/**
 * New credentials available (after refresh)
 */
export const McaCredentialsUpdatedEventSchema = McaMessageBaseSchema.extend({
  type: z.literal('credentials_updated'),
  credentials: z.record(z.string()),
});

export type McaCredentialsUpdatedEvent = z.infer<typeof McaCredentialsUpdatedEventSchema>;

/**
 * Union of backend-pushed events
 */
export const McaBackendEventSchema = z.discriminatedUnion('type', [
  McaCredentialsUpdatedEventSchema,
]);

export type McaBackendEvent = z.infer<typeof McaBackendEventSchema>;

// ============================================================================
// SECRET REQUEST MESSAGES (MCA → Backend via WebSocket)
// ============================================================================

/**
 * Get system-level secrets
 */
export const McaGetSystemSecretsRequestSchema = McaMessageBaseSchema.extend({
  type: z.literal('get_system_secrets'),
  requestId: z.string(),
});

export type McaGetSystemSecretsRequest = z.infer<typeof McaGetSystemSecretsRequestSchema>;

/**
 * System secrets response
 */
export const McaSystemSecretsResponseSchema = McaMessageBaseSchema.extend({
  type: z.literal('system_secrets'),
  requestId: z.string(),
  secrets: z.record(z.string()).nullable(),
  error: z.string().optional(),
});

export type McaSystemSecretsResponse = z.infer<typeof McaSystemSecretsResponseSchema>;

/**
 * Get user-level secrets
 */
export const McaGetUserSecretsRequestSchema = McaMessageBaseSchema.extend({
  type: z.literal('get_user_secrets'),
  requestId: z.string(),
});

export type McaGetUserSecretsRequest = z.infer<typeof McaGetUserSecretsRequestSchema>;

/**
 * User secrets response
 */
export const McaUserSecretsResponseSchema = McaMessageBaseSchema.extend({
  type: z.literal('user_secrets'),
  requestId: z.string(),
  secrets: z.record(z.string()).nullable(),
  error: z.string().optional(),
});

export type McaUserSecretsResponse = z.infer<typeof McaUserSecretsResponseSchema>;

/**
 * Update user secrets (after token refresh)
 */
export const McaUpdateUserSecretsRequestSchema = McaMessageBaseSchema.extend({
  type: z.literal('update_user_secrets'),
  requestId: z.string(),
  secrets: z.record(z.string()),
});

export type McaUpdateUserSecretsRequest = z.infer<typeof McaUpdateUserSecretsRequestSchema>;

/**
 * Update user secrets response
 */
export const McaUpdateUserSecretsResponseSchema = McaMessageBaseSchema.extend({
  type: z.literal('update_user_secrets_response'),
  requestId: z.string(),
  success: z.boolean(),
  error: z.string().optional(),
});

export type McaUpdateUserSecretsResponse = z.infer<typeof McaUpdateUserSecretsResponseSchema>;

/**
 * Get OAuth authorization URL
 */
export const McaAuthUrlRequestSchema = McaMessageBaseSchema.extend({
  type: z.literal('auth_url'),
  requestId: z.string(),
  provider: z.string(),
  scopes: z.array(z.string()).optional(),
});

export type McaAuthUrlRequest = z.infer<typeof McaAuthUrlRequestSchema>;

/**
 * OAuth URL response
 */
export const McaAuthUrlResponseSchema = McaMessageBaseSchema.extend({
  type: z.literal('auth_url_result'),
  requestId: z.string(),
  url: z.string(),
  state: z.string(),
});

export type McaAuthUrlResponse = z.infer<typeof McaAuthUrlResponseSchema>;

/**
 * Check auth status
 */
export const McaAuthStatusRequestSchema = McaMessageBaseSchema.extend({
  type: z.literal('auth_status'),
  requestId: z.string(),
});

export type McaAuthStatusRequest = z.infer<typeof McaAuthStatusRequestSchema>;

/**
 * Auth status response
 */
export const McaAuthStatusResponseSchema = McaMessageBaseSchema.extend({
  type: z.literal('auth_status_result'),
  requestId: z.string(),
  authenticated: z.boolean(),
  provider: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  expiresAt: z.string().optional(),
  authRequired: z.boolean().optional(),
  authUrl: z.string().optional(),
});

export type McaAuthStatusResponse = z.infer<typeof McaAuthStatusResponseSchema>;

/**
 * Union of all secret request types
 */
export const McaSecretRequestSchema = z.discriminatedUnion('type', [
  McaGetSystemSecretsRequestSchema,
  McaGetUserSecretsRequestSchema,
  McaUpdateUserSecretsRequestSchema,
  McaAuthUrlRequestSchema,
  McaAuthStatusRequestSchema,
]);

export type McaSecretRequest = z.infer<typeof McaSecretRequestSchema>;

/**
 * Union of all secret response types
 */
export const McaSecretResponseSchema = z.discriminatedUnion('type', [
  McaSystemSecretsResponseSchema,
  McaUserSecretsResponseSchema,
  McaUpdateUserSecretsResponseSchema,
  McaAuthUrlResponseSchema,
  McaAuthStatusResponseSchema,
]);

export type McaSecretResponse = z.infer<typeof McaSecretResponseSchema>;

// ============================================================================
// ERROR CODES
// ============================================================================

/**
 * Standard error codes
 */
export const McaErrorCode = {
  // Retryable errors
  TIMEOUT: 'TIMEOUT',
  CONNECTION_FAILED: 'CONNECTION_FAILED',
  MCA_CRASHED: 'MCA_CRASHED',
  RATE_LIMITED: 'RATE_LIMITED',
  NOT_READY: 'NOT_READY',

  // Non-retryable errors
  TOOL_NOT_FOUND: 'TOOL_NOT_FOUND',
  INVALID_ARGUMENTS: 'INVALID_ARGUMENTS',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  UNKNOWN_MESSAGE_TYPE: 'UNKNOWN_MESSAGE_TYPE',
  INVALID_MESSAGE: 'INVALID_MESSAGE',
} as const;

export type McaErrorCode = (typeof McaErrorCode)[keyof typeof McaErrorCode];

/**
 * Retryable error codes
 */
const RETRYABLE_ERROR_CODES = [
  'TIMEOUT',
  'CONNECTION_FAILED',
  'MCA_CRASHED',
  'RATE_LIMITED',
  'NOT_READY',
] as const;

/**
 * Check if an error code is retryable
 */
export function isRetryableError(code: string): boolean {
  return RETRYABLE_ERROR_CODES.includes(code as (typeof RETRYABLE_ERROR_CODES)[number]);
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Generate a unique message ID
 */
export function generateMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Create a message envelope with common fields
 */
export function createMessageEnvelope(type: string): McaMessageBase {
  return {
    id: generateMessageId(),
    type,
    timestamp: new Date().toISOString(),
    version: MCA_PROTOCOL_VERSION,
  };
}

/**
 * Create a tool call request
 */
export function createToolCallRequest(
  tool: string,
  args: Record<string, unknown>,
  context: McaExecutionContext,
): McaToolCallRequest {
  return {
    ...createMessageEnvelope('tool_call'),
    type: 'tool_call',
    tool,
    arguments: args,
    context,
  };
}

/**
 * Create a tool result response
 */
export function createToolResultResponse(
  requestId: string,
  success: boolean,
  result?: unknown,
  error?: McaError,
  duration: number = 0,
): McaToolResultResponse {
  return {
    id: requestId, // Use same ID for correlation
    type: 'tool_result',
    timestamp: new Date().toISOString(),
    version: MCA_PROTOCOL_VERSION,
    success,
    result,
    error,
    duration,
  };
}

/**
 * Create an error response
 */
export function createErrorResponse(
  requestId: string,
  code: string,
  message: string,
  details?: unknown,
): McaErrorResponse {
  return {
    id: requestId,
    type: 'error',
    timestamp: new Date().toISOString(),
    version: MCA_PROTOCOL_VERSION,
    error: { code, message, details },
  };
}

// ============================================================================
// TYPE GUARDS
// ============================================================================

export function isMcaRequest(data: unknown): data is McaRequest {
  return McaRequestSchema.safeParse(data).success;
}

export function isMcaResponse(data: unknown): data is McaResponse {
  return McaResponseSchema.safeParse(data).success;
}

export function isMcaEvent(data: unknown): data is McaEvent {
  return McaEventSchema.safeParse(data).success;
}

export function isMcaToolCallRequest(data: unknown): data is McaToolCallRequest {
  return McaToolCallRequestSchema.safeParse(data).success;
}

export function isMcaToolResultResponse(data: unknown): data is McaToolResultResponse {
  return McaToolResultResponseSchema.safeParse(data).success;
}

export function isMcaHealthStatusResponse(data: unknown): data is McaHealthStatusResponse {
  return McaHealthStatusResponseSchema.safeParse(data).success;
}

// ============================================================================
// TRANSPORT INTERFACE
// ============================================================================

/**
 * Transport interface for MCA communication
 *
 * Implementations: StdioTransport, WebSocketTransport, HttpTransport
 */
export interface McaTransport {
  /**
   * Send a request and wait for the corresponding response.
   * Throws on timeout or transport error.
   */
  request<T extends McaResponse>(req: McaRequest, options?: { timeout?: number }): Promise<T>;

  /**
   * Register a handler for unsolicited events from the MCA.
   */
  onEvent(handler: (event: McaEvent) => void): void;

  /**
   * Establish connection to the MCA.
   */
  connect(): Promise<void>;

  /**
   * Close connection gracefully.
   */
  disconnect(): Promise<void>;

  /**
   * Check if transport is connected.
   */
  isConnected(): boolean;
}
