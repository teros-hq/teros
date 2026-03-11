/**
 * OpenAILLMAdapter - OpenAI implementation of ILLMClient
 *
 * This adapter converts between the MessageWithParts format
 * and OpenAI's API format, enabling provider-agnostic LLM usage.
 *
 * Architecture:
 * ConversationManager (uses MessageWithParts types)
 *   ↓
 * ILLMClient interface (generic)
 *   ↓
 * OpenAIAdapter (converts MessageWithParts ↔ OpenAI)
 *   ↓
 * OpenAI SDK
 */

import OpenAI from "openai"
import { LLMError } from "../errors/AgentError"
import { createLogger, log } from "../logger"
import type { MessageWithParts } from "../session/types"
import type { ILLMClient, LLMResponse, StreamMessageOptions, ToolCall } from "./ILLMClient"

export interface OpenAIConfig {
  apiKey: string
  /** Model string is required - no defaults */
  model: string
  defaultMaxTokens?: number
  /** Base URL for API (optional, for Azure or other OpenAI-compatible APIs) */
  baseUrl?: string
  /** Organization ID (optional) */
  organization?: string
}

/**
 * OpenAI LLM Adapter
 *
 * Implements the generic ILLMClient interface using OpenAI's SDK.
 * Handles all format conversions between MessageWithParts and OpenAI formats.
 */
export class OpenAILLMAdapter implements ILLMClient {
  private client: OpenAI
  private defaultModel: string
  private defaultMaxTokens: number
  private logger = createLogger("OpenAILLM")

  constructor(config: OpenAIConfig) {
    if (!config.model) {
      throw new Error("OpenAILLMAdapter: model is required - no defaults allowed")
    }
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      organization: config.organization,
    })
    this.defaultModel = config.model
    this.defaultMaxTokens = config.defaultMaxTokens || 8192
  }

  /**
   * Main streaming method
   *
   * Converts MessageWithParts[] to OpenAI format,
   * streams the response, and calls callbacks for real-time updates.
   */
  async streamMessage(options: StreamMessageOptions): Promise<LLMResponse> {
    const { messages, tools, systemPrompt, model, temperature, maxTokens, signal, callbacks } =
      options

    // Convert messages to OpenAI format
    const openaiMessages = this.convertMessages(messages, systemPrompt)

    // Convert tools to OpenAI format
    const openaiTools = tools?.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }))

    log.info("OpenAILLM", "Calling OpenAI API", {
      model: model || this.defaultModel,
      messageCount: openaiMessages.length,
      toolCount: openaiTools?.length || 0,
      maxTokens: maxTokens || this.defaultMaxTokens,
      temperature: temperature ?? 0.7,
    })

    try {
      // Determine max tokens parameter
      // O-series models use max_completion_tokens, others use max_tokens
      const maxTokensValue = maxTokens || this.defaultMaxTokens
      const modelName = model || this.defaultModel

      // Check if model uses max_completion_tokens (O-series)
      const isOSeries = modelName.startsWith("o")

      // Create streaming request with dynamic parameter
      const createParams: any = {
        model: modelName,
        temperature: temperature ?? 0.7,
        messages: openaiMessages,
        tools: openaiTools?.length ? openaiTools : undefined,
        stream: true,
      }

      // Add the appropriate token parameter
      if (isOSeries) {
        createParams.max_completion_tokens = maxTokensValue
      } else {
        createParams.max_tokens = maxTokensValue
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

      // Process stream events
      for await (const chunk of stream) {
        const choice = chunk.choices[0]
        if (!choice) continue

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
            log.warn("OpenAILLM", "Failed to parse tool arguments", {
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
      }

      log.info("OpenAILLM", "Response complete", {
        stopReason,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        model: model || this.defaultModel,
      })

      return {
        stopReason,
        usage,
        metadata: {
          provider: "openai",
          model: model || this.defaultModel,
          finishReason,
        },
      }
    } catch (error: any) {
      // Check if it's an abort
      if (signal?.aborted) {
        log.warn("OpenAILLM", "Request aborted by user")
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

      log.agentError("OpenAILLM", llmError)

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
   */
  private convertMessages(
    messages: MessageWithParts[],
    systemPrompt?: string,
  ): OpenAI.ChatCompletionMessageParam[] {
    const openaiMessages: OpenAI.ChatCompletionMessageParam[] = []

    // Add system prompt if provided
    if (systemPrompt) {
      openaiMessages.push({
        role: "system",
        content: systemPrompt,
      })
    }

    for (const msg of messages) {
      const role = msg.info.role === "user" ? "user" : "assistant"

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
          openaiMessages.push({
            role: "assistant",
            content: textParts.join("\n"),
          })
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
          openaiMessages.push({
            role: "user",
            content: textParts.join("\n"),
          })
        }
      }
    }

    return openaiMessages
  }

  /**
   * Create a structured LLM error from OpenAI error
   */
  private createLLMError(error: any, context: Record<string, any>): LLMError {
    // OpenAI SDK errors have specific structures
    if (error instanceof OpenAI.APIError) {
      const status = error.status

      if (status === 401) {
        return new LLMError(
          "Configuration error. Verify your OpenAI API key.",
          `OpenAI authentication failed: ${error.message}`,
          context,
          error,
        )
      }

      if (status === 429) {
        return new LLMError(
          "The service is very busy. Please try again in a few seconds.",
          `OpenAI rate limit exceeded: ${error.message}`,
          context,
          error,
        )
      }

      if (status === 500 || status === 502 || status === 503) {
        return new LLMError(
          "OpenAI service is temporarily unavailable.",
          `OpenAI service unavailable: ${error.message}`,
          context,
          error,
        )
      }

      if (status === 400) {
        return new LLMError(
          "Error en la solicitud a OpenAI.",
          `OpenAI request error: ${error.message}`,
          context,
          error,
        )
      }
    }

    // Generic error
    return new LLMError(
      "No puedo conectar con OpenAI. Intenta de nuevo en unos segundos.",
      `OpenAI error: ${error.message || "Unknown error"}`,
      context,
      error instanceof Error ? error : undefined,
    )
  }

  getProviderInfo() {
    return {
      name: "OpenAI",
      model: this.defaultModel,
      capabilities: {
        streaming: true,
        tools: true,
        thinking: false, // OpenAI o-series has reasoning but different from Claude's extended thinking
      },
    }
  }
}

/**
 * OpenAI Models Reference (2025)
 *
 * Flagship models:
 * - gpt-5.2: Latest flagship for advanced reasoning and coding
 * - gpt-5.1, gpt-5: Earlier GPT-5 family members
 *
 * O-series (reasoning focused):
 * - o3, o3-pro: Strong multimodal reasoning, o3-pro has extended reasoning time
 * - o4-mini: High-volume reasoning, cost-efficient
 *
 * GPT-4.x series:
 * - gpt-4.1: Recommended for coding and precise instruction following
 * - gpt-4.1-mini: Cost-efficient variant
 * - gpt-4o: Multimodal with image capabilities (legacy, migrating to 4.1/5.x)
 *
 * Deprecated:
 * - gpt-4.5-preview: Deprecated, migrate to gpt-4.1
 * - gpt-4, gpt-4-turbo: Largely retired
 * - gpt-3.5-turbo: Legacy
 *
 * Check https://platform.openai.com/docs/models for current availability
 */
