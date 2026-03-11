/**
 * OpenRouterLLMAdapter - OpenRouter implementation of ILLMClient
 *
 * OpenRouter provides unified access to 400+ AI models from multiple providers
 * with OpenAI-compatible API. This adapter leverages the OpenAI SDK with
 * OpenRouter-specific configuration.
 *
 * Features:
 * - Direct model selection (e.g., 'deepseek/deepseek-chat')
 * - Auto-routing with 'openrouter/auto' (cheapest, fastest, best)
 * - Automatic fallbacks across providers
 * - Transparent pricing (pay only for the model used)
 *
 * Architecture:
 * ConversationManager (uses MessageWithParts types)
 *   ↓
 * ILLMClient interface (generic)
 *   ↓
 * OpenRouterAdapter (converts MessageWithParts ↔ OpenAI format)
 *   ↓
 * OpenAI SDK (with OpenRouter base URL)
 *   ↓
 * OpenRouter API (routes to actual model)
 */

import OpenAI from "openai"
import { LLMError } from "../errors/AgentError"
import { createLogger, log } from "../logger"
import type { MessageWithParts } from "../session/types"
import type { ILLMClient, LLMResponse, StreamMessageOptions, ToolCall } from "./ILLMClient"

export interface OpenRouterConfig {
  apiKey: string
  /** Model string (e.g., 'deepseek/deepseek-chat' or 'openrouter/auto') */
  model: string
  defaultMaxTokens?: number

  /** Auto-routing strategy (only for 'openrouter/auto' model) */
  routingStrategy?: "cheapest" | "fastest" | "best"

  /** Allow automatic fallbacks to other models if primary fails */
  allowFallbacks?: boolean

  /** Provider preference order (e.g., ['anthropic', 'openai', 'deepseek']) */
  providerOrder?: string[]

  /** Providers to exclude from routing */
  ignoreProviders?: string[]

  /** Site URL for OpenRouter rankings (optional) */
  siteUrl?: string

  /** App name for OpenRouter rankings (optional) */
  appName?: string
}

/**
 * OpenRouter LLM Adapter
 *
 * Implements the generic ILLMClient interface using OpenAI SDK with OpenRouter.
 * Handles all format conversions between MessageWithParts and OpenAI formats.
 * Supports both direct model selection and auto-routing.
 */
export class OpenRouterLLMAdapter implements ILLMClient {
  private client: OpenAI
  private defaultModel: string
  private defaultMaxTokens: number
  private config: OpenRouterConfig
  private logger = createLogger("OpenRouterLLM")

