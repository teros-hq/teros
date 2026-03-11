/**
 * MCA Health Check and WebSocket Protocol Types
 *
 * Defines the contract between backend and MCAs for:
 * - Health checks (ready/not_ready status)
 * - WebSocket bidirectional communication
 * - Subscription management
 */

import { z } from "zod"

// ============================================================================
// HEALTH CHECK TYPES
// ============================================================================

/**
 * Health issue codes - standardized error codes for health problems
 */
export const HealthIssueCodeSchema = z.enum([
  // Auth issues
  "AUTH_REQUIRED", // User has not authorized
  "AUTH_EXPIRED", // Token expired
  "AUTH_INVALID", // Invalid credentials
  "AUTH_REVOKED", // User revoked access

  // Config issues
  "SYSTEM_CONFIG_MISSING", // Missing admin config (system API keys)
  "USER_CONFIG_MISSING", // Missing user config
  "CONFIG_INVALID", // Config exists but is invalid

  // Runtime issues
  "DEPENDENCY_UNAVAILABLE", // External service unavailable
  "RATE_LIMITED", // Rate limit reached
  "QUOTA_EXCEEDED", // Quota exceeded

  // Code issues
  "INTERNAL_ERROR", // Error in MCA code
])
export type HealthIssueCode = z.infer<typeof HealthIssueCodeSchema>

/**
 * Action type for resolving health issues
 */
export const HealthActionTypeSchema = z.enum([
  "user_action", // User needs to do something (e.g., connect account)
  "admin_action", // Admin needs to configure something
  "auto_retry", // Will resolve automatically, retry later
])
export type HealthActionType = z.infer<typeof HealthActionTypeSchema>

/**
 * Action to resolve a health issue
 */
export const HealthActionSchema = z.object({
  type: HealthActionTypeSchema,
  description: z.string(),
  url: z.string().optional(), // URL where to resolve (exposed by MCA)
})
export type HealthAction = z.infer<typeof HealthActionSchema>

/**
 * Individual health issue
 */
export const HealthIssueSchema = z.object({
  code: HealthIssueCodeSchema,
  message: z.string(),
  action: HealthActionSchema.optional(),
})
export type HealthIssue = z.infer<typeof HealthIssueSchema>

/**
 * Health status enum
 */
export const HealthStatusSchema = z.enum([
  "ready", // MCA is fully functional
  "not_ready", // MCA cannot process requests
  "degraded", // MCA works but with limitations
])
export type HealthStatus = z.infer<typeof HealthStatusSchema>

/**
 * Health check result - returned by _health_check tool
 */
export const HealthCheckResultSchema = z.object({
  status: HealthStatusSchema,
  issues: z.array(HealthIssueSchema).optional(),
  version: z.string().optional(),
  uptime: z.number().optional(), // seconds
})
export type HealthCheckResult = z.infer<typeof HealthCheckResultSchema>

// ============================================================================
// WEBSOCKET MESSAGE TYPES - Backend → MCA
// ============================================================================

/**
 * Connection acknowledgment
 */
export const WsConnectionAckSchema = z.object({
  type: z.literal("connection_ack"),
  appId: z.string(),
  serverTime: z.number(), // Unix timestamp ms
  config: z.record(z.unknown()).optional(),
})
export type WsConnectionAck = z.infer<typeof WsConnectionAckSchema>

/**
 * Ping message (heartbeat)
 */
export const WsPingSchema = z.object({
  type: z.literal("ping"),
  serverTime: z.number(),
})
export type WsPing = z.infer<typeof WsPingSchema>

/**
 * Credentials updated notification
 */
export const WsCredentialsUpdatedSchema = z.object({
  type: z.literal("credentials_updated"),
  credentials: z.record(z.string()),
})
export type WsCredentialsUpdated = z.infer<typeof WsCredentialsUpdatedSchema>

/**
 * Subscription added notification
 */
