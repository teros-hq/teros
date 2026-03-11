/**
 * Agent Core Types
 */

import type { ILLMClient } from "./llm/ILLMClient"
import type { IMemoryHooks } from "./memory/IMemoryHooks"
import type { AgentConfig } from "./prompts"
import type { SessionStore } from "./session/SessionStore"
import type { MCPToolExecutor } from "./tools/MCPToolExecutor"
import type { MCPServerConfig } from "./tools/MCPToolManager"

/**
 * Configuration for creating an AgentCore instance
 *
 * This interface uses Dependency Injection - all dependencies
 * are provided as abstractions, not concrete implementations.
 */
export interface AgentCoreConfig {
  /** Agent ID (e.g., 'iria', 'berta', 'alice') */
  agentId: string

  /** Channel ID for channel-based communication (optional - agent can join channels dynamically) */
  channelId?: string

  /** User ID this instance serves */
  userId: string

  /** LLM Client instance (abstraction) */
  llmClient: ILLMClient

  /** Session store instance (abstraction) */
  sessionStore: SessionStore

  /** Tool executor for MCP tools (optional) */
  toolExecutor?: MCPToolExecutor

  /** Conversation limits */
  maxSteps?: number
  timeoutSeconds?: number

  /** Debug mode - show detailed errors to user */
  debugErrors?: boolean

  /** System prompt (optional) */
  systemPrompt?: string

  /** Enable real-time streaming (default: true) */
  enableStreaming?: boolean

  /** Memory hooks for context enrichment and learning (optional) */
  memoryHooks?: IMemoryHooks

  /** Anthropic API key for dreaming system (optional) */
  anthropicApiKey?: string

  /** Qdrant URL for memory system (optional) */
  qdrantUrl?: string

  /** Qdrant API key (optional) */
  qdrantApiKey?: string

  /** User name for dreaming reflections (optional, default: 'User') */
  userName?: string

  /** Agent name for dreaming reflections (optional) */
  agentName?: string
}

export interface MessageContext {
  userId: string
  channelId: string
  threadId?: number
  messageId?: number
  text: string
  timestamp: number
  transport?: string
}
