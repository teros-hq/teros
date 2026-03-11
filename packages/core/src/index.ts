/**
 * @teros/core - Core conversation processing for Teros agents
 */

export type {
  CompactionCheckResult,
  CompactionConfig,
  CompactionResult,
  PruneConfig,
  PruneResult,
} from './compaction';
// Compaction
export {
  CompactionService,
  estimateConversationTokens,
  estimateMessageTokens,
  estimateTokens,
} from './compaction';
export type { PartInput, PromptInput } from './conversation/ConversationManager';
// Conversation Management (main exports)
export { ConversationManager } from './conversation/ConversationManager';
export { MessageProcessor } from './conversation/MessageProcessor';
export { MessageProcessorAdapter } from './conversation/MessageProcessorAdapter';
export type { ErrorContext, ErrorType } from './errors/AgentError';
// Errors
export {
  AgentError,
  LLMError,
  NetworkError,
  SessionError,
  ToolError,
  ValidationError,
} from './errors/AgentError';
// ID Generation
export {
  generateAgentId,
  generateAppId,
  generateBoardId,
  generateChannelId,
  generateColumnId,
  generateEventId,
  generateId,
  generateMessageId,
  generateProjectId,
  generateSessionId,
  generateTaskId,
  generateUserId,
  generateUserVolumeId,
  generateWorkspaceId,
  generateWorkspaceVolumeId,
  getIdPrefix,
  ID_PREFIXES,
  validateIdPrefix,
} from './ids';
export { AnthropicLLMAdapter } from './llm/AnthropicLLMAdapter';
export { AnthropicOAuthAdapter } from './llm/AnthropicOAuthAdapter';
// Codex OAuth (for ChatGPT Pro/Plus subscription)
export type { CodexOAuthTokens, CodexDeviceCodeResponse } from './llm/CodexOAuth';
export {
  requestDeviceCode,
  pollForDeviceToken,
  refreshCodexTokens,
  codexTokensNeedRefresh,
  extractAccountId as extractCodexAccountId,
  CODEX_OAUTH_CONFIG,
} from './llm/CodexOAuth';
export { OpenAICodexOAuthAdapter } from './llm/OpenAICodexOAuthAdapter';
export type { ClaudeCodeCredentials } from './llm/ClaudeCodeCredentials';
export type { OllamaConfig } from './llm/OllamaLLMAdapter';
export { OllamaLLMAdapter } from './llm/OllamaLLMAdapter';
// Claude Code Credentials (from Claude Code CLI)
export {
  getClaudeCodeAccessToken,
  hasClaudeCodeCredentials,
  loadClaudeCodeCredentials,
  refreshClaudeCodeToken,
} from './llm/ClaudeCodeCredentials';
export type { ClaudeOAuthTokens } from './llm/ClaudeOAuth';
// Claude OAuth (for Claude Max subscription)
export {
  exchangeCodeForTokens,
  generateAuthorizationUrl,
  getOAuthAccessToken,
  getOAuthBetaHeaders,
  hasOAuthTokens,
  loadOAuthTokens,
  oauthConfig,
  refreshOAuthTokens,
  saveOAuthTokens,
  tokensNeedRefresh,
} from './llm/ClaudeOAuth';
// LLM
export type { ILLMClient, LLMResponse, ToolDefinition } from './llm/ILLMClient';
export type { LLMConfig } from './llm/LLMClientFactory';
export { LLMClientFactory } from './llm/LLMClientFactory';
export type { Claude45Model, ModelId, Provider } from './llm/models';

// Model IDs and constants
export {
  CLAUDE_4_5,
  DEFAULT_MODELS,
  MODEL_IDS,
} from './llm/models';
export type { ZhipuConfig } from './llm/ZhipuLLMAdapter';
export { ZhipuLLMAdapter } from './llm/ZhipuLLMAdapter';
// Logging
export { createLogger, log, logError, logger } from './logger';
// MCA Auth Types
export type {
  ApiKeyField,
  ApiKeyInfo,
  AppAuthInfo,
  AppCredentialStatus,
  McaAuthType,
  McaOAuthConfig,
  McaOAuthState,
  OAuthInfo,
  OAuthTokenResponse,
  UserCredentials,
} from './mca/types';
export { NoOpMemoryHooks } from './memory';

// Memory
export type { IMemoryHooks, ResponseMetadata } from './memory/IMemoryHooks';
// Prompts
export { SystemPromptBuilder } from './prompts/SystemPromptBuilder';
// Queue
export { MessageQueue } from './queue/MessageQueue';
export * from './queue/types';
export { InMemorySessionStore } from './session/InMemorySessionStore';
export { SessionLockManager } from './session/SessionLockManager';
// Session Management
export { type MessagesForLLM, SessionStore } from './session/SessionStore';
export * from './session/types';
// Streaming
export {
  type LLMUsageData,
  type MessageCompleteCallback,
  type StreamCallback,
  StreamPublisher,
} from './streaming/StreamPublisher';
export * from './streaming/types';
export type {
  RecordedCall,
  RecordedEvent,
  Recording,
} from './testing/LLMRecorder';
// Testing utilities
export {
  createSimpleMockAdapter,
  hashInput,
  loadOrCreateRecording,
  MockLLMAdapter,
  RecordingLLMAdapter,
} from './testing/LLMRecorder';
// Tools (MCP)
export type { IToolExecutor, ToolExecutionOptions } from './tools/IToolExecutor';
export { MCPToolExecutor } from './tools/MCPToolExecutor';
export { MCPToolManager } from './tools/MCPToolManager';