export const WsSubscriptionAddedSchema = z.object({
  type: z.literal("subscription_added"),
  subscriptionId: z.string(),
  event: z.object({
    type: z.string(),
    filter: z.record(z.unknown()).optional(),
  }),
  subscriber: z.object({
    userId: z.string(),
    agentId: z.string(),
    channelId: z.string(),
  }),
  options: z
    .object({
      ttlMs: z.number().optional(),
      maxEvents: z.number().optional(),
      expiresAt: z.string().optional(), // ISO date
    })
    .optional(),
})
export type WsSubscriptionAdded = z.infer<typeof WsSubscriptionAddedSchema>

/**
 * Subscription removed notification
 */
export const WsSubscriptionRemovedSchema = z.object({
  type: z.literal("subscription_removed"),
  subscriptionId: z.string(),
  reason: z.string(),
})
export type WsSubscriptionRemoved = z.infer<typeof WsSubscriptionRemovedSchema>

/**
 * Command from backend to MCA
 */
export const WsCommandSchema = z.object({
  type: z.literal("command"),
  command: z.enum(["shutdown", "reload", "health_check"]),
  params: z.record(z.unknown()).optional(),
})
export type WsCommand = z.infer<typeof WsCommandSchema>

/**
 * Response to get_system_secrets request
 */
export const WsSystemSecretsResponseSchema = z.object({
  type: z.literal("system_secrets"),
  requestId: z.string(),
  secrets: z.record(z.string()).nullable(), // null if not available
  error: z.string().optional(),
})
export type WsSystemSecretsResponse = z.infer<typeof WsSystemSecretsResponseSchema>

/**
 * Response to get_user_secrets request
 */
export const WsUserSecretsResponseSchema = z.object({
  type: z.literal("user_secrets"),
  requestId: z.string(),
  secrets: z.record(z.string()).nullable(), // null if not available/not authenticated
  error: z.string().optional(),
})
export type WsUserSecretsResponse = z.infer<typeof WsUserSecretsResponseSchema>

/**
 * Response to query_conversations request
 */
export const WsQueryConversationsResultSchema = z.object({
  type: z.literal("query_conversations_result"),
  requestId: z.string(),
  action: z.string(),
  data: z.unknown(), // Result data depends on action
  error: z.string().optional(),
})
export type WsQueryConversationsResult = z.infer<typeof WsQueryConversationsResultSchema>

/**
 * Response to update_user_secrets request
 */
export const WsUpdateUserSecretsResponseSchema = z.object({
  type: z.literal("update_user_secrets_response"),
  requestId: z.string(),
  success: z.boolean(),
  error: z.string().optional(),
})
export type WsUpdateUserSecretsResponse = z.infer<typeof WsUpdateUserSecretsResponseSchema>

/**
 * Admin API response from backend to MCA
 */
export const WsAdminResponseSchema = z.object({
  type: z.literal("admin_response"),
  requestId: z.string(),
  data: z.unknown().optional(),
  error: z.string().optional(),
  code: z.string().optional(), // error code if error
})

/**
 * Union of all Backend → MCA messages
 */
export const WsBackendToMcaMessageSchema = z.discriminatedUnion("type", [
  WsConnectionAckSchema,
  WsPingSchema,
  WsCredentialsUpdatedSchema,
  WsSubscriptionAddedSchema,
  WsSubscriptionRemovedSchema,
  WsCommandSchema,
  WsSystemSecretsResponseSchema,
  WsUserSecretsResponseSchema,
  WsUpdateUserSecretsResponseSchema,
  WsQueryConversationsResultSchema,
  WsAdminResponseSchema,
])

// Type aliases placed after the union to prevent tsc from reordering
// declarations across type-only statements (causes TDZ errors in ESM output)
export type WsAdminResponse = z.infer<typeof WsAdminResponseSchema>
export type WsBackendToMcaMessage = z.infer<typeof WsBackendToMcaMessageSchema>

// ============================================================================
// WEBSOCKET MESSAGE TYPES - MCA → Backend
// ============================================================================

/**
 * Pong response to ping
 */
export const WsPongSchema = z.object({
  type: z.literal("pong"),
  mcaTime: z.number(), // Unix timestamp ms
  status: HealthStatusSchema.optional(),
})
export type WsPong = z.infer<typeof WsPongSchema>

/**
 * Event from MCA (async notification)
 */
