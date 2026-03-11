/**
 * Teros - WebSocket Protocol
 * Strictly typed and validated with Zod
 */

import { z } from 'zod';

// ============================================================================
// BASE TYPES
// ============================================================================

export const UserIdSchema = z.string().refine((val) => val.startsWith('user_'), {
  message: 'User ID must start with "user_"',
});
export const AgentIdSchema = z.string().refine((val) => val.startsWith('agent_'), {
  message: 'Agent ID must start with "agent_"',
});
export const ChannelIdSchema = z.string();
export const MessageIdSchema = z.string();

export type UserId = z.infer<typeof UserIdSchema>;
export type AgentId = z.infer<typeof AgentIdSchema>;
export type ChannelId = z.infer<typeof ChannelIdSchema>;
export type MessageId = z.infer<typeof MessageIdSchema>;

// ============================================================================
// CHANNEL TYPES
// ============================================================================

export const ChannelStatusSchema = z.enum(['active', 'closed']);
export type ChannelStatus = z.infer<typeof ChannelStatusSchema>;

export const ChannelMetadataSchema = z.object({
  transport: z.enum(['websocket', 'telegram', 'voice']),
  sessionId: z.string().optional(),
  chatId: z.number().optional(),
  name: z.string().optional(),
  tags: z.array(z.string()).optional(),
});
export type ChannelMetadata = z.infer<typeof ChannelMetadataSchema>;

export const ChannelSchema = z.object({
  channelId: ChannelIdSchema,
  userId: UserIdSchema,
  agentId: AgentIdSchema,
  status: ChannelStatusSchema,
  metadata: ChannelMetadataSchema,
  createdAt: z.string(), // ISO 8601 datetime string
  updatedAt: z.string(),
  closedAt: z.string().optional(),
  /** Last time user read messages in this channel */
  lastReadAt: z.string().optional(),
  /** Number of unread messages (computed field, not stored) */
  unreadCount: z.number().optional(),
  /** Last message preview for list display */
  lastMessage: z
    .object({
      content: z.string(),
      timestamp: z.string(),
      role: z.enum(['user', 'assistant']).optional(),
    })
    .optional(),
  /** Agent name (computed field, not stored) */
  agentName: z.string().optional(),
  /** Agent avatar URL (computed field, not stored) */
  agentAvatarUrl: z.string().optional(),
  /** Model string (e.g., 'anthropic/claude-opus-4.5') (computed field, not stored) */
  modelString: z.string().optional(),
  /** Model display name (e.g., 'Claude Sonnet 4.5 (OpenRouter)') (computed field, not stored) */
  modelName: z.string().optional(),
  /** Provider display name (e.g., 'OpenRouter', 'Claude Max') (computed field, not stored) */
  providerName: z.string().optional(),
  /** Private channel - hidden from lists/search, deleted on close or after 15 days inactivity */
  isPrivate: z.boolean().optional(),
  /** Workspace ID if this channel belongs to a workspace */
  workspaceId: z.string().optional(),
  /** Headless mode - no user is watching. Tools with 'ask' permission are auto-denied. */
  headless: z.boolean().optional(),
  /** Channel to notify when this channel's agent starts/finishes a turn (passive/active events) */
  originChannelId: z.string().optional(),
});
export type Channel = z.infer<typeof ChannelSchema>;

// ============================================================================
// AGENT TYPES
// ============================================================================

// Agent summary (for listing)
export const AgentSummarySchema = z.object({
  agentId: AgentIdSchema,
  name: z.string(),
  fullName: z.string(),
  role: z.string(),
  intro: z.string(),
  avatarUrl: z.string().optional(),
  status: z.enum(['active', 'inactive']).optional(),
});
export type AgentSummary = z.infer<typeof AgentSummarySchema>;