  constructor(config: OpenRouterConfig) {
    if (!config.model) {
      throw new Error("OpenRouterLLMAdapter: model is required")
    }

    this.config = config
    this.defaultModel = config.model
    this.defaultMaxTokens = config.defaultMaxTokens || 8192

    // Initialize OpenAI client with OpenRouter base URL and headers
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        "HTTP-Referer": config.siteUrl || "https://teros.ai",
        "X-Title": config.appName || "Teros AI Platform",
      },
    })

    log.info("OpenRouterLLM", "Initialized OpenRouter adapter", {
      model: config.model,
      isAutoRouting: config.model === "openrouter/auto",
      routingStrategy: config.routingStrategy,
    })
  }

  /**
   * Detect if model supports Anthropic-style prompt caching
   */
  private shouldUseAnthropicCaching(model: string): boolean {
    return model.includes("anthropic/claude") || model.includes("claude")
  }

  /**
   * Get minimum cacheable tokens for model
   */
  private getMinCacheTokens(model: string): number {
    // Claude Opus 4.5, Haiku 4.5: 4096 tokens minimum
    if (model.includes("opus-4-5") || model.includes("haiku-4-5")) {
      return 4096
    }
    // Other Claude models: 1024 tokens minimum
    return 1024
  }

  /**
   * Main streaming method
   *
   * Converts MessageWithParts[] to OpenAI format,
   * streams the response, and calls callbacks for real-time updates.
   */
  async streamMessage(options: StreamMessageOptions): Promise<LLMResponse> {
    const {
      messages,
      tools,
      systemPrompt,
      model,
      temperature,
      maxTokens,
      signal,
      callbacks,
      cacheBreakpointIndex,
    } = options

    const requestedModel = model || this.defaultModel
    const supportsCache = this.shouldUseAnthropicCaching(requestedModel)

    // Convert messages to OpenAI format (with cache support if applicable)
    const openaiMessages = this.convertMessages(
      messages,
      systemPrompt,
      supportsCache ? cacheBreakpointIndex : undefined,
      supportsCache,
    )

    // Convert tools to OpenAI format (with cache support if applicable)
    const openaiTools = tools?.map((tool, index) => {
      const baseTool = {
        type: "function" as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema,
        },
      }

      // Add cache_control to last tool if using Anthropic caching
      if (supportsCache && index === tools.length - 1) {
        return {
          ...baseTool,
          cache_control: { type: "ephemeral" as const },
        } as any // OpenRouter accepts this even though not in OpenAI types
      }

      return baseTool
    })
    const isAutoRouting = requestedModel === "openrouter/auto"

    log.info("OpenRouterLLM", "Calling OpenRouter API", {
      model: requestedModel,
      isAutoRouting,
      routingStrategy: isAutoRouting ? this.config.routingStrategy : undefined,
      messageCount: openaiMessages.length,
      toolCount: openaiTools?.length || 0,
      maxTokens: maxTokens || this.defaultMaxTokens,
      temperature: temperature ?? 0.7,
      cacheEnabled: supportsCache,
      cacheBreakpoint: cacheBreakpointIndex,
    })

    try {
      // Build request parameters
      const createParams: any = {
        model: requestedModel,
        temperature: temperature ?? 0.7,
        max_tokens: maxTokens || this.defaultMaxTokens,
        messages: openaiMessages,
        tools: openaiTools?.length ? openaiTools : undefined,
        stream: true,
      }

      // Add OpenRouter-specific routing parameters
      // Note: OpenRouter uses 'provider' object for routing preferences, not 'route'
      const providerConfig: any = {}

      if (this.config.allowFallbacks !== undefined) {
        providerConfig.allow_fallbacks = this.config.allowFallbacks
      }

      if (this.config.providerOrder && this.config.providerOrder.length > 0) {
        providerConfig.order = this.config.providerOrder
      }

      if (this.config.ignoreProviders && this.config.ignoreProviders.length > 0) {
        providerConfig.ignore = this.config.ignoreProviders
      }

      // For routing strategy (cheapest/fastest/best), use performance preferences
      if (isAutoRouting && this.config.routingStrategy) {
        if (this.config.routingStrategy === "fastest") {
          // Prioritize fast endpoints
          providerConfig.preferred_min_throughput = 50
          providerConfig.preferred_max_latency = 1
        }
        // For 'cheapest' and 'best', auto-router handles it automatically
        // 'cheapest' is the default behavior
        // 'best' uses all available models without restrictions
      }

      if (Object.keys(providerConfig).length > 0) {
        createParams.provider = providerConfig
      }

      // Create streaming request
      const stream = (await this.client.chat.completions.create(createParams, {
        signal,
      })) as unknown as AsyncIterable<any>

      let hasToolCalls = false
      const toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map()
      let finishReason: string | null = null
      let totalInputTokens = 0
      let totalOutputTokens = 0
      let cacheReadTokens = 0
      let cacheWriteTokens = 0
      let actualModelUsed: string | undefined

      // Process stream events
      for await (const chunk of stream) {
        const choice = chunk.choices[0]
        if (!choice) continue

        // Capture which model was actually used (important for auto-routing)
        if (chunk.model && !actualModelUsed) {
          actualModelUsed = chunk.model
          if (isAutoRouting) {
            log.info("OpenRouterLLM", "Auto-routing selected model", {
              requested: requestedModel,
              selected: actualModelUsed,
            })
          }
        }

        const delta = choice.delta

        // Handle text content
        if (delta.content) {
          await callbacks?.onText?.(delta.content)
        }

        // Handle tool calls (streamed incrementally)
        if (delta.tool_calls) {
          for (const toolCallDelta of delta.tool_calls) {
            const index = toolCallDelta.index

            if (!toolCalls.has(index)) {
              toolCalls.set(index, {
                id: toolCallDelta.id || "",
                name: toolCallDelta.function?.name || "",
                arguments: "",
              })
            }

            const toolCall = toolCalls.get(index)!

            if (toolCallDelta.id) {
              toolCall.id = toolCallDelta.id
            }
            if (toolCallDelta.function?.name) {
              toolCall.name = toolCallDelta.function.name
            }
            if (toolCallDelta.function?.arguments) {
              toolCall.arguments += toolCallDelta.function.arguments
            }
          }
        }

        // Capture finish reason
        if (choice.finish_reason) {
          finishReason = choice.finish_reason
        }

        // Capture usage (usually in the last chunk)
        if (chunk.usage) {
          totalInputTokens = chunk.usage.prompt_tokens
          totalOutputTokens = chunk.usage.completion_tokens

          // Extract cache tokens from prompt_tokens_details (OpenRouter format)
          const details = (chunk.usage as any).prompt_tokens_details
          if (details) {
            cacheReadTokens = details.cached_tokens || 0
            cacheWriteTokens = details.cache_write_tokens || 0
          }
        }
      }

      // Notify text end if we had any text
      await callbacks?.onTextEnd?.()

      // Process completed tool calls
      if (toolCalls.size > 0) {
        hasToolCalls = true
        for (const [_, tc] of toolCalls) {
          let parsedInput: Record<string, any> = {}
          try {
            parsedInput = JSON.parse(tc.arguments || "{}")
          } catch (e) {
            log.warn("OpenRouterLLM", "Failed to parse tool arguments", {
              toolName: tc.name,
              arguments: tc.arguments,
            })
          }

          const toolCall: ToolCall = {
            id: tc.id,
            name: tc.name,
            input: parsedInput,
          }

          await callbacks?.onToolCall?.(toolCall)
        }
      }

      // Determine stop reason
      let stopReason: LLMResponse["stopReason"] = "end_turn"
      if (hasToolCalls || finishReason === "tool_calls") {
        stopReason = "tool_calls"
      } else if (finishReason === "length") {
        stopReason = "max_tokens"
      }

      const usage = {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cacheReadInputTokens: cacheReadTokens || undefined,
        cacheCreationInputTokens: cacheWriteTokens || undefined,
      }

      log.info("OpenRouterLLM", "Response complete", {
        stopReason,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheRead: usage.cacheReadInputTokens,
        cacheWrite: usage.cacheCreationInputTokens,
        requestedModel,
        actualModel: actualModelUsed,
      })

      return {
        stopReason,
        usage,
        metadata: {
          provider: "openrouter",
          requestedModel,
          actualModel: actualModelUsed || requestedModel,
          finishReason,
          isAutoRouted: isAutoRouting,
        },
      }
    } catch (error: any) {
      // Check if it's an abort
      if (signal?.aborted) {
        log.warn("OpenRouterLLM", "Request aborted by user")
        return {
          stopReason: "error",
          metadata: { error: "Aborted by user" },
        }
      }

      // Create structured error
      const llmError = this.createLLMError(error, {
        model: model || this.defaultModel,
        messageCount: openaiMessages.length,
        toolCount: openaiTools?.length || 0,
      })

      log.agentError("OpenRouterLLM", llmError)

      // Throw the structured error
      throw llmError
    }
  }

  /**
   * Convert MessageWithParts[] to OpenAI messages format
   *
   * MessageWithParts format:
   * - MessageWithParts { info: Message, parts: Part[] }
   * - Each part has a type (text, tool, file, etc.)
   *
   * OpenAI format:
   * - { role: 'system' | 'user' | 'assistant' | 'tool', content: string | [...] }
   * - Tool calls in assistant messages, tool results as separate 'tool' role messages
   *
   * Cache support:
   * - If useCache is true and model is Anthropic, uses multipart format with cache_control
   * - System prompt gets cache_control marker
   * - Message at cacheBreakpointIndex gets cache_control marker
   */
  private convertMessages(
    messages: MessageWithParts[],
    systemPrompt?: string,
    cacheBreakpointIndex?: number,
    useCache: boolean = false,
  ): OpenAI.ChatCompletionMessageParam[] {
    const openaiMessages: OpenAI.ChatCompletionMessageParam[] = []

    // Add system prompt if provided
    if (systemPrompt) {
      if (useCache) {
        // Use multipart format with cache_control for Anthropic
        openaiMessages.push({
          role: "system",
          content: [
            {
              type: "text" as const,
              text: systemPrompt,
              cache_control: { type: "ephemeral" as const },
            } as any, // OpenRouter accepts this
          ],
        })
      } else {
        // Simple string format for non-Anthropic models
        openaiMessages.push({
          role: "system",
          content: systemPrompt,
        })
      }
    }

    // Track current index for cache breakpoint
    let currentMessageIndex = 0

    for (const msg of messages) {
      const role = msg.info.role === "user" ? "user" : "assistant"
      const shouldCache =
        useCache &&
        cacheBreakpointIndex !== undefined &&
        currentMessageIndex === cacheBreakpointIndex

      // Collect text content
      const textParts: string[] = []
      const toolCalls: OpenAI.ChatCompletionMessageToolCall[] = []
      const toolResults: { tool_call_id: string; content: string }[] = []

      // Convert each part
      for (const part of msg.parts) {
        if (part.type === "text") {
          textParts.push(part.text)
        } else if (part.type === "tool") {
          if (
            role === "assistant" &&
            (part.state.status === "completed" || part.state.status === "error")
          ) {
            // Add tool call to assistant message
            toolCalls.push({
              id: part.callID,
              type: "function",
              function: {
                name: part.tool,
                arguments: JSON.stringify(part.state.input || {}),
              },
            })

            // Add tool result
            if (part.state.status === "completed") {
              toolResults.push({
                tool_call_id: part.callID,
                content: part.state.output || "",
              })
            } else {
              toolResults.push({
                tool_call_id: part.callID,
                content: `Error: ${part.state.error || "Unknown error"}`,
              })
            }
          } else if (role === "user") {
            // User messages with tool results
            if (part.state.status === "completed") {
              toolResults.push({
                tool_call_id: part.callID,
                content: part.state.output || "",
              })
            } else if (part.state.status === "error") {
              toolResults.push({
                tool_call_id: part.callID,
                content: `Error: ${part.state.error || "Unknown error"}`,
              })
            }
          }
          // Skip pending/running tools - they don't have results yet
        }
        // Other part types (file, reasoning, etc.) are handled differently or skipped
      }

      // Add the main message
      if (role === "assistant") {
        if (toolCalls.length > 0) {
          // Assistant message with tool calls
          openaiMessages.push({
            role: "assistant",
            content: textParts.join("\n") || null,
            tool_calls: toolCalls,
          })

          // Add tool results as separate 'tool' role messages
          for (const result of toolResults) {
            openaiMessages.push({
              role: "tool",
              tool_call_id: result.tool_call_id,
              content: result.content,
            })
          }
        } else if (textParts.length > 0) {
          // Simple text message
          if (shouldCache && useCache) {
            // Use multipart format with cache_control
            openaiMessages.push({
              role: "assistant",
              content: [
                {
                  type: "text" as const,
                  text: textParts.join("\n"),
                  cache_control: { type: "ephemeral" as const },
                } as any,
              ],
            })
          } else {
            openaiMessages.push({
              role: "assistant",
              content: textParts.join("\n"),
            })
          }
        }
      } else {
        // User message
        if (toolResults.length > 0) {
          // User message with tool results (shouldn't normally happen, but handle it)
          for (const result of toolResults) {
            openaiMessages.push({
              role: "tool",
              tool_call_id: result.tool_call_id,
              content: result.content,
            })
          }
        }
        if (textParts.length > 0) {
          if (shouldCache && useCache) {
            // Use multipart format with cache_control
            openaiMessages.push({
              role: "user",
              content: [
                {
                  type: "text" as const,
                  text: textParts.join("\n"),
                  cache_control: { type: "ephemeral" as const },
                } as any,
              ],
            })
          } else {
            openaiMessages.push({
              role: "user",
              content: textParts.join("\n"),
            })
          }
        }
      }

      // Increment message index
      currentMessageIndex++
    }

    return openaiMessages
  }

  /**
   * Create a structured LLM error from OpenRouter/OpenAI error
   */
  private createLLMError(error: any, context: Record<string, any>): LLMError {
    // OpenAI SDK errors have specific structures (OpenRouter uses same format)
    if (error instanceof OpenAI.APIError) {
      const status = error.status

      // Extract OpenRouter metadata (contains provider-specific error details)
      const metadata = (error as any).error?.metadata
      const providerName = metadata?.provider_name
      const rawError = metadata?.raw

      // Log the full error details for debugging
      if (metadata) {
        log.error("OpenRouterLLM", "Provider error metadata", undefined, {
          statusCode: status,
          providerName,
          rawError: typeof rawError === "string" ? rawError : JSON.stringify(rawError),
          errorMessage: error.message,
        })
      }

      // Check if this is a context length exceeded error
      const isContextLengthError = this.isContextLengthError(error.message, rawError)

      // Add metadata to context for upstream handling
      const enrichedContext = {
        ...context,
        providerName,
        rawError: typeof rawError === "string" ? rawError : JSON.stringify(rawError),
        isContextLengthError,
      }

      if (status === 401) {
        return new LLMError(
          "Configuration error. Verify your OpenRouter API key.",
          `OpenRouter authentication failed: ${error.message}`,
          enrichedContext,
          error,
        )
      }

      if (status === 429) {
        return new LLMError(
          "The service is too busy. Try again in a few seconds.",
          `OpenRouter rate limit exceeded: ${error.message}`,
          enrichedContext,
          error,
        )
      }

      if (status === 500 || status === 502 || status === 503) {
        return new LLMError(
          "The OpenRouter service is temporarily unavailable.",
          `OpenRouter service unavailable: ${error.message}`,
          enrichedContext,
          error,
        )
      }

      if (status === 400) {
        // Provide more specific user message for context length errors
        const userMessage = isContextLengthError
          ? "The conversation is too long. Attempting to summarize..."
          : "Error in the request to OpenRouter."

        return new LLMError(
          userMessage,
          `OpenRouter request error: ${error.message}`,
          enrichedContext,
          error,
        )
      }

      if (status === 413) {
        // 413 Payload Too Large - typically means context/prompt is too large
        // Mark as context length error to trigger auto-compaction
        return new LLMError(
          "The conversation is too long. Attempting to summarize...",
          `OpenRouter error: ${error.message}`,
          { ...enrichedContext, isContextLengthError: true },
          error,
        )
      }
    }

    // Generic error
    return new LLMError(
      "Cannot connect to OpenRouter. Try again in a few seconds.",
      `OpenRouter error: ${error.message || "Unknown error"}`,
      context,
      error instanceof Error ? error : undefined,
    )
  }

  /**
   * Check if the error is related to context length being exceeded
   */
  private isContextLengthError(message: string, rawError: any): boolean {
    const errorStr = typeof rawError === "string" ? rawError : JSON.stringify(rawError || "")
    const combinedText = `${message} ${errorStr}`.toLowerCase()

    // Common patterns for context length errors across providers
    const contextLengthPatterns = [
      "context_length_exceeded",
      "context length",
      "token limit",
      "tokens >",
      "prompt is too long",
      "maximum context",
      "max_tokens",
      "exceeds the model",
      "input too long",
      "request too large",
    ]

    return contextLengthPatterns.some((pattern) => combinedText.includes(pattern))
  }

  getProviderInfo() {
    return {
      name: "OpenRouter",
      model: this.defaultModel,
      capabilities: {
        streaming: true,
        tools: true,
        thinking: false,
        autoRouting: this.defaultModel === "openrouter/auto",
      },
      routingStrategy: this.config.routingStrategy,
    }
  }
}

/**
 * OpenRouter Popular Models Reference (2025)
 *
 * Cost-effective models:
 * - deepseek/deepseek-chat: DeepSeek V3 - Excellent for coding ($0.27/$1.10 per M tokens)
 * - meta-llama/llama-3.3-70b-instruct: Llama 3.3 70B - Free or very cheap
 * - qwen/qwen-2.5-coder-32b-instruct: Qwen 2.5 Coder - Specialized for code
 *
 * Auto-routing:
 * - openrouter/auto: Intelligent model selection based on task
 *   - Set route: 'cheapest' for cost optimization
 *   - Set route: 'fastest' for speed
 *   - Set route: 'best' for quality (default)
 *
 * Premium models (via OpenRouter):
 * - anthropic/claude-sonnet-4.5: Claude Sonnet via OpenRouter
 * - openai/gpt-4o: GPT-4o via OpenRouter
 *
 * Check https://openrouter.ai/models for current pricing and availability
 */