export const WsMcaEventSchema = z.object({
  type: z.literal("event"),
  eventId: z.string(),
  subscriptionId: z.string(),
  eventType: z.string(), // e.g., 'email.received', 'reminder.trigger'
  data: z.record(z.unknown()),
  timestamp: z.number().optional(), // Unix timestamp ms
})
export type WsMcaEvent = z.infer<typeof WsMcaEventSchema>

/**
 * Health status update
 */
export const WsHealthUpdateSchema = z.object({
  type: z.literal("health_update"),
  status: HealthStatusSchema,
  issues: z.array(HealthIssueSchema).optional(),
})
export type WsHealthUpdate = z.infer<typeof WsHealthUpdateSchema>

/**
 * Credentials expired notification
 */
export const WsCredentialsExpiredSchema = z.object({
  type: z.literal("credentials_expired"),
  reason: z.string(),
  message: z.string().optional(),
})
export type WsCredentialsExpired = z.infer<typeof WsCredentialsExpiredSchema>

/**
 * Error from MCA
 */
export const WsMcaErrorSchema = z.object({
  type: z.literal("error"),
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
})
export type WsMcaError = z.infer<typeof WsMcaErrorSchema>

/**
 * Request system secrets (MCA config like CLIENT_ID, CLIENT_SECRET)
 */
export const WsGetSystemSecretsSchema = z.object({
  type: z.literal("get_system_secrets"),
  requestId: z.string(),
})
export type WsGetSystemSecrets = z.infer<typeof WsGetSystemSecretsSchema>

/**
 * Request user secrets (user credentials like ACCESS_TOKEN, REFRESH_TOKEN)
 */
export const WsGetUserSecretsSchema = z.object({
  type: z.literal("get_user_secrets"),
  requestId: z.string(),
})
export type WsGetUserSecrets = z.infer<typeof WsGetUserSecretsSchema>

/**
 * Update user secrets (when MCA refreshes tokens locally)
 */
export const WsUpdateUserSecretsSchema = z.object({
  type: z.literal("update_user_secrets"),
  requestId: z.string(),
  secrets: z.record(z.string()), // Partial update - only keys provided will be updated
})
export type WsUpdateUserSecrets = z.infer<typeof WsUpdateUserSecretsSchema>

/**
 * Admin API request from MCA to backend (via WsRouter admin-api domain)
 * Replaces HTTP fetch to /admin/* endpoints
 */
export const WsAdminRequestSchema = z.object({
  type: z.literal("admin_request"),
  requestId: z.string(),
  action: z.string(), // e.g. 'admin-api.mca-status'
  params: z.record(z.unknown()).optional(),
})
export type WsAdminRequest = z.infer<typeof WsAdminRequestSchema>

/**
 * Query conversations - search messages, list channels, get messages
 */
export const WsQueryConversationsActionSchema = z.enum([
  // Conversation actions
  "search_messages",
  "list_channels",
  "get_channel_messages",
  "get_channel_summary",
  "create_channel",
  "send_message",
  "rename_channel",
  // Board actions
  "get_tasks_by_agent",
  "get_board_summary",
  "get_task",
  "list_tasks",
  "list_projects",
  "create_project",
  "create_task",
  "batch_create_tasks",
  "update_task",
  "move_task",
  "assign_task",
  "start_task",
  "link_conversation",
  "delete_task",
  "move_my_task",
  "update_my_task_status",
  "add_my_progress_note",
  "update_task_status",
  "add_progress_note",
])
export type WsQueryConversationsAction = z.infer<typeof WsQueryConversationsActionSchema>

export const WsQueryConversationsSchema = z.object({
  type: z.literal("query_conversations"),
  requestId: z.string(),
  action: WsQueryConversationsActionSchema,
  params: z.record(z.unknown()),
})
export type WsQueryConversations = z.infer<typeof WsQueryConversationsSchema>

/**
 * Union of all MCA → Backend messages
 */