// Agent config (full details)
export const AgentConfigSchema = z.object({
  agentId: AgentIdSchema,
  coreVersion: z.string(),
  config: z.object({
    systemPrompt: z.string(),
    personality: z.array(z.string()),
    voice: z
      .object({
        id: z.string(),
        provider: z.string(),
      })
      .optional(),
    preferences: z
      .object({
        responseStyle: z.enum(['concise', 'detailed', 'technical']),
        temperature: z.number().min(0).max(2),
        maxTokens: z.number().positive(),
      })
      .optional(),
  }),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

// ============================================================================
// USER APP (MCA) TYPES
// ============================================================================

export const UserAppScopeSchema = z.enum(['global', 'agent', 'channel']);
export type UserAppScope = z.infer<typeof UserAppScopeSchema>;

export const UserAppSchema = z.object({
  userId: UserIdSchema,
  agentId: AgentIdSchema.optional(),
  channelId: ChannelIdSchema.optional(),
  appName: z.string(),
  mcaName: z.string(),
  mcaConfig: z.record(z.string(), z.any()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type UserApp = z.infer<typeof UserAppSchema>;

// ============================================================================
// MESSAGE TYPES
// ============================================================================

export const MessageRoleSchema = z.enum(['user', 'assistant', 'system']);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

export const MessageContentTypeSchema = z.enum([
  'text',
  'image',
  'video',
  'audio',
  'voice',
  'file',
  'html',
  'html_file',
  'tool_execution',
  'event',
  'error',
]);
export type MessageContentType = z.infer<typeof MessageContentTypeSchema>;

// Text message content
export const TextMessageContentSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

// Image message content
export const ImageMessageContentSchema = z.object({
  type: z.literal('image'),
  url: z.string(),
  width: z.number().optional(),
  height: z.number().optional(),
  caption: z.string().optional(),
  mimeType: z.string().optional(),
  size: z.number().optional(), // bytes
});

// Video message content
export const VideoMessageContentSchema = z.object({
  type: z.literal('video'),
  url: z.string(),
  width: z.number().optional(),
  height: z.number().optional(),
  duration: z.number().optional(), // seconds
  caption: z.string().optional(),
  thumbnailUrl: z.string().optional(),
  mimeType: z.string().optional(),
  size: z.number().optional(), // bytes
});

// Audio message content (music, podcasts, sound effects - no transcription)
export const AudioMessageContentSchema = z.object({
  type: z.literal('audio'),
  url: z.string(),
  duration: z.number().optional(), // seconds
  caption: z.string().optional(),
  mimeType: z.string().optional(),
  size: z.number().optional(), // bytes
});

// Voice message content (voice notes with transcription)
// Supports either url (for stored files) or data (base64 for upload)
export const VoiceMessageContentSchema = z
  .object({
    type: z.literal('voice'),
    url: z.string().optional(), // URL to stored audio file
    data: z.string().optional(), // Base64 encoded audio data (for upload)
    duration: z.number().optional(), // seconds
    transcription: z.string().optional(), // Transcribed text (filled by backend)
    mimeType: z.string().optional(),
    size: z.number().optional(), // bytes
  })
  .refine((data) => data.url !== undefined || data.data !== undefined, {
    message: 'Either url or data must be provided',
  });

// File message content (generic file)
export const FileMessageContentSchema = z.object({
  type: z.literal('file'),
  url: z.string(),
  filename: z.string(),
  caption: z.string().optional(),
  mimeType: z.string().optional(),
  size: z.number().optional(), // bytes
});

// HTML widget content (rendered HTML/CSS in chat)
export const HtmlMessageContentSchema = z.object({
  type: z.literal('html'),
  html: z.string(),
  caption: z.string().optional(),
  height: z.number().optional(), // fixed height in pixels
});

// HTML file content (send-html-file tool — file path reference, rendered via FileViewer)
export const HtmlFileMessageContentSchema = z.object({
  type: z.literal('html_file'),
  /** Absolute path inside the agent's volume (e.g. '/workspace/mockup.html') */
  filePath: z.string(),
  caption: z.string().optional(),
});
export type HtmlFileMessageContent = z.infer<typeof HtmlFileMessageContentSchema>;

// Tool execution content (tool_call + tool_result combined)
export const ToolExecutionMessageContentSchema = z.object({
  type: z.literal('tool_execution'),
  toolCallId: z.string(),
  toolName: z.string(),
  /** MCA ID for renderer matching (e.g., 'mca.teros.bash') */
  mcaId: z.string().optional(),
  input: z.any().optional(),
  /**
   * Tool execution status:
   * - 'pending': Tool call received, waiting for permission check
   * - 'pending_permission': Waiting for user approval (ask mode)
   * - 'running': Tool is executing
   * - 'completed': Tool finished successfully
   * - 'failed': Tool execution failed
   */
  status: z.enum(['pending', 'pending_permission', 'running', 'completed', 'failed']),
  output: z.string().optional(),
  error: z.string().optional(),
  duration: z.number().optional(),
});

// Event content (system events, notifications)
export const EventMessageContentSchema = z.object({
  type: z.literal('event'),
  eventType: z.string(), // e.g., 'wake_up', 'location_changed', 'subscription_update'
  eventData: z.record(z.string(), z.any()),
  description: z.string().optional(),
});

// Error message content (for displaying errors to users)
export const ErrorMessageContentSchema = z.object({
  type: z.literal('error'),
  errorType: z.enum(['llm', 'tool', 'session', 'validation', 'network', 'unknown']),
  userMessage: z.string(),
  technicalMessage: z.string().optional(),
  context: z.record(z.string(), z.any()).optional(),
});

export const MessageContentSchema = z.union([
  TextMessageContentSchema,
  ImageMessageContentSchema,
  VideoMessageContentSchema,
  AudioMessageContentSchema,
  VoiceMessageContentSchema,
  FileMessageContentSchema,
  HtmlMessageContentSchema,
  HtmlFileMessageContentSchema,
  ToolExecutionMessageContentSchema,
  EventMessageContentSchema,
  ErrorMessageContentSchema,
]);
export type MessageContent = z.infer<typeof MessageContentSchema>;

/**
 * Message sender - identifies who sent the message
 * Works for both user messages and assistant responses
 */
export const MessageSenderTypeSchema = z.enum(['user', 'agent']);
export type MessageSenderType = z.infer<typeof MessageSenderTypeSchema>;

export const MessageSenderSchema = z.object({
  /** Type of sender: 'user' for humans, 'agent' for AI agents */
  type: MessageSenderTypeSchema,
  /** ID of the sender (userId or agentId) */
  id: z.string(),
  /** Display name of the sender (denormalized for easy rendering) */
  name: z.string(),
  /** Avatar URL of the sender (optional) */
  avatarUrl: z.string().optional(),
});
export type MessageSender = z.infer<typeof MessageSenderSchema>;

export const MessageSchema = z.object({
  messageId: MessageIdSchema,
  channelId: ChannelIdSchema,
  role: MessageRoleSchema,
  /**
   * Who sent this message. Required for all messages.
   * - For role='user': the human user or agent who wrote the message
   * - For role='assistant': the agent who responded
   */
  sender: MessageSenderSchema.optional(), // Optional for backward compatibility during migration
  // Legacy fields - kept for backward compatibility, will be removed
  userId: UserIdSchema.optional(),
  agentId: AgentIdSchema.optional(),
  content: MessageContentSchema,
  timestamp: z.string(),
  replyToId: MessageIdSchema.optional(),
  metadata: z.record(z.string(), z.any()).optional(),
});
export type Message = z.infer<typeof MessageSchema>;

// ============================================================================
// CLIENT -> SERVER MESSAGES
// ============================================================================

// Auth with credentials
export const AuthCredentialsMessageSchema = z.object({
  type: z.literal('auth'),
  method: z.literal('credentials'),
  email: z.string(),
  password: z.string().min(1),
});

// Auth with token
export const AuthTokenMessageSchema = z.object({
  type: z.literal('auth'),
  method: z.literal('token'),
  sessionToken: z.string(),
});

export const AuthMessageSchema = z.union([AuthCredentialsMessageSchema, AuthTokenMessageSchema]);
export type AuthMessage = z.infer<typeof AuthMessageSchema>;

export const ListChannelsMessageSchema = z.object({
  type: z.literal('list_channels'),
  status: ChannelStatusSchema.optional(),
  /** Filter by workspace ID (undefined = global only, null = all) */
  workspaceId: z.string().nullish(),
  /** Request ID for matching response to request */
  requestId: z.string().optional(),
});
export type ListChannelsMessage = z.infer<typeof ListChannelsMessageSchema>;

export const ListAgentsMessageSchema = z.object({
  type: z.literal('list_agents'),
});
export type ListAgentsMessage = z.infer<typeof ListAgentsMessageSchema>;

export const CreateAgentMessageSchema = z.object({
  type: z.literal('create_agent'),
  data: z.object({
    coreId: z.string().min(1),
    name: z.string().min(1).max(50),
    fullName: z.string().min(1).max(100),
    role: z.string().min(1).max(200),
    intro: z.string().min(1).max(2000),
    avatarUrl: z.string().optional(),
    customization: z
      .object({
        personalityTweaks: z.array(z.string()).optional(),
        additionalCapabilities: z.array(z.string()).optional(),
        responseStyle: z.string().optional(),
      })
      .optional(),
  }),
});
export type CreateAgentMessage = z.infer<typeof CreateAgentMessageSchema>;

export const GenerateAgentProfileMessageSchema = z.object({
  type: z.literal('generate_agent_profile'),
  data: z.object({
    coreId: z.string().min(1),
    excludeNames: z.array(z.string()).optional(),
  }),
});
export type GenerateAgentProfileMessage = z.infer<typeof GenerateAgentProfileMessageSchema>;

export const UpdateAgentMessageSchema = z.object({
  type: z.literal('update_agent'),
  data: z.object({
    agentId: AgentIdSchema,
    name: z.string().min(1).max(50).optional(),
    fullName: z.string().min(1).max(100).optional(),
    role: z.string().min(1).max(100).optional(),
    intro: z.string().max(2000).optional(),
    avatarUrl: z.string().optional(),
    customization: z
      .object({
        personalityTweaks: z.array(z.string()).optional(),
        additionalCapabilities: z.array(z.string()).optional(),
        responseStyle: z.string().optional(),
      })
      .optional(),
  }),
});
export type UpdateAgentMessage = z.infer<typeof UpdateAgentMessageSchema>;

export const DeleteAgentMessageSchema = z.object({
  type: z.literal('delete_agent'),
  data: z.object({
    agentId: AgentIdSchema,
  }),
});
export type DeleteAgentMessage = z.infer<typeof DeleteAgentMessageSchema>;

export const ListAppsMessageSchema = z.object({
  type: z.literal('list_apps'),
});
export type ListAppsMessage = z.infer<typeof ListAppsMessageSchema>;

export const CreateChannelMessageSchema = z.object({
  type: z.literal('create_channel'),
  agentId: AgentIdSchema,
  metadata: ChannelMetadataSchema.partial().optional(),
  /** Workspace ID if creating channel within a workspace */
  workspaceId: z.string().optional(),
});
export type CreateChannelMessage = z.infer<typeof CreateChannelMessageSchema>;

// Create channel AND send first message in one operation
// This avoids race conditions in the frontend when starting a new conversation
export const CreateChannelWithMessageSchema = z.object({
  type: z.literal('create_channel_with_message'),
  agentId: AgentIdSchema,
  content: MessageContentSchema,
  metadata: ChannelMetadataSchema.partial().optional(),
  /** Workspace ID if creating channel within a workspace */
  workspaceId: z.string().optional(),
});
export type CreateChannelWithMessage = z.infer<typeof CreateChannelWithMessageSchema>;

export const GetChannelMessageSchema = z.object({
  type: z.literal('get_channel'),
  channelId: ChannelIdSchema,
});
export type GetChannelMessage = z.infer<typeof GetChannelMessageSchema>;

export const CloseChannelMessageSchema = z.object({
  type: z.literal('close_channel'),
  channelId: ChannelIdSchema,
});
export type CloseChannelMessage = z.infer<typeof CloseChannelMessageSchema>;

export const ReopenChannelMessageSchema = z.object({
  type: z.literal('reopen_channel'),
  channelId: ChannelIdSchema,
});
export type ReopenChannelMessage = z.infer<typeof ReopenChannelMessageSchema>;

export const SetChannelPrivateMessageSchema = z.object({
  type: z.literal('set_channel_private'),
  channelId: ChannelIdSchema,
  isPrivate: z.boolean(),
});
export type SetChannelPrivateMessage = z.infer<typeof SetChannelPrivateMessageSchema>;

export const RenameChannelMessageSchema = z.object({
  type: z.literal('rename_channel'),
  channelId: ChannelIdSchema,
  name: z.string().min(1).max(100),
});
export type RenameChannelMessage = z.infer<typeof RenameChannelMessageSchema>;

export const AutonameChannelMessageSchema = z.object({
  type: z.literal('autoname_channel'),
  channelId: ChannelIdSchema,
});
export type AutonameChannelMessage = z.infer<typeof AutonameChannelMessageSchema>;

export const SendMessageRequestSchema = z.object({
  type: z.literal('send_message'),
  channelId: ChannelIdSchema,
  content: MessageContentSchema,
});
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;

export const GetMessagesRequestSchema = z.object({
  type: z.literal('get_messages'),
  channelId: ChannelIdSchema,
  limit: z.number().positive().max(100).optional(),
  before: MessageIdSchema.optional(),
});
export type GetMessagesRequest = z.infer<typeof GetMessagesRequestSchema>;

export const SubscribeChannelMessageSchema = z.object({
  type: z.literal('subscribe_channel'),
  channelId: ChannelIdSchema,
});
export type SubscribeChannelMessage = z.infer<typeof SubscribeChannelMessageSchema>;

export const UnsubscribeChannelMessageSchema = z.object({
  type: z.literal('unsubscribe_channel'),
  channelId: ChannelIdSchema,
});
export type UnsubscribeChannelMessage = z.infer<typeof UnsubscribeChannelMessageSchema>;

export const MarkChannelReadMessageSchema = z.object({
  type: z.literal('mark_channel_read'),
  channelId: ChannelIdSchema,
});
export type MarkChannelReadMessage = z.infer<typeof MarkChannelReadMessageSchema>;

export const TypingStartMessageSchema = z.object({
  type: z.literal('typing_start'),
  channelId: ChannelIdSchema,
});

export const TypingStopMessageSchema = z.object({
  type: z.literal('typing_stop'),
  channelId: ChannelIdSchema,
});

export const TypingIndicatorMessageSchema = z.union([
  TypingStartMessageSchema,
  TypingStopMessageSchema,
]);
export type TypingIndicatorMessage = z.infer<typeof TypingIndicatorMessageSchema>;

// Agent App Access Messages
export const GetAgentAppsMessageSchema = z.object({
  type: z.literal('get_agent_apps'),
  agentId: AgentIdSchema,
});
export type GetAgentAppsMessage = z.infer<typeof GetAgentAppsMessageSchema>;

export const GrantAppAccessMessageSchema = z.object({
  type: z.literal('grant_app_access'),
  agentId: AgentIdSchema,
  appId: z.string(),
});
export type GrantAppAccessMessage = z.infer<typeof GrantAppAccessMessageSchema>;

export const RevokeAppAccessMessageSchema = z.object({
  type: z.literal('revoke_app_access'),
  agentId: AgentIdSchema,
  appId: z.string(),
});
export type RevokeAppAccessMessage = z.infer<typeof RevokeAppAccessMessageSchema>;

// Catalog / App Store Messages
export const ListCatalogMessageSchema = z.object({
  type: z.literal('list_catalog'),
});
export type ListCatalogMessage = z.infer<typeof ListCatalogMessageSchema>;

export const InstallAppMessageSchema = z.object({
  type: z.literal('install_app'),
  mcaId: z.string(),
  name: z.string().optional(),
});
export type InstallAppMessage = z.infer<typeof InstallAppMessageSchema>;

export const UninstallAppMessageSchema = z.object({
  type: z.literal('uninstall_app'),
  appId: z.string(),
});
export type UninstallAppMessage = z.infer<typeof UninstallAppMessageSchema>;

export const RenameAppMessageSchema = z.object({
  type: z.literal('rename_app'),
  appId: z.string(),
  name: z.string().min(1).max(50),
});
export type RenameAppMessage = z.infer<typeof RenameAppMessageSchema>;

// ============================================================================
// DIRECT TOOL EXECUTION MESSAGES
// ============================================================================

/**
 * Execute a tool directly from the frontend (without going through agent/LLM).
 * Used by UI views (Tasks, Calendar, etc.) to interact with MCAs.
 */
export const ExecuteToolMessageSchema = z.object({
  type: z.literal('execute_tool'),
  requestId: z.string().optional(),
  appId: z.string(),
  tool: z.string(),
  input: z.record(z.any()).optional(),
});
export type ExecuteToolMessage = z.infer<typeof ExecuteToolMessageSchema>;

/**
 * List available tools for an app.
 */
export const ListAppToolsMessageSchema = z.object({
  type: z.literal('list_app_tools'),
  requestId: z.string().optional(),
  appId: z.string(),
});
export type ListAppToolsMessage = z.infer<typeof ListAppToolsMessageSchema>;

// Admin: List All MCAs (no filters)
export const ListAllMcasMessageSchema = z.object({
  type: z.literal('list_all_mcas'),
});
export type ListAllMcasMessage = z.infer<typeof ListAllMcasMessageSchema>;

// Admin: List Models
export const ListModelsMessageSchema = z.object({
  type: z.literal('list_models'),
  status: z.enum(['active', 'deprecated', 'disabled']).optional(),
});
export type ListModelsMessage = z.infer<typeof ListModelsMessageSchema>;

// Admin: List Agent Cores
export const ListAgentCoresMessageSchema = z.object({
  type: z.literal('list_agent_cores'),
  status: z.enum(['active', 'inactive']).optional(),
});
export type ListAgentCoresMessage = z.infer<typeof ListAgentCoresMessageSchema>;

// Admin: Update Agent Core
export const UpdateAgentCoreMessageSchema = z.object({
  type: z.literal('update_agent_core'),
  coreId: z.string(),
  updates: z.object({
    modelId: z.string().optional(),
    systemPrompt: z.string().optional(),
    modelOverrides: z
      .object({
        temperature: z.number().min(0).max(2).optional(),
        maxTokens: z.number().positive().optional(),
      })
      .optional(),
    status: z.enum(['active', 'inactive']).optional(),
  }),
});
export type UpdateAgentCoreMessage = z.infer<typeof UpdateAgentCoreMessageSchema>;

// Admin: Update MCA availability
export const UpdateMcaMessageSchema = z.object({
  type: z.literal('update_mca'),
  mcaId: z.string(),
  updates: z.object({
    enabled: z.boolean().optional(),
    hidden: z.boolean().optional(),
    system: z.boolean().optional(),
    role: z.enum(['user', 'admin', 'super']).optional(),
  }),
});
export type UpdateMcaMessage = z.infer<typeof UpdateMcaMessageSchema>;

// ============================================================================
// MCA AUTH MESSAGES
// ============================================================================

// Get app auth status
export const GetAppAuthStatusMessageSchema = z.object({
  type: z.literal('get_app_auth_status'),
  appId: z.string(),
});
export type GetAppAuthStatusMessage = z.infer<typeof GetAppAuthStatusMessageSchema>;

// Configure app credentials (API key)
export const ConfigureAppCredentialsMessageSchema = z.object({
  type: z.literal('configure_app_credentials'),
  appId: z.string(),
  credentials: z.record(z.string(), z.string()),
});
export type ConfigureAppCredentialsMessage = z.infer<typeof ConfigureAppCredentialsMessageSchema>;

// Disconnect app auth (OAuth)
export const DisconnectAppAuthMessageSchema = z.object({
  type: z.literal('disconnect_app_auth'),
  appId: z.string(),
});
export type DisconnectAppAuthMessage = z.infer<typeof DisconnectAppAuthMessageSchema>;

// ============================================================================
// TOOL PERMISSION MESSAGES
// ============================================================================

// Tool permission response (user grants/denies tool execution)
export const ToolPermissionResponseMessageSchema = z.object({
  type: z.literal('tool_permission_response'),
  requestId: z.string(),
  granted: z.boolean(),
});
export type ToolPermissionResponseMessage = z.infer<typeof ToolPermissionResponseMessageSchema>;

// Get app tools with permissions
export const GetAppToolsMessageSchema = z.object({
  type: z.literal('get_app_tools'),
  appId: z.string(),
});
export type GetAppToolsMessage = z.infer<typeof GetAppToolsMessageSchema>;

// Update all permissions for an app (deprecated - use update_tool_permission or set_all_tool_permissions)
export const UpdateAppPermissionsMessageSchema = z.object({
  type: z.literal('update_app_permissions'),
  appId: z.string(),
  permissions: z.object({
    defaultPermission: z.enum(['allow', 'ask', 'forbid']),
    tools: z.record(z.string(), z.enum(['allow', 'ask', 'forbid'])).optional(),
  }),
});
export type UpdateAppPermissionsMessage = z.infer<typeof UpdateAppPermissionsMessageSchema>;

// Update a single tool's permission
export const UpdateToolPermissionMessageSchema = z.object({
  type: z.literal('update_tool_permission'),
  appId: z.string(),
  toolName: z.string(),
  permission: z.enum(['allow', 'ask', 'forbid']),
});
export type UpdateToolPermissionMessage = z.infer<typeof UpdateToolPermissionMessageSchema>;

// Set all tools to the same permission
export const SetAllToolPermissionsMessageSchema = z.object({
  type: z.literal('set_all_tool_permissions'),
  appId: z.string(),
  permission: z.enum(['allow', 'ask', 'forbid']),
});
export type SetAllToolPermissionsMessage = z.infer<typeof SetAllToolPermissionsMessageSchema>;

// ============================================================================
// SEARCH MESSAGES
// ============================================================================

// Search conversations by text content
export const SearchConversationsMessageSchema = z.object({
  type: z.literal('search_conversations'),
  query: z.string().min(2),
  limit: z.number().positive().max(100).optional(),
});
export type SearchConversationsMessage = z.infer<typeof SearchConversationsMessageSchema>;

// ============================================================================
// USER PROFILE MESSAGES
// ============================================================================

// Get current user profile
export const GetProfileMessageSchema = z.object({
  type: z.literal('get_profile'),
});
export type GetProfileMessage = z.infer<typeof GetProfileMessageSchema>;

// Update user profile
export const UpdateProfileMessageSchema = z.object({
  type: z.literal('update_profile'),
  updates: z.object({
    displayName: z.string().min(1).max(100).optional(),
    avatarUrl: z.string().optional(),
    description: z.string().max(1000).optional(),
    locale: z.string().max(10).optional(),
    timezone: z.string().max(50).optional(),
  }),
});
export type UpdateProfileMessage = z.infer<typeof UpdateProfileMessageSchema>;

// ============================================================================
// ADMIN MESSAGES (require admin/super role)
// ============================================================================

// List all users (admin only)
export const AdminListUsersMessageSchema = z.object({
  type: z.literal('admin_list_users'),
});
export type AdminListUsersMessage = z.infer<typeof AdminListUsersMessageSchema>;

// Get user details (admin only)
export const AdminGetUserMessageSchema = z.object({
  type: z.literal('admin_get_user'),
  targetUserId: z.string(),
});
export type AdminGetUserMessage = z.infer<typeof AdminGetUserMessageSchema>;

// Update user role (super only)
export const AdminUpdateUserRoleMessageSchema = z.object({
  type: z.literal('admin_update_user_role'),
  targetUserId: z.string(),
  role: z.enum(['user', 'admin', 'super']),
});
export type AdminUpdateUserRoleMessage = z.infer<typeof AdminUpdateUserRoleMessageSchema>;

// Update user status (admin only)
export const AdminUpdateUserStatusMessageSchema = z.object({
  type: z.literal('admin_update_user_status'),
  targetUserId: z.string(),
  status: z.enum(['active', 'suspended', 'pending_verification']),
});
export type AdminUpdateUserStatusMessage = z.infer<typeof AdminUpdateUserStatusMessageSchema>;

// ============================================================================
// RELIABLE PROTOCOL MESSAGES (Heartbeat, ACKs)
// ============================================================================

// Ping message (Client → Server) - Heartbeat
export const PingMessageSchema = z.object({
  type: z.literal('ping'),
  clientTime: z.number(), // Date.now() from client
});
export type PingMessage = z.infer<typeof PingMessageSchema>;

// ============================================================================
// INVITATION SYSTEM MESSAGES (Client → Server)
// ============================================================================

// Get invitation status
export const GetInvitationStatusMessageSchema = z.object({
  type: z.literal('get_invitation_status'),
});
export type GetInvitationStatusMessage = z.infer<typeof GetInvitationStatusMessageSchema>;

// Send invitation
export const SendInvitationMessageSchema = z.object({
  type: z.literal('send_invitation'),
  email: z.string().email(),
});
export type SendInvitationMessage = z.infer<typeof SendInvitationMessageSchema>;

// Get sent invitations
export const GetInvitationsSentMessageSchema = z.object({
  type: z.literal('get_invitations_sent'),
});
export type GetInvitationsSentMessage = z.infer<typeof GetInvitationsSentMessageSchema>;

// Get invitable users
export const GetInvitableUsersMessageSchema = z.object({
  type: z.literal('get_invitable_users'),
  limit: z.number().positive().max(100).optional(),
});
export type GetInvitableUsersMessage = z.infer<typeof GetInvitableUsersMessageSchema>;

// Revoke invitation
export const RevokeInvitationMessageSchema = z.object({
  type: z.literal('revoke_invitation'),
  fromUserId: z.string(),
  toUserId: z.string(),
});
export type RevokeInvitationMessage = z.infer<typeof RevokeInvitationMessageSchema>;

// ============================================================================
// WORKSPACE MESSAGES (Client → Server)
// ============================================================================

// List workspaces
export const ListWorkspacesMessageSchema = z.object({
  type: z.literal('list_workspaces'),
});
export type ListWorkspacesMessage = z.infer<typeof ListWorkspacesMessageSchema>;

// Create workspace
export const CreateWorkspaceMessageSchema = z.object({
  type: z.literal('create_workspace'),
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
});
export type CreateWorkspaceMessage = z.infer<typeof CreateWorkspaceMessageSchema>;

// Get workspace details
export const GetWorkspaceMessageSchema = z.object({
  type: z.literal('get_workspace'),
  workspaceId: z.string(),
});
export type GetWorkspaceMessage = z.infer<typeof GetWorkspaceMessageSchema>;

// Update workspace
export const UpdateWorkspaceMessageSchema = z.object({
  type: z.literal('update_workspace'),
  workspaceId: z.string(),
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  context: z.string().max(50000).optional(), // Large text for system prompt injection
});
export type UpdateWorkspaceMessage = z.infer<typeof UpdateWorkspaceMessageSchema>;

// Archive workspace
export const ArchiveWorkspaceMessageSchema = z.object({
  type: z.literal('archive_workspace'),
  workspaceId: z.string(),
});
export type ArchiveWorkspaceMessage = z.infer<typeof ArchiveWorkspaceMessageSchema>;

// List workspace apps
export const ListWorkspaceAppsMessageSchema = z.object({
  type: z.literal('list_workspace_apps'),
  workspaceId: z.string(),
});
export type ListWorkspaceAppsMessage = z.infer<typeof ListWorkspaceAppsMessageSchema>;

// Install app in workspace
export const InstallWorkspaceAppMessageSchema = z.object({
  type: z.literal('install_workspace_app'),
  workspaceId: z.string(),
  mcaId: z.string(),
  name: z.string().optional(),
  mountPath: z.string().optional(),
});
export type InstallWorkspaceAppMessage = z.infer<typeof InstallWorkspaceAppMessageSchema>;

// Provider messages (user-managed LLM providers)
export const ListProvidersMessageSchema = z.object({
  type: z.literal('list_providers'),
});
export type ListProvidersMessage = z.infer<typeof ListProvidersMessageSchema>;

export const AddProviderMessageSchema = z.object({
  type: z.literal('add_provider'),
  providerType: z.string(),
  displayName: z.string(),
  config: z.record(z.any()).optional(),
  auth: z.object({
    apiKey: z.string().optional(),
  }).optional(),
});
export type AddProviderMessage = z.infer<typeof AddProviderMessageSchema>;

export const TestProviderMessageSchema = z.object({
  type: z.literal('test_provider'),
  providerId: z.string(),
});
export type TestProviderMessage = z.infer<typeof TestProviderMessageSchema>;

export const UpdateProviderMessageSchema = z.object({
  type: z.literal('update_provider'),
  providerId: z.string(),
  displayName: z.string().optional(),
  priority: z.number().optional(),
  status: z.enum(['active', 'disabled']).optional(),
});
export type UpdateProviderMessage = z.infer<typeof UpdateProviderMessageSchema>;

export const DeleteProviderMessageSchema = z.object({
  type: z.literal('delete_provider'),
  providerId: z.string(),
});
export type DeleteProviderMessage = z.infer<typeof DeleteProviderMessageSchema>;

export const ListAgentProvidersMessageSchema = z.object({
  type: z.literal('list_agent_providers'),
  agentId: z.string(),
});
export type ListAgentProvidersMessage = z.infer<typeof ListAgentProvidersMessageSchema>;

export const SetAgentProvidersMessageSchema = z.object({
  type: z.literal('set_agent_providers'),
  agentId: z.string(),
  availableProviders: z.array(z.string()),
});
export type SetAgentProvidersMessage = z.infer<typeof SetAgentProvidersMessageSchema>;

export const SetAgentPreferredProviderMessageSchema = z.object({
  type: z.literal('set_agent_preferred_provider'),
  agentId: z.string(),
  providerId: z.string().nullable(),
});
export type SetAgentPreferredProviderMessage = z.infer<typeof SetAgentPreferredProviderMessageSchema>;

// Provider OAuth messages
export const StartProviderOAuthMessageSchema = z.object({
  type: z.literal('start_provider_oauth'),
  providerType: z.string(),
});
export type StartProviderOAuthMessage = z.infer<typeof StartProviderOAuthMessageSchema>;

export const CompleteProviderOAuthMessageSchema = z.object({
  type: z.literal('complete_provider_oauth'),
  callbackUrl: z.string(),
  verifier: z.string(),
});
export type CompleteProviderOAuthMessage = z.infer<typeof CompleteProviderOAuthMessageSchema>;

// ============================================================================
// BOARD / PROJECT / TASK MESSAGES
// ============================================================================

export const CreateProjectMessageSchema = z.object({
  type: z.literal('create_project'),
  workspaceId: z.string(),
  name: z.string(),
  description: z.string().optional(),
});
export type CreateProjectMessage = z.infer<typeof CreateProjectMessageSchema>;

export const ListProjectsMessageSchema = z.object({
  type: z.literal('list_projects'),
  workspaceId: z.string(),
});
export type ListProjectsMessage = z.infer<typeof ListProjectsMessageSchema>;

export const GetProjectMessageSchema = z.object({
  type: z.literal('get_project'),
  projectId: z.string(),
});
export type GetProjectMessage = z.infer<typeof GetProjectMessageSchema>;

export const UpdateProjectMessageSchema = z.object({
  type: z.literal('update_project'),
  projectId: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
});
export type UpdateProjectMessage = z.infer<typeof UpdateProjectMessageSchema>;

export const DeleteProjectMessageSchema = z.object({
  type: z.literal('delete_project'),
  projectId: z.string(),
});
export type DeleteProjectMessage = z.infer<typeof DeleteProjectMessageSchema>;

export const GetBoardMessageSchema = z.object({
  type: z.literal('get_board'),
  projectId: z.string(),
});
export type GetBoardMessage = z.infer<typeof GetBoardMessageSchema>;

export const GetBoardSummaryMessageSchema = z.object({
  type: z.literal('get_board_summary'),
  projectId: z.string(),
});
export type GetBoardSummaryMessage = z.infer<typeof GetBoardSummaryMessageSchema>;

export const UpdateBoardConfigMessageSchema = z.object({
  type: z.literal('update_board_config'),
  projectId: z.string(),
  config: z.any(),
});
export type UpdateBoardConfigMessage = z.infer<typeof UpdateBoardConfigMessageSchema>;

export const CreateTaskMessageSchema = z.object({
  type: z.literal('create_task'),
  projectId: z.string(),
  title: z.string(),
  description: z.string().optional(),
  priority: z.enum(['urgent', 'high', 'medium', 'low']).optional(),
  tags: z.array(z.string()).optional(),
  assignedAgentId: z.string().optional(),
  columnId: z.string().optional(),
  parentTaskId: z.string().optional(),
  blocked_by: z.array(z.string()).optional(),
});
export type CreateTaskMessage = z.infer<typeof CreateTaskMessageSchema>;

export const BatchCreateTasksMessageSchema = z.object({
  type: z.literal('batch_create_tasks'),
  projectId: z.string(),
  tasks: z.array(z.object({
    title: z.string(),
    description: z.string().optional(),
    priority: z.enum(['urgent', 'high', 'medium', 'low']).optional(),
    tags: z.array(z.string()).optional(),
    assignedAgentId: z.string().optional(),
    columnId: z.string().optional(),
    parentTaskId: z.string().optional(),
    blocked_by: z.array(z.string()).optional(),
  })),
});
export type BatchCreateTasksMessage = z.infer<typeof BatchCreateTasksMessageSchema>;

export const GetTaskMessageSchema = z.object({
  type: z.literal('get_task'),
  taskId: z.string(),
});
export type GetTaskMessage = z.infer<typeof GetTaskMessageSchema>;

export const ListTasksMessageSchema = z.object({
  type: z.literal('list_tasks'),
  projectId: z.string(),
  columnId: z.string().optional(),
  assignedAgentId: z.string().optional(),
  priority: z.enum(['urgent', 'high', 'medium', 'low']).optional(),
  tags: z.array(z.string()).optional(),
});
export type ListTasksMessage = z.infer<typeof ListTasksMessageSchema>;

export const UpdateTaskMessageSchema = z.object({
  type: z.literal('update_task'),
  taskId: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  priority: z.enum(['urgent', 'high', 'medium', 'low']).optional(),
  tags: z.array(z.string()).optional(),
  assignedAgentId: z.string().nullable().optional(),
  blocked_by: z.array(z.string()).optional(),
});
export type UpdateTaskMessage = z.infer<typeof UpdateTaskMessageSchema>;

export const MoveTaskMessageSchema = z.object({
  type: z.literal('move_task'),
  taskId: z.string(),
  columnId: z.string(),
  position: z.number().optional(),
});
export type MoveTaskMessage = z.infer<typeof MoveTaskMessageSchema>;

export const AssignTaskMessageSchema = z.object({
  type: z.literal('assign_task'),
  taskId: z.string(),
  agentId: z.string().nullable().optional(),
});
export type AssignTaskMessage = z.infer<typeof AssignTaskMessageSchema>;

export const StartTaskMessageSchema = z.object({
  type: z.literal('start_task'),
  taskId: z.string(),
  agentId: z.string().optional(),
});
export type StartTaskMessage = z.infer<typeof StartTaskMessageSchema>;

export const LinkConversationMessageSchema = z.object({
  type: z.literal('link_conversation'),
  taskId: z.string(),
  channelId: z.string(),
});
export type LinkConversationMessage = z.infer<typeof LinkConversationMessageSchema>;

export const DeleteTaskMessageSchema = z.object({
  type: z.literal('delete_task'),
  taskId: z.string(),
});
export type DeleteTaskMessage = z.infer<typeof DeleteTaskMessageSchema>;

// Runner commands (ownership-validated)
export const MoveMyTaskMessageSchema = z.object({
  type: z.literal('move_my_task'),
  taskId: z.string(),
  columnId: z.string(),
  position: z.number().optional(),
  agentId: z.string(),
});
export type MoveMyTaskMessage = z.infer<typeof MoveMyTaskMessageSchema>;

export const UpdateMyTaskStatusMessageSchema = z.object({
  type: z.literal('update_my_task_status'),
  taskId: z.string(),
  status: z.string(),
  agentId: z.string(),
});
export type UpdateMyTaskStatusMessage = z.infer<typeof UpdateMyTaskStatusMessageSchema>;

export const AddMyProgressNoteMessageSchema = z.object({
  type: z.literal('add_my_progress_note'),
  taskId: z.string(),
  text: z.string(),
  agentId: z.string(),
});
export type AddMyProgressNoteMessage = z.infer<typeof AddMyProgressNoteMessageSchema>;

// Manager commands
export const UpdateTaskStatusMessageSchema = z.object({
  type: z.literal('update_task_status'),
  taskId: z.string(),
  status: z.string(),
  actor: z.string(),
});
export type UpdateTaskStatusMessage = z.infer<typeof UpdateTaskStatusMessageSchema>;

export const AddProgressNoteMessageSchema = z.object({
  type: z.literal('add_progress_note'),
  taskId: z.string(),
  text: z.string(),
  actor: z.string(),
});
export type AddProgressNoteMessage = z.infer<typeof AddProgressNoteMessageSchema>;

export const GetTasksByAgentMessageSchema = z.object({
  type: z.literal('get_tasks_by_agent'),
  workspaceId: z.string(),
  agentId: z.string(),
});
export type GetTasksByAgentMessage = z.infer<typeof GetTasksByAgentMessageSchema>;

export const GetTaskByChannelMessageSchema = z.object({
  type: z.literal('get_task_by_channel'),
  channelId: z.string(),
});
export type GetTaskByChannelMessage = z.infer<typeof GetTaskByChannelMessageSchema>;

export const SubscribeBoardMessageSchema = z.object({
  type: z.literal('subscribe_board'),
  boardId: z.string(),
});
export type SubscribeBoardMessage = z.infer<typeof SubscribeBoardMessageSchema>;

export const UnsubscribeBoardMessageSchema = z.object({
  type: z.literal('unsubscribe_board'),
  boardId: z.string(),
});
export type UnsubscribeBoardMessage = z.infer<typeof UnsubscribeBoardMessageSchema>;

// ============================================================================
// FILE WATCHER MESSAGES (Client → Server)
// ============================================================================

/** Client requests backend to watch a file for changes */
export const WatchFileMessageSchema = z.object({
  type: z.literal('watch_file'),
  /** Absolute path inside the agent's volume (e.g. '/workspace/mockup.html') */
  filePath: z.string(),
  /** Channel ID — used to resolve the correct volume / user ownership */
  channelId: z.string(),
});
export type WatchFileMessage = z.infer<typeof WatchFileMessageSchema>;

/** Client requests backend to stop watching a file */
export const UnwatchFileMessageSchema = z.object({
  type: z.literal('unwatch_file'),
  filePath: z.string(),
});
export type UnwatchFileMessage = z.infer<typeof UnwatchFileMessageSchema>;

// ============================================================================
// FILE WATCHER MESSAGES (Server → Client)
// ============================================================================

/** Server pushes new file content when the watched file changes */
export const FileChangedEventSchema = z.object({
  type: z.literal('file_changed'),
  filePath: z.string(),
  /** Full HTML content of the file */
  content: z.string(),
});
export type FileChangedEvent = z.infer<typeof FileChangedEventSchema>;

// ============================================================================
// WS FRAMEWORK MESSAGES (new protocol — type: "request" | "subscribe" | "unsubscribe")
// ============================================================================

/** Passthrough schema for WsFramework messages — validated in depth by WsRouter */
export const WsFrameworkMessageSchema = z.object({
  type: z.enum(["request", "subscribe", "unsubscribe"]),
  requestId: z.string(),
}).passthrough();
export type WsFrameworkMessage = z.infer<typeof WsFrameworkMessageSchema>;

// Union of all client messages
export const ClientMessageSchema = z.union([
  AuthMessageSchema,
  ListAgentsMessageSchema,
  CreateAgentMessageSchema,
  GenerateAgentProfileMessageSchema,
  UpdateAgentMessageSchema,
  DeleteAgentMessageSchema,
  ListAppsMessageSchema,
  ListChannelsMessageSchema,
  CreateChannelMessageSchema,
  CreateChannelWithMessageSchema,
  GetChannelMessageSchema,
  CloseChannelMessageSchema,
  ReopenChannelMessageSchema,
  SetChannelPrivateMessageSchema,
  RenameChannelMessageSchema,
  AutonameChannelMessageSchema,
  SendMessageRequestSchema,
  GetMessagesRequestSchema,
  SubscribeChannelMessageSchema,
  UnsubscribeChannelMessageSchema,
  MarkChannelReadMessageSchema,
  TypingIndicatorMessageSchema,
  GetAgentAppsMessageSchema,
  GrantAppAccessMessageSchema,
  RevokeAppAccessMessageSchema,
  ListCatalogMessageSchema,
  ListAllMcasMessageSchema,
  InstallAppMessageSchema,
  UninstallAppMessageSchema,
  RenameAppMessageSchema,
  // Direct tool execution
  ExecuteToolMessageSchema,
  ListAppToolsMessageSchema,
  ListModelsMessageSchema,
  ListAgentCoresMessageSchema,
  UpdateAgentCoreMessageSchema,
  UpdateMcaMessageSchema,

  // MCA Auth messages
  GetAppAuthStatusMessageSchema,
  ConfigureAppCredentialsMessageSchema,
  DisconnectAppAuthMessageSchema,
  // Tool permission messages
  ToolPermissionResponseMessageSchema,
  GetAppToolsMessageSchema,
  UpdateAppPermissionsMessageSchema,
  UpdateToolPermissionMessageSchema,
  SetAllToolPermissionsMessageSchema,
  // Search messages
  SearchConversationsMessageSchema,
  // User profile messages
  GetProfileMessageSchema,
  UpdateProfileMessageSchema,
  // Reliable protocol messages
  PingMessageSchema,
  // Admin messages
  AdminListUsersMessageSchema,
  AdminGetUserMessageSchema,
  AdminUpdateUserRoleMessageSchema,
  AdminUpdateUserStatusMessageSchema,
  // Invitation messages
  GetInvitationStatusMessageSchema,
  SendInvitationMessageSchema,
  GetInvitationsSentMessageSchema,
  GetInvitableUsersMessageSchema,
  RevokeInvitationMessageSchema,
  // Workspace messages
  ListWorkspacesMessageSchema,
  CreateWorkspaceMessageSchema,
  GetWorkspaceMessageSchema,
  UpdateWorkspaceMessageSchema,
  ArchiveWorkspaceMessageSchema,
  ListWorkspaceAppsMessageSchema,
  InstallWorkspaceAppMessageSchema,
  // Provider messages
  ListProvidersMessageSchema,
  AddProviderMessageSchema,
  TestProviderMessageSchema,
  UpdateProviderMessageSchema,
  DeleteProviderMessageSchema,
  ListAgentProvidersMessageSchema,
  SetAgentProvidersMessageSchema,
  SetAgentPreferredProviderMessageSchema,
  StartProviderOAuthMessageSchema,
  CompleteProviderOAuthMessageSchema,
  // Board/Project/Task messages
  CreateProjectMessageSchema,
  ListProjectsMessageSchema,
  GetProjectMessageSchema,
  UpdateProjectMessageSchema,
  DeleteProjectMessageSchema,
  GetBoardMessageSchema,
  GetBoardSummaryMessageSchema,
  UpdateBoardConfigMessageSchema,
  CreateTaskMessageSchema,
  BatchCreateTasksMessageSchema,
  GetTaskMessageSchema,
  ListTasksMessageSchema,
  UpdateTaskMessageSchema,
  MoveTaskMessageSchema,
  AssignTaskMessageSchema,
  StartTaskMessageSchema,
  LinkConversationMessageSchema,
  DeleteTaskMessageSchema,
  MoveMyTaskMessageSchema,
  UpdateMyTaskStatusMessageSchema,
  AddMyProgressNoteMessageSchema,
  UpdateTaskStatusMessageSchema,
  AddProgressNoteMessageSchema,
  GetTasksByAgentMessageSchema,
  GetTaskByChannelMessageSchema,
  SubscribeBoardMessageSchema,
  UnsubscribeBoardMessageSchema,
  // File watcher messages
  WatchFileMessageSchema,
  UnwatchFileMessageSchema,
  // WsFramework messages (new protocol)
  WsFrameworkMessageSchema,
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// ============================================================================
// SERVER -> CLIENT MESSAGES
// ============================================================================

export const AuthSuccessMessageSchema = z.object({
  type: z.literal('auth_success'),
  userId: UserIdSchema,
  sessionToken: z.string(),
  role: z.enum(['user', 'admin', 'super']).optional(),
});
export type AuthSuccessMessage = z.infer<typeof AuthSuccessMessageSchema>;

export const AuthErrorMessageSchema = z.object({
  type: z.literal('auth_error'),
  error: z.string(),
});
export type AuthErrorMessage = z.infer<typeof AuthErrorMessageSchema>;

export const ChannelsListMessageSchema = z.object({
  type: z.literal('channels_list'),
  channels: z.array(ChannelSchema),
  workspaceId: z.string().optional(),
  /** Echo of the requestId from the list_channels request */
  requestId: z.string().optional(),
});
export type ChannelsListMessage = z.infer<typeof ChannelsListMessageSchema>;

export const ChannelCreatedMessageSchema = z.object({
  type: z.literal('channel_created'),
  channelId: ChannelIdSchema,
  agentId: AgentIdSchema,
  channel: z
    .object({
      channelId: ChannelIdSchema,
      agentId: AgentIdSchema,
      title: z.string(),
      status: ChannelStatusSchema,
      createdAt: z.string(),
      updatedAt: z.string(),
    })
    .optional(),
});
export type ChannelCreatedMessage = z.infer<typeof ChannelCreatedMessageSchema>;

export const ChannelDetailsMessageSchema = z.object({
  type: z.literal('channel_details'),
  channel: ChannelSchema,
  agentConfig: AgentConfigSchema,
  userApps: z.array(UserAppSchema),
  recentMessages: z.array(MessageSchema),
});
export type ChannelDetailsMessage = z.infer<typeof ChannelDetailsMessageSchema>;

export const ChannelClosedMessageSchema = z.object({
  type: z.literal('channel_closed'),
  channelId: ChannelIdSchema,
});
export type ChannelClosedMessage = z.infer<typeof ChannelClosedMessageSchema>;

export const ChannelRenamedMessageSchema = z.object({
  type: z.literal('channel_renamed'),
  channelId: ChannelIdSchema,
  name: z.string(),
});
export type ChannelRenamedMessage = z.infer<typeof ChannelRenamedMessageSchema>;

export const ChannelPrivateUpdatedMessageSchema = z.object({
  type: z.literal('channel_private_updated'),
  channelId: ChannelIdSchema,
  isPrivate: z.boolean(),
});
export type ChannelPrivateUpdatedMessage = z.infer<typeof ChannelPrivateUpdatedMessageSchema>;

export const MessageSentMessageSchema = z.object({
  type: z.literal('message_sent'),
  messageId: MessageIdSchema,
  timestamp: z.string(),
});
export type MessageSentMessage = z.infer<typeof MessageSentMessageSchema>;

export const MessageReceivedMessageSchema = z.object({
  type: z.literal('message'),
  channelId: ChannelIdSchema,
  message: MessageSchema,
});
export type MessageReceivedMessage = z.infer<typeof MessageReceivedMessageSchema>;

export const MessagesHistoryMessageSchema = z.object({
  type: z.literal('messages_history'),
  channelId: ChannelIdSchema,
  messages: z.array(MessageSchema),
  hasMore: z.boolean(),
});
export type MessagesHistoryMessage = z.infer<typeof MessagesHistoryMessageSchema>;

export const TypingEventMessageSchema = z.object({
  type: z.literal('typing'),
  channelId: ChannelIdSchema,
  agentId: AgentIdSchema,
  isTyping: z.boolean(),
});
export type TypingEventMessage = z.infer<typeof TypingEventMessageSchema>;

// System event (reminders, recurring tasks, system_resume)
export const SystemEventMessageSchema = z.object({
  type: z.literal('event'),
  channelId: ChannelIdSchema,
  event: z.object({
    id: z.string(),
    eventType: z.enum(['reminder', 'recurring_task', 'system_resume', 'task_update']),
    message: z.string(),
    description: z.string().optional(),
    metadata: z.record(z.any()).optional(),
    timestamp: z.string(),
  }),
});
export type SystemEventMessage = z.infer<typeof SystemEventMessageSchema>;

export const ErrorMessageSchema = z.object({
  type: z.literal('error'),
  code: z.string(),
  message: z.string(),
  details: z.any().optional(),
});
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;

// ============================================================================
// RELIABLE PROTOCOL SERVER MESSAGES
// ============================================================================

// Pong message (Server → Client) - Heartbeat response
export const PongMessageSchema = z.object({
  type: z.literal('pong'),
  clientTime: z.number(), // Echo of client's timestamp
  serverTime: z.number(), // Server's timestamp
});
export type PongMessage = z.infer<typeof PongMessageSchema>;

// Connection ACK (Server → Client) - Sent after successful auth
export const ConnectionAckMessageSchema = z.object({
  type: z.literal('connection_ack'),
  sessionId: z.string(),
  serverTime: z.number(),
  config: z.object({
    pingIntervalMs: z.number(), // Recommended ping interval (30000)
    pongTimeoutMs: z.number(), // Max time to wait for pong (10000)
    maxMessageSizeBytes: z.number(), // Max message size (10MB)
    ackRequiredAboveBytes: z.number(), // Messages larger than this get ACK (10KB)
  }),
  serverVersion: z.string(),
});
export type ConnectionAckMessage = z.infer<typeof ConnectionAckMessageSchema>;

// Message ACK (Server → Client) - Confirms message receipt
export const MessageAckSchema = z.object({
  type: z.literal('message_ack'),
  requestId: z.string(),
  seq: z.number().optional(), // Echo of client's sequence number
  receivedBytes: z.number(), // Bytes received by server
  status: z.enum(['received', 'processing', 'error']),
  serverSeq: z.number().optional(), // Server's sequence number
  serverTime: z.number(),
  error: z.string().optional(), // Error message if status === 'error'
});
export type MessageAck = z.infer<typeof MessageAckSchema>;

// Agents list response
export const AgentsListMessageSchema = z.object({
  type: z.literal('agents_list'),
  agents: z.array(AgentSummarySchema),
});
export type AgentsListMessage = z.infer<typeof AgentsListMessageSchema>;

// Agent created response
export const AgentCreatedMessageSchema = z.object({
  type: z.literal('agent_created'),
  agent: AgentSummarySchema,
});
export type AgentCreatedMessage = z.infer<typeof AgentCreatedMessageSchema>;

// Apps list response
export const AppSummarySchema = z.object({
  appId: z.string(),
  name: z.string(),
  mcaId: z.string(),
  mcaName: z.string(),
  description: z.string(),
  icon: z.string().optional(),
  color: z.string().optional(),
  category: z.enum([
    'system',
    'productivity',
    'communication',
    'integration',
    'ai',
    'development',
    'data',
  ]),
  status: z.enum(['active', 'inactive']),
});
export type AppSummary = z.infer<typeof AppSummarySchema>;

export const AppsListMessageSchema = z.object({
  type: z.literal('apps_list'),
  apps: z.array(AppSummarySchema),
});
export type AppsListMessage = z.infer<typeof AppsListMessageSchema>;

// Streaming message chunk
export const MessageChunkTypeSchema = z.enum([
  'text_chunk',
  'text_complete',
  'tool_call_start',
  'tool_call_complete',
]);
export type MessageChunkType = z.infer<typeof MessageChunkTypeSchema>;

export const MessageChunkMessageSchema = z.object({
  type: z.literal('message_chunk'),
  channelId: ChannelIdSchema,
  chunkType: MessageChunkTypeSchema,
  text: z.string().optional(), // For text_chunk
  toolCallId: z.string().optional(), // For tool_call_*
  toolName: z.string().optional(), // For tool_call_start
  timestamp: z.number(),
});
export type MessageChunkMessage = z.infer<typeof MessageChunkMessageSchema>;

// Token budget update (sent after each LLM response)
import { TokenBudgetSchema } from './token-budget';

export const TokenBudgetMessageSchema = z.object({
  type: z.literal('token_budget'),
  channelId: ChannelIdSchema,
  budget: TokenBudgetSchema,
});
export type TokenBudgetMessage = z.infer<typeof TokenBudgetMessageSchema>;

// Search results - matches grouped by channel
export const SearchMatchSchema = z.object({
  messageId: MessageIdSchema,
  snippet: z.string(),
  timestamp: z.string(),
  role: MessageRoleSchema,
});
export type SearchMatch = z.infer<typeof SearchMatchSchema>;

export const SearchResultChannelSchema = z.object({
  channelId: ChannelIdSchema,
  channelName: z.string(),
  agentId: AgentIdSchema,
  agentName: z.string(),
  matches: z.array(SearchMatchSchema),
});
export type SearchResultChannel = z.infer<typeof SearchResultChannelSchema>;

export const SearchResultsMessageSchema = z.object({
  type: z.literal('search_results'),
  query: z.string(),
  results: z.array(SearchResultChannelSchema),
  totalMatches: z.number(),
});
export type SearchResultsMessage = z.infer<typeof SearchResultsMessageSchema>;

// User profile response
export const UserProfileSchema = z.object({
  userId: UserIdSchema,
  displayName: z.string(),
  email: z.string(),
  avatarUrl: z.string().optional(),
  description: z.string().optional(),
  locale: z.string().optional(),
  timezone: z.string().optional(),
  createdAt: z.string(),
});
export type UserProfile = z.infer<typeof UserProfileSchema>;

export const ProfileMessageSchema = z.object({
  type: z.literal('profile'),
  profile: UserProfileSchema,
});
export type ProfileMessage = z.infer<typeof ProfileMessageSchema>;

export const ProfileUpdatedMessageSchema = z.object({
  type: z.literal('profile_updated'),
  profile: UserProfileSchema,
});
export type ProfileUpdatedMessage = z.infer<typeof ProfileUpdatedMessageSchema>;

// ============================================================================
// ADMIN RESPONSE MESSAGES
// ============================================================================

// Admin user schema (for list and detail responses)
export const AdminUserSchema = z.object({
  userId: z.string(),
  profile: z.object({
    displayName: z.string(),
    email: z.string(),
    avatarUrl: z.string().optional(),
  }),
  role: z.enum(['user', 'admin', 'super']),
  status: z.enum(['active', 'suspended', 'pending_verification']),
  emailVerified: z.boolean(),
  /** Whether user has full platform access (requires 3 invitations) */
  accessGranted: z.boolean(),
  lastLoginAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  stats: z
    .object({
      apps: z.number(),
      sessions: z.number(),
    })
    .optional(),
});
export type AdminUser = z.infer<typeof AdminUserSchema>;

// Admin users list response
export const AdminUsersListMessageSchema = z.object({
  type: z.literal('admin_users_list'),
  users: z.array(AdminUserSchema),
  total: z.number(),
  summary: z.object({
    total: z.number(),
    active: z.number(),
    admins: z.number(),
  }),
});
export type AdminUsersListMessage = z.infer<typeof AdminUsersListMessageSchema>;

// Admin user detail response
export const AdminUserDetailMessageSchema = z.object({
  type: z.literal('admin_user_detail'),
  user: AdminUserSchema,
  stats: z.object({
    apps: z.number(),
    sessions: z.number(),
    credentials: z.number(),
  }),
  apps: z.array(
    z.object({
      appId: z.string(),
      name: z.string(),
      mcaId: z.string(),
      status: z.string(),
      createdAt: z.string(),
    }),
  ),
});
export type AdminUserDetailMessage = z.infer<typeof AdminUserDetailMessageSchema>;

// Admin user updated response
export const AdminUserUpdatedMessageSchema = z.object({
  type: z.literal('admin_user_updated'),
  user: z.object({
    userId: z.string(),
    role: z.enum(['user', 'admin', 'super']).optional(),
    status: z.enum(['active', 'suspended', 'pending_verification']).optional(),
  }),
});
export type AdminUserUpdatedMessage = z.infer<typeof AdminUserUpdatedMessageSchema>;

// ============================================================================
// INVITATION RESPONSE MESSAGES
// ============================================================================

// Invitation with sender info (received invitations)
export const ReceivedInvitationSchema = z.object({
  fromUserId: z.string(),
  sender: z
    .object({
      userId: z.string(),
      displayName: z.string(),
      email: z.string(),
      avatarUrl: z.string().optional(),
    })
    .optional(),
  createdAt: z.string(),
});

// Invitation status response (what user sees about their own status)
export const InvitationStatusMessageSchema = z.object({
  type: z.literal('invitation_status'),
  /** Number of invitations received */
  received: z.number(),
  /** Number required to get access */
  required: z.number(),
  /** Whether user has platform access */
  accessGranted: z.boolean(),
  /** Number of invitations user can send */
  availableInvitations: z.number(),
  /** List of received invitations with sender info */
  invitations: z.array(ReceivedInvitationSchema),
});
export type InvitationStatusMessage = z.infer<typeof InvitationStatusMessageSchema>;

// Invitation sent response
export const InvitationSentMessageSchema = z.object({
  type: z.literal('invitation_sent'),
  toEmail: z.string(),
  accessGranted: z.boolean(),
});
export type InvitationSentMessage = z.infer<typeof InvitationSentMessageSchema>;

// Sent invitation (for listing sent invitations)
export const SentInvitationSchema = z.object({
  toUserId: z.string(),
  toEmail: z.string(),
  toDisplayName: z.string(),
  createdAt: z.string(),
  recipientAccessGranted: z.boolean(),
});

// Sent invitations list response
export const InvitationsSentMessageSchema = z.object({
  type: z.literal('invitations_sent'),
  invitations: z.array(SentInvitationSchema),
});
export type InvitationsSentMessage = z.infer<typeof InvitationsSentMessageSchema>;

// Invitable users list response
export const InvitableUserSchema = z.object({
  userId: z.string(),
  displayName: z.string(),
  email: z.string(),
  avatarUrl: z.string().optional(),
  invitationsReceived: z.number(),
  invitationsNeeded: z.number(),
});

export const InvitableUsersMessageSchema = z.object({
  type: z.literal('invitable_users'),
  users: z.array(InvitableUserSchema),
});
export type InvitableUsersMessage = z.infer<typeof InvitableUsersMessageSchema>;

// Invitation revoked response
export const InvitationRevokedMessageSchema = z.object({
  type: z.literal('invitation_revoked'),
  fromUserId: z.string(),
  toUserId: z.string(),
  accessRevoked: z.boolean(),
});
export type InvitationRevokedMessage = z.infer<typeof InvitationRevokedMessageSchema>;

// Invitation error response
export const InvitationErrorMessageSchema = z.object({
  type: z.literal('invitation_error'),
  error: z.string(),
  code: z.string().optional(),
  email: z.string().optional(),
});
export type InvitationErrorMessage = z.infer<typeof InvitationErrorMessageSchema>;

// Google OAuth URL response
export const GoogleAuthUrlMessageSchema = z.object({
  type: z.literal('google_auth_url'),
  url: z.string(),
  state: z.string(),
});
export type GoogleAuthUrlMessage = z.infer<typeof GoogleAuthUrlMessageSchema>;

// ============================================================================
// WORKSPACE RESPONSE MESSAGES (Server → Client)
// ============================================================================

// Workspace role type
export const WorkspaceRoleSchema = z.enum(['owner', 'admin', 'write', 'read']);
export type WorkspaceRole = z.infer<typeof WorkspaceRoleSchema>;

// Workspace summary (for listing)
export const WorkspaceSummarySchema = z.object({
  workspaceId: z.string(),
  name: z.string(),
  description: z.string().optional(),
  context: z.string().optional(), // System prompt context
  volumeId: z.string(),
  role: WorkspaceRoleSchema,
  status: z.enum(['active', 'archived']),
  createdAt: z.string(),
});
export type WorkspaceSummary = z.infer<typeof WorkspaceSummarySchema>;

// Workspace member
export const WorkspaceMemberSchema = z.object({
  userId: z.string(),
  role: z.enum(['admin', 'write', 'read']),
  addedAt: z.string(),
  addedBy: z.string(),
});
export type WorkspaceMember = z.infer<typeof WorkspaceMemberSchema>;

// Workspace details (full info)
export const WorkspaceDetailsSchema = z.object({
  workspaceId: z.string(),
  name: z.string(),
  description: z.string().optional(),
  context: z.string().optional(), // System prompt context
  volumeId: z.string(),
  ownerId: z.string(),
  members: z.array(WorkspaceMemberSchema),
  settings: z.object({
    defaultBranch: z.string().optional(),
  }),
  role: WorkspaceRoleSchema,
  status: z.enum(['active', 'archived']),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WorkspaceDetails = z.infer<typeof WorkspaceDetailsSchema>;

// Workspace app summary
export const WorkspaceAppSummarySchema = z.object({
  appId: z.string(),
  name: z.string(),
  mcaId: z.string(),
  mcaName: z.string(),
  description: z.string(),
  icon: z.string().optional(),
  color: z.string().optional(),
  category: z.string(),
  status: z.enum(['active', 'disabled']),
  volumes: z
    .array(
      z.object({
        volumeId: z.string(),
        mountPath: z.string(),
      }),
    )
    .optional(),
});
export type WorkspaceAppSummary = z.infer<typeof WorkspaceAppSummarySchema>;

// Workspaces list response
export const WorkspacesListMessageSchema = z.object({
  type: z.literal('workspaces_list'),
  workspaces: z.array(WorkspaceSummarySchema),
});
export type WorkspacesListMessage = z.infer<typeof WorkspacesListMessageSchema>;

// Workspace created response
export const WorkspaceCreatedMessageSchema = z.object({
  type: z.literal('workspace_created'),
  workspace: WorkspaceSummarySchema,
});
export type WorkspaceCreatedMessage = z.infer<typeof WorkspaceCreatedMessageSchema>;

// Workspace details response
export const WorkspaceDetailsMessageSchema = z.object({
  type: z.literal('workspace_details'),
  workspace: WorkspaceDetailsSchema,
});
export type WorkspaceDetailsMessage = z.infer<typeof WorkspaceDetailsMessageSchema>;

// Workspace updated response
export const WorkspaceUpdatedMessageSchema = z.object({
  type: z.literal('workspace_updated'),
  workspace: z.object({
    workspaceId: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    context: z.string().optional(),
  }),
});
export type WorkspaceUpdatedMessage = z.infer<typeof WorkspaceUpdatedMessageSchema>;

// Workspace archived response
export const WorkspaceArchivedMessageSchema = z.object({
  type: z.literal('workspace_archived'),
  workspaceId: z.string(),
});
export type WorkspaceArchivedMessage = z.infer<typeof WorkspaceArchivedMessageSchema>;

// Workspace apps list response
export const WorkspaceAppsListMessageSchema = z.object({
  type: z.literal('workspace_apps_list'),
  workspaceId: z.string(),
  apps: z.array(WorkspaceAppSummarySchema),
});
export type WorkspaceAppsListMessage = z.infer<typeof WorkspaceAppsListMessageSchema>;

// Workspace app installed response
export const WorkspaceAppInstalledMessageSchema = z.object({
  type: z.literal('workspace_app_installed'),
  workspaceId: z.string(),
  app: WorkspaceAppSummarySchema,
});
export type WorkspaceAppInstalledMessage = z.infer<typeof WorkspaceAppInstalledMessageSchema>;

// Union of all server messages
export const ServerMessageSchema = z.union([
  AuthSuccessMessageSchema,
  AuthErrorMessageSchema,
  AgentsListMessageSchema,
  AgentCreatedMessageSchema,
  AppsListMessageSchema,
  ChannelsListMessageSchema,
  ChannelCreatedMessageSchema,
  ChannelDetailsMessageSchema,
  ChannelClosedMessageSchema,
  ChannelRenamedMessageSchema,
  MessageSentMessageSchema,
  MessageReceivedMessageSchema,
  MessageChunkMessageSchema,
  MessagesHistoryMessageSchema,
  TypingEventMessageSchema,
  TokenBudgetMessageSchema,
  SearchResultsMessageSchema,
  // User profile messages
  ProfileMessageSchema,
  ProfileUpdatedMessageSchema,
  // Admin response messages
  AdminUsersListMessageSchema,
  AdminUserDetailMessageSchema,
  AdminUserUpdatedMessageSchema,
  // Invitation response messages
  InvitationStatusMessageSchema,
  InvitationSentMessageSchema,
  InvitationsSentMessageSchema,
  InvitableUsersMessageSchema,
  InvitationRevokedMessageSchema,
  InvitationErrorMessageSchema,
  GoogleAuthUrlMessageSchema,
  ErrorMessageSchema,
  // Reliable protocol messages
  PongMessageSchema,
  ConnectionAckMessageSchema,
  MessageAckSchema,
  // Workspace response messages
  WorkspacesListMessageSchema,
  WorkspaceCreatedMessageSchema,
  WorkspaceDetailsMessageSchema,
  WorkspaceUpdatedMessageSchema,
  WorkspaceArchivedMessageSchema,
  WorkspaceAppsListMessageSchema,
  WorkspaceAppInstalledMessageSchema,
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Safely parse and validate a client message
 */
export function parseClientMessage(data: unknown): ClientMessage {
  return ClientMessageSchema.parse(data);
}

/**
 * Safely parse and validate a server message
 */
export function parseServerMessage(data: unknown): ServerMessage {
  return ServerMessageSchema.parse(data);
}

/**
 * Type guard for client messages
 */
export function isClientMessage(data: unknown): data is ClientMessage {
  return ClientMessageSchema.safeParse(data).success;
}

/**
 * Type guard for server messages
 */
export function isServerMessage(data: unknown): data is ServerMessage {
  return ServerMessageSchema.safeParse(data).success;
}

// ============================================================================
// TYPE GUARDS FOR SPECIFIC MESSAGES
// ============================================================================

export function isAuthSuccess(data: unknown): data is AuthSuccessMessage {
  return AuthSuccessMessageSchema.safeParse(data).success;
}

export function isAuthError(data: unknown): data is AuthErrorMessage {
  return AuthErrorMessageSchema.safeParse(data).success;
}

export function isAgentsList(data: unknown): data is AgentsListMessage {
  return AgentsListMessageSchema.safeParse(data).success;
}

export function isChannelsList(data: unknown): data is ChannelsListMessage {
  return ChannelsListMessageSchema.safeParse(data).success;
}

export function isChannelCreated(data: unknown): data is ChannelCreatedMessage {
  return ChannelCreatedMessageSchema.safeParse(data).success;
}

export function isChannelClosed(data: unknown): data is ChannelClosedMessage {
  return ChannelClosedMessageSchema.safeParse(data).success;
}

export function isChannelRenamed(data: unknown): data is ChannelRenamedMessage {
  return ChannelRenamedMessageSchema.safeParse(data).success;
}

export function isMessageSent(data: unknown): data is MessageSentMessage {
  return MessageSentMessageSchema.safeParse(data).success;
}

export function isMessageReceived(data: unknown): data is MessageReceivedMessage {
  return MessageReceivedMessageSchema.safeParse(data).success;
}

export function isMessageChunk(data: unknown): data is MessageChunkMessage {
  return MessageChunkMessageSchema.safeParse(data).success;
}

export function isMessagesHistory(data: unknown): data is MessagesHistoryMessage {
  return MessagesHistoryMessageSchema.safeParse(data).success;
}

export function isTypingEvent(data: unknown): data is TypingEventMessage {
  return TypingEventMessageSchema.safeParse(data).success;
}

export function isSystemEvent(data: unknown): data is SystemEventMessage {
  return SystemEventMessageSchema.safeParse(data).success;
}

export function isTokenBudget(data: unknown): data is TokenBudgetMessage {
  return TokenBudgetMessageSchema.safeParse(data).success;
}

export function isError(data: unknown): data is ErrorMessage {
  return ErrorMessageSchema.safeParse(data).success;
}

// Reliable protocol type guards
export function isPing(data: unknown): data is PingMessage {
  return PingMessageSchema.safeParse(data).success;
}

export function isPong(data: unknown): data is PongMessage {
  return PongMessageSchema.safeParse(data).success;
}

export function isConnectionAck(data: unknown): data is ConnectionAckMessage {
  return ConnectionAckMessageSchema.safeParse(data).success;
}

export function isMessageAck(data: unknown): data is MessageAck {
  return MessageAckSchema.safeParse(data).success;
}
