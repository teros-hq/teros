/**
 * MCA Abstract Endpoints - Type Definitions
 *
 * Transport-agnostic endpoint definitions for MCA communication.
 * See RFC-003 for full documentation.
 */

import type { JSONSchema7 } from 'json-schema';
import type { HealthIssue, HealthStatus } from '../mca-health';
import type { McaError } from '../mca-protocol';

// Re-export imported types for convenience
export type { McaError, HealthIssue, HealthStatus };

// ============================================================================
// Common Types
// ============================================================================

export interface ExecutionContext {
  userId: string;
  appId: string;
  mcaId?: string;
  channelId?: string;
  agentId?: string;
  requestId: string;
  callbackUrl?: string;
}

/**
 * Simple message type for agent conversations
 * Note: Different from protocol.ts Message which has more fields
 */
export interface AgentMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

// ============================================================================
// Layer 1: Tools
// ============================================================================

export interface ToolPermissions {
  /** Tool can be invoked by human users directly */
  human: boolean;
  /** Tool can be invoked by AI agents */
  agent: boolean;
  /** Requires explicit user approval before execution */
  approval: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JSONSchema7;
  returns?: JSONSchema7;
  permissions: ToolPermissions;
}

// callTool
export interface CallToolRequest {
  tool: string;
  arguments: Record<string, unknown>;
  context: ExecutionContext;
}

export interface CallToolResponse {
  success: boolean;
  result?: unknown;
  error?: McaError;
  duration: number;
}

// listTools
export type ListToolsRequest = {};

export interface ListToolsResponse {
  tools: ToolDefinition[];
}

// ============================================================================
// Layer 2: Events
// ============================================================================

export type EventDirection = 'incoming' | 'outgoing' | 'bidirectional';

export interface EventDefinition {
  name: string;
  direction: EventDirection;
  description?: string;
  payload?: JSONSchema7;
}

// subscribe
export interface SubscribeRequest {
  events: string[];
  channelId: string;
  filter?: Record<string, unknown>;
}

export interface SubscribeResponse {
  subscriptionId: string;
  subscribedEvents: string[];
}

// unsubscribe
export interface UnsubscribeRequest {
  subscriptionId: string;
}

export interface UnsubscribeResponse {
  success: boolean;
}

// pushEvent (Backend → MCA)
export interface PushEventRequest {
  event: string;
  payload: unknown;
  source: 'user' | 'system' | 'agent';
  context: ExecutionContext;
}

export interface PushEventResponse {
  received: boolean;
}

// emitEvent (MCA → Backend)
export interface EmitEventRequest {
  event: string;
  payload: unknown;
  targetChannelId?: string;
  subscriptionId?: string;
}

export interface EmitEventResponse {
  delivered: boolean;
  recipientCount: number;
}

// ============================================================================
// Layer 3: UI
// ============================================================================

export interface UIResourceDefinition {
  uri: string;
  name: string;
  mimeType: string;
  content: string;
  tools: string[];
  events: string[];
}

export interface WidgetDefinition {
  id: string;
  name: string;
  template: string;
  tools: string[];
  events: string[];
}

export interface WindowDefinition {
  id: string;
  name: string;
  template: string;
  defaultSize: { width: number; height: number };
  resizable: boolean;
  tools: string[];
  events: string[];
}

// getUIResource
export interface GetUIResourceRequest {
  resourceUri: string;
}

export interface GetUIResourceResponse extends UIResourceDefinition {}

// updateUIState
export interface UpdateUIStateRequest {
  windowId: string;
  state: Record<string, unknown>;
  patch?: boolean;
}

export interface UpdateUIStateResponse {
  applied: boolean;
}

// uiReady (MCA → Backend)
export interface UIReadyRequest {
  windowId: string;
  capabilities: string[];
}

export interface UIReadyResponse {
  acknowledged: boolean;
  initialState?: Record<string, unknown>;
}

// uiAction (MCA → Backend)
export interface UIActionRequest {
  windowId: string;
  action: string;
  payload: unknown;
  tool?: string;
  toolArguments?: Record<string, unknown>;
}

