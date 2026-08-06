/**
 * LLM Client Interface - Provider-agnostic streaming interface
 *
 * This interface defines a generic contract for LLM providers.
 * All providers (Anthropic, OpenAI, the previous implementation, etc.) implement this.
 *
 * Design:
 * - Accepts the previous implementation's MessageWithParts[] format
 * - Streams responses via callbacks
 * - Returns generic stop reasons
 * - Provider adapters handle format conversion
 */

import type { MessageWithParts } from "../session/types"

/**
 * Tool definition (generic format, adapters convert to provider-specific)
 */
export interface ToolDefinition {
  name: string
  description: string
  input_schema: {
    type: "object"
    properties: Record<string, any>
    required?: string[]
  }
}

/**
 * Tool call from LLM
 */
export interface ToolCall {
  id: string
  name: string
  input: Record<string, any>
  /** Provider-specific metadata (e.g. Gemini thought_signature for thinking models) */
  metadata?: Record<string, any>
}

/**
 * Tool result to send back to LLM
 */
export interface ToolResult {
  id: string
  content: string
  isError?: boolean
}

/**
 * Generic LLM response
 */
export interface LLMResponse {
  stopReason: "end_turn" | "tool_calls" | "max_tokens" | "error"
  usage?: {
    /**
     * NON-cached input tokens. INVARIANT: every adapter reports the input
     * count EXCLUDING cache reads — `inputTokens + cacheReadInputTokens`
     * reconstructs the full prompt size. Anthropic already reports this shape;
     * the OpenAI-family adapters normalize `prompt_tokens` via
     * `uncachedInputTokens()`. Cost/breakdown/hit-ratio all rely on this
     * (see usage-normalize.ts + deep audit §A2.1).
     */
    inputTokens: number
    outputTokens: number
    /** Tokens written to cache (Anthropic prompt caching) */
    cacheCreationInputTokens?: number
    /** Tokens read from cache (Anthropic prompt caching; also Fireworks/Together `prompt_tokens_details.cached_tokens`) */
    cacheReadInputTokens?: number
    /**
     * Reasoning/thinking tokens reported in the provider `usage` object.
     * Together surfaces `usage.reasoning_tokens`; Fireworks emits reasoning as
     * text (`reasoning_content`) and never counts it → this stays absent there.
     */
    reasoningTokens?: number
  }
  metadata?: Record<string, any>
}

/**
 * Token usage surfaced to the `onUsage` instrumentation callback.
 * Mirrors `LLMResponse['usage']`.
 */
export interface LLMUsageInfo {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
  reasoningTokens?: number
}

/**
 * Final-turn instrumentation surfaced to the `onFinish` callback.
 *
 * Emitted on BOTH success and error so callers can record latency and the
 * error classification even when `streamMessage` throws. All fields optional —
 * an adapter that does not instrument simply never invokes the callback.
 */
export interface LLMFinishInfo {
  /** Wall-clock time from request start to the first streamed chunk (ms). */
  ttftMs?: number
  /** Wall-clock end-to-end latency of the LLM call (ms). */
  latencyMs?: number
  /**
   * Server-reported TTFT when the provider exposes it (Fireworks perf header
   * `fireworks-server-time-to-first-token`, in seconds → ms here). Absent for
   * providers that do not report it.
   */
  serverTtftMs?: number
  /** Provider `finish_reason` (stop / length / tool_calls / content_filter / …). */
  finishReason?: string | null
  /** Token usage (present on success; may be absent when the call failed). */
  usage?: LLMUsageInfo
  /**
   * Classified transient-error bucket when the call failed
   * (`rate_limited` / `overloaded` / `server_error` / `timeout` / …).
   * Absent on success.
   */
  errorClass?: string
  /** Real upstream provider that served the request (`fireworks` | `together` | …). */
  actualProvider?: string
  /**
   * Failover telemetry (TER-617/F3). Set by the teros fallback wrapper when a
   * transient Fireworks failure was retried on Together. `fallbackUsed` flags
   * the turn for the fallback-rate; `primaryProvider`/`primaryErrorClass`
   * preserve WHICH upstream failed and WHY, so the failover does not erase the
   * Fireworks error from the per-upstream error-rate.
   */
  fallbackUsed?: boolean
  primaryProvider?: string
  primaryErrorClass?: string
}

