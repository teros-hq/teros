/**
 * Message Handler Modules
 *
 * Extracted components from message-handler.ts for better maintainability.
 */

export {
  createLLMClientManager,
  type LLMClientManager,
  type ResolvedProviderCredentials,
} from './llm-client-manager';
export {
  createPermissionManager,
  type PermissionManager,
  type PermissionStatusCallbacks,
  type ToolCallContext,
} from './permission-manager';
export {
  createFormManager,
  type FormManager,
  type FormResponsePayload,
  type FormStatusCallbacks,
} from './form-manager';
export {
  createStreamingHelpers,
  createStreamingState,
  type StreamingHelpers,
  type StreamingState,
} from './streaming-state';
export { createTypingManager, type TypingManager } from './typing-manager';
export {
  handleStreamEvent,
  handleMessageComplete,
  handleAgentError,
  type AgentLoopContext,
} from './agent-loop';