export interface UIActionResponse {
  handled: boolean;
  result?: unknown;
}

// ============================================================================
// Layer 4: Permissions
// ============================================================================

// requestApproval (MCA → Backend)
export interface RequestApprovalRequest {
  requestId: string;
  tool: string;
  arguments: Record<string, unknown>;
  message: string;
  context: ExecutionContext;
}

export interface RequestApprovalResponse {
  pending: boolean;
  approvalId: string;
}

// approvalResult (Backend → MCA, notification)
export interface ApprovalResultNotification {
  approvalId: string;
  approved: boolean;
  modifiedArguments?: Record<string, unknown>;
  denialReason?: string;
}

// ============================================================================
// Layer 5: Auth
// ============================================================================

export type AuthType = 'oauth2' | 'api-key' | 'basic' | 'custom';

export interface AuthDefinition {
  type: AuthType;
  provider?: string;
  scopes?: string[];
  systemSecrets: string[];
  userSecrets: string[];
}

// pushCredentials (Backend → MCA)
export interface PushCredentialsRequest {
  credentials: Record<string, string>;
  expiresAt?: string;
}

export interface PushCredentialsResponse {
  received: boolean;
}

// getSystemSecrets (MCA → Backend)
export interface GetSystemSecretsRequest {
  keys?: string[];
}

export interface GetSystemSecretsResponse {
  secrets: Record<string, string> | null;
  error?: string;
}

// getUserSecrets (MCA → Backend)
export interface GetUserSecretsRequest {
  keys?: string[];
}

export interface GetUserSecretsResponse {
  secrets: Record<string, string> | null;
  authenticated: boolean;
  expiresAt?: string;
  error?: string;
}

// updateUserSecrets (MCA → Backend)
export interface UpdateUserSecretsRequest {
  secrets: Record<string, string>;
}

export interface UpdateUserSecretsResponse {
  success: boolean;
  error?: string;
}

// getAuthUrl (MCA → Backend)
export interface GetAuthUrlRequest {
  provider: string;
  scopes?: string[];
  redirectUri?: string;
}

export interface GetAuthUrlResponse {
  url: string;
  state: string;
}

// reportAuthError (MCA → Backend)
export type AuthErrorType =
  | 'token_expired'
  | 'token_revoked'
  | 'refresh_failed'
  | 'invalid_credentials';

export interface ReportAuthErrorRequest {
  error: AuthErrorType;
  message?: string;
  canRetry: boolean;
}

export interface ReportAuthErrorResponse {
  action: 'retry' | 'reauth' | 'disable';
  newCredentials?: Record<string, string>;
}

// ============================================================================
// Layer 6: Agent
// ============================================================================

export type AgentAutonomy = 'assisted' | 'autonomous' | 'supervised';

export interface AgentDefinition {
  enabled: boolean;
  systemPrompt: string;
  personality?: string;
  capabilities: string[];
  autonomy: AgentAutonomy;
}

// invokeAgent (Backend → MCA)
export interface InvokeAgentRequest {
  message: string;
  context: ExecutionContext;
  conversationHistory?: AgentMessage[];
  mode: 'assisted' | 'autonomous';
}

export interface InvokeAgentResponse {
  invocationId: string;
  started: boolean;
}

// cancelAgent (Backend → MCA)
export interface CancelAgentRequest {
  invocationId: string;
  reason?: string;
}

export interface CancelAgentResponse {
  cancelled: boolean;
}

// agentMessage (MCA → Backend, notification/stream)
export interface AgentMessageNotification {
  invocationId: string;
  content: string;
  done: boolean;
}

// agentToolCall (MCA → Backend)
export interface AgentToolCallRequest {
  invocationId: string;
  tool: string;
  arguments: Record<string, unknown>;
  reasoning?: string;
}

export interface AgentToolCallResponse {
  approved: boolean;
  result?: unknown;
  error?: string;
}