export const WsMcaToBackendMessageSchema = z.discriminatedUnion("type", [
  WsPongSchema,
  WsMcaEventSchema,
  WsHealthUpdateSchema,
  WsCredentialsExpiredSchema,
  WsMcaErrorSchema,
  WsGetSystemSecretsSchema,
  WsGetUserSecretsSchema,
  WsUpdateUserSecretsSchema,
  WsQueryConversationsSchema,
  WsAdminRequestSchema,
])
export type WsMcaToBackendMessage = z.infer<typeof WsMcaToBackendMessageSchema>

// ============================================================================
// SUBSCRIPTION TYPES
// ============================================================================

/**
 * Subscription status
 */
export const SubscriptionStatusSchema = z.enum([
  "active", // Subscription is active and receiving events
  "paused", // Temporarily paused
  "expired", // TTL or maxEvents reached
  "error", // Error state
])
export type SubscriptionStatus = z.infer<typeof SubscriptionStatusSchema>

/**
 * Subscription subscriber info
 */
export const SubscriptionSubscriberSchema = z.object({
  userId: z.string(),
  agentId: z.string(),
  channelId: z.string(),
})
export type SubscriptionSubscriber = z.infer<typeof SubscriptionSubscriberSchema>

/**
 * Subscription event definition
 */
export const SubscriptionEventSchema = z.object({
  type: z.string(),
  filter: z.record(z.unknown()).optional(),
})
export type SubscriptionEvent = z.infer<typeof SubscriptionEventSchema>

/**
 * Subscription options
 */
export const SubscriptionOptionsSchema = z.object({
  ttlMs: z.number().optional(),
  maxEvents: z.number().optional(),
  expiresAt: z.date().optional(),
})
export type SubscriptionOptions = z.infer<typeof SubscriptionOptionsSchema>

/**
 * Full subscription document (for MongoDB)
 */
export const McaSubscriptionSchema = z.object({
  subscriptionId: z.string(), // 'sub_' + nanoid()
  appId: z.string(),
  mcaId: z.string(),
  subscriber: SubscriptionSubscriberSchema,
  event: SubscriptionEventSchema,
  options: SubscriptionOptionsSchema.optional(),
  status: SubscriptionStatusSchema,
  statusReason: z.string().optional(),
  eventsDelivered: z.number().default(0),
  createdAt: z.date(),
  updatedAt: z.date(),
  lastEventAt: z.date().optional(),
})
export type McaSubscription = z.infer<typeof McaSubscriptionSchema>

// ============================================================================
// CONNECTION TYPES
// ============================================================================

/**
 * Pending connection (waiting for MCA to connect via WebSocket)
 */
export const PendingConnectionSchema = z.object({
  appId: z.string(),
  token: z.string(),
  createdAt: z.number(), // Unix timestamp ms
  expiresAt: z.number(), // Unix timestamp ms (30s after creation)
})
export type PendingConnection = z.infer<typeof PendingConnectionSchema>

/**
 * Active MCA connection
 */
export const McaConnectionSchema = z.object({
  appId: z.string(),
  connectedAt: z.number(), // Unix timestamp ms
  lastPingAt: z.number().optional(),
  lastPongAt: z.number().optional(),
  status: HealthStatusSchema,
  subscriptionCount: z.number().default(0),
})
export type McaConnection = z.infer<typeof McaConnectionSchema>

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Parse and validate a WebSocket message from MCA
 */
export function parseMcaMessage(data: unknown): WsMcaToBackendMessage | null {
  const result = WsMcaToBackendMessageSchema.safeParse(data)
  return result.success ? result.data : null
}

/**
 * Parse and validate a WebSocket message from Backend
 */
export function parseBackendMessage(data: unknown): WsBackendToMcaMessage | null {
  const result = WsBackendToMcaMessageSchema.safeParse(data)
  return result.success ? result.data : null
}

/**
 * Create a health check result with issues
 */
export function createHealthResult(
  status: HealthStatus,
  issues?: HealthIssue[],
): HealthCheckResult {
  return {
    status,
    issues: issues && issues.length > 0 ? issues : undefined,
  }
}

/**
 * Create a health issue
 */
export function createHealthIssue(
  code: HealthIssueCode,
  message: string,
  action?: HealthAction,
): HealthIssue {
  return { code, message, action }
}