/**
 * Streaming callbacks for real-time updates
 */
export interface StreamingCallbacks {
  /**
   * Called when text content is streamed
   */
  onText?: (chunk: string) => void | Promise<void>

  /**
   * Called when a text block is completed
   */
  onTextEnd?: () => void | Promise<void>

  /**
   * Called when a tool call is requested
   */
  onToolCall?: (toolCall: ToolCall) => void | Promise<void>

  /**
   * Called when thinking/reasoning content is streamed (Claude extended thinking)
   */
  onThinking?: (chunk: string) => void | Promise<void>

  /**
   * Called as a tool call's input streams in (partial JSON fragment, possibly
   * empty for name/id-only deltas). Adapters buffer tool input until complete
   * and only then fire `onToolCall`, so this is the ONLY liveness signal while
   * the model writes large tool arguments — the turn's stall watchdog counts it
   * as progress instead of killing a productive stream (TER-650). Not rendered;
   * the fragment is raw provider JSON, not a displayable unit.
   */
  onToolInputDelta?: (chunk: string) => void | Promise<void>

  /**
   * Instrumentation hook: called once when the provider reports token usage
   * (typically on the final chunk). Optional; adapters that do not instrument
   * never invoke it. Consumers use it to record per-call token counts without
   * waiting for the return value.
   */
  onUsage?: (usage: LLMUsageInfo) => void | Promise<void>

  /**
   * Instrumentation hook: called once when the LLM call finishes — on BOTH
   * success and error. Carries timing + classification telemetry (TTFT,
   * latency, finishReason, errorClass, actualProvider). Additive/optional:
   * today only the OpenAI-compatible adapter (teros / fireworks / together)
   * emits it. Used by the caller to populate `latencyMs`/`ttftMs`/
   * `actualProvider` on `llm_usage` and `session.delta`.
   */
  onFinish?: (info: LLMFinishInfo) => void | Promise<void>
}

/**
 * Options for streaming messages
 */
export interface StreamMessageOptions {
  /** Message history in the previous implementation format */
  messages: MessageWithParts[]

  /** Available tools (optional) */
  tools?: ToolDefinition[]

  /** System prompt override (optional) */
  systemPrompt?: string

  /** Model configuration (optional) */
  model?: string
  temperature?: number
  maxTokens?: number

  /** AbortSignal for cancellation */
  signal?: AbortSignal

  /** Streaming callbacks */
  callbacks?: StreamingCallbacks

  /**
   * Index in messages array where cache breakpoint should be placed.
   * Content up to and including this index will be marked for caching.
   * Used by Anthropic adapter for prompt caching optimization.
   */
  cacheBreakpointIndex?: number

  /** Context metadata for usage tracking (optional) */
  userId?: string
  workspaceId?: string
  agentId?: string
  channelId?: string
}

/**
 * LLM Client Interface
 *
 * All LLM providers must implement this interface.
 * Adapters handle conversion between the previous implementation format and provider-specific formats.
 */
export interface ILLMClient {
  /**
   * Stream a message to the LLM and get a response
   *
   * This is the main method used by ConversationManager.
   * It accepts the previous implementation's MessageWithParts[] format and returns a generic response.
   *
   * The adapter is responsible for:
   * 1. Converting MessageWithParts[] to provider's format
   * 2. Streaming the response and calling callbacks
   * 3. Converting provider's response to LLMResponse
   */
  streamMessage(options: StreamMessageOptions): Promise<LLMResponse>

  /**
   * Get provider information
   */
  getProviderInfo(): {
    name: string
    model: string
    capabilities: {
      streaming: boolean
      tools: boolean
      thinking: boolean
      vision: boolean
    }
    [key: string]: any
  }
}