// agentComplete (MCA → Backend, notification)
export interface AgentCompleteNotification {
  invocationId: string;
  status: 'success' | 'error' | 'cancelled';
  summary?: string;
  toolsUsed: string[];
  error?: string;
}

// ============================================================================
// Lifecycle
// ============================================================================

// healthCheck (Backend → MCA)
export type HealthCheckRequest = {};

export interface HealthCheckResponse {
  status: HealthStatus;
  message?: string;
  issues?: HealthIssue[];
  uptime: number;
  version: string;
}

// shutdown (Backend → MCA)
export interface ShutdownRequest {
  gracePeriodMs: number;
  reason?: string;
}

export interface ShutdownResponse {
  acknowledged: boolean;
  pendingOperations: number;
}

// reportHealth (MCA → Backend)
export interface ReportHealthRequest {
  status: HealthStatus;
  message?: string;
  issues?: HealthIssue[];
}

export interface ReportHealthResponse {
  acknowledged: boolean;
}

// ============================================================================
// Endpoint Registry
// ============================================================================

/**
 * All Backend → MCA endpoints
 */
export interface BackendToMcaEndpoints {
  // Layer 1: Tools
  callTool: { request: CallToolRequest; response: CallToolResponse };
  listTools: { request: ListToolsRequest; response: ListToolsResponse };

  // Layer 2: Events
  subscribe: { request: SubscribeRequest; response: SubscribeResponse };
  unsubscribe: { request: UnsubscribeRequest; response: UnsubscribeResponse };
  pushEvent: { request: PushEventRequest; response: PushEventResponse };

  // Layer 3: UI
  getUIResource: { request: GetUIResourceRequest; response: GetUIResourceResponse };
  updateUIState: { request: UpdateUIStateRequest; response: UpdateUIStateResponse };

  // Layer 4: Permissions
  approvalResult: { request: ApprovalResultNotification; response: void };

  // Layer 5: Auth
  pushCredentials: { request: PushCredentialsRequest; response: PushCredentialsResponse };

  // Layer 6: Agent
  invokeAgent: { request: InvokeAgentRequest; response: InvokeAgentResponse };
  cancelAgent: { request: CancelAgentRequest; response: CancelAgentResponse };

  // Lifecycle
  healthCheck: { request: HealthCheckRequest; response: HealthCheckResponse };
  shutdown: { request: ShutdownRequest; response: ShutdownResponse };
}

/**
 * All MCA → Backend endpoints
 */
export interface McaToBackendEndpoints {
  // Layer 2: Events
  emitEvent: { request: EmitEventRequest; response: EmitEventResponse };

  // Layer 3: UI
  uiReady: { request: UIReadyRequest; response: UIReadyResponse };
  uiAction: { request: UIActionRequest; response: UIActionResponse };

  // Layer 4: Permissions
  requestApproval: { request: RequestApprovalRequest; response: RequestApprovalResponse };

  // Layer 5: Auth
  getSystemSecrets: { request: GetSystemSecretsRequest; response: GetSystemSecretsResponse };
  getUserSecrets: { request: GetUserSecretsRequest; response: GetUserSecretsResponse };
  updateUserSecrets: { request: UpdateUserSecretsRequest; response: UpdateUserSecretsResponse };
  getAuthUrl: { request: GetAuthUrlRequest; response: GetAuthUrlResponse };
  reportAuthError: { request: ReportAuthErrorRequest; response: ReportAuthErrorResponse };

  // Layer 6: Agent
  agentMessage: { request: AgentMessageNotification; response: void };
  agentToolCall: { request: AgentToolCallRequest; response: AgentToolCallResponse };
  agentComplete: { request: AgentCompleteNotification; response: void };

  // Lifecycle
  reportHealth: { request: ReportHealthRequest; response: ReportHealthResponse };
}

/**
 * Type helper for endpoint names
 */
export type BackendToMcaEndpoint = keyof BackendToMcaEndpoints;
export type McaToBackendEndpoint = keyof McaToBackendEndpoints;
export type McaEndpoint = BackendToMcaEndpoint | McaToBackendEndpoint;
