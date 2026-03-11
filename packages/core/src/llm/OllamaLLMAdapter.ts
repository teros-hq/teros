/**
 * OllamaLLMAdapter - Ollama implementation of ILLMClient
 *
 * This adapter enables using local Ollama models through the OpenAI-compatible API.
 * Ollama exposes an OpenAI-compatible endpoint at /v1/chat/completions
 *
 * Architecture:
 * ConversationManager (uses MessageWithParts types)
 *   ↓
 * ILLMClient interface (generic)
 *   ↓
 * OllamaAdapter (converts MessageWithParts ↔ Ollama/OpenAI format)
 *   ↓
 * Ollama API (OpenAI-compatible)
 */

import OpenAI from 'openai';
import { LLMError } from '../errors/AgentError';
import { createLogger, log } from '../logger';
import type { MessageWithParts } from '../session/types';
import type { ILLMClient, LLMResponse, StreamMessageOptions, ToolCall } from './ILLMClient';

export interface OllamaConfig {
  /** Base URL for Ollama API (e.g., 'http://midgar:11434' or 'http://localhost:11434') */
  baseUrl: string;
  /** Model name (e.g., 'qwen2.5:7b-instruct', 'deepseek-r1:latest') */
  model: string;
  /** Default max tokens for completion */
  defaultMaxTokens?: number;
}

/**
 * Ollama LLM Adapter
 *
 * Implements the generic ILLMClient interface using Ollama's OpenAI-compatible API.
 * Handles all format conversions between MessageWithParts and OpenAI formats.
 */
export class OllamaLLMAdapter implements ILLMClient {
  private client: OpenAI;
  private defaultModel: string;
  private defaultMaxTokens: number;
  private baseUrl: string;
  private logger = createLogger('OllamaLLM');

  constructor(config: OllamaConfig) {
    if (!config.model) {
      throw new Error('OllamaLLMAdapter: model is required');
    }
    if (!config.baseUrl) {
      throw new Error('OllamaLLMAdapter: baseUrl is required');
    }

    this.baseUrl = config.baseUrl;
    
    // Ollama's OpenAI-compatible API is at /v1
    const apiBaseUrl = config.baseUrl.endsWith('/v1') 
      ? config.baseUrl 
      : `${config.baseUrl}/v1`;

    this.client = new OpenAI({
      apiKey: 'ollama', // Ollama doesn't require a real API key, but the SDK requires something
      baseURL: apiBaseUrl,
    });
    
    this.defaultModel = config.model;
    this.defaultMaxTokens = config.defaultMaxTokens || 32768;

    log.info('OllamaLLM', 'Initialized Ollama adapter', {
      baseUrl: apiBaseUrl,
      model: this.defaultModel,
    });
  }

  /**
   * Main streaming method
   *
   * Converts MessageWithParts[] to OpenAI format,
   * streams the response, and calls callbacks for real-time updates.
   */
  async streamMessage(options: StreamMessageOptions): Promise<LLMResponse> {
    const { messages, tools, systemPrompt, model, temperature, maxTokens, signal, callbacks } =
      options;

    // Convert messages to OpenAI format
    const openaiMessages = this.convertMessages(messages, systemPrompt);

    // Convert tools to OpenAI format
    const openaiTools = tools?.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }));

    log.info('OllamaLLM', 'Calling Ollama API', {
      baseUrl: this.baseUrl,
      model: model || this.defaultModel,
      messageCount: openaiMessages.length,
      toolCount: openaiTools?.length || 0,
      maxTokens: maxTokens || this.defaultMaxTokens,
      temperature: temperature ?? 0.7,
    });

    try {
      const createParams: any = {
        model: model || this.defaultModel,
        temperature: temperature ?? 0.7,
        messages: openaiMessages,
        tools: openaiTools?.length ? openaiTools : undefined,
        stream: true,
        max_tokens: maxTokens || this.defaultMaxTokens,
      };

      // Create streaming request
      const stream = (await this.client.chat.completions.create(createParams, {
        signal,
      })) as unknown as AsyncIterable<any>;

      let hasToolCalls = false;
      const toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();
      let finishReason: string | null = null;
      let totalInputTokens = 0;
      let totalOutputTokens = 0;

      // Process stream events
      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (!choice) continue;

        const delta = choice.delta;

        // Handle text content
        if (delta.content) {
          await callbacks?.onText?.(delta.content);
        }

        // Handle tool calls (streamed incrementally)
        if (delta.tool_calls) {
          for (const toolCallDelta of delta.tool_calls) {
            const index = toolCallDelta.index;

            if (!toolCalls.has(index)) {
              toolCalls.set(index, {
                id: toolCallDelta.id || '',
                name: toolCallDelta.function?.name || '',
                arguments: '',
              });
            }

            const toolCall = toolCalls.get(index)!;

            if (toolCallDelta.id) {
              toolCall.id = toolCallDelta.id;
            }
            if (toolCallDelta.function?.name) {
              toolCall.name = toolCallDelta.function.name;
            }
            if (toolCallDelta.function?.arguments) {
              toolCall.arguments += toolCallDelta.function.arguments;
            }
          }
        }

        // Capture finish reason
        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
        }

        // Capture usage (usually in the last chunk)
        if (chunk.usage) {
          totalInputTokens = chunk.usage.prompt_tokens || 0;
          totalOutputTokens = chunk.usage.completion_tokens || 0;
        }
      }

      // Notify text end if we had any text
      await callbacks?.onTextEnd?.();

      // Process completed tool calls
      if (toolCalls.size > 0) {
        hasToolCalls = true;
        for (const [_, tc] of toolCalls) {
          let parsedInput: Record<string, any> = {};
          try {
            parsedInput = JSON.parse(tc.arguments || '{}');
          } catch (e) {
            log.warn('OllamaLLM', 'Failed to parse tool arguments', {
              toolName: tc.name,
              arguments: tc.arguments,
            });
          }

          const toolCall: ToolCall = {
            id: tc.id,
            name: tc.name,
            input: parsedInput,
          };

          await callbacks?.onToolCall?.(toolCall);
        }
      }

      // Determine stop reason
      let stopReason: LLMResponse['stopReason'] = 'end_turn';
      if (hasToolCalls || finishReason === 'tool_calls') {
        stopReason = 'tool_calls';
      } else if (finishReason === 'length') {
        stopReason = 'max_tokens';
      }

      const usage = {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
      };

      log.info('OllamaLLM', 'Response complete', {
        stopReason,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        model: model || this.defaultModel,
      });

      return {
        stopReason,
        usage,
        metadata: {
          provider: 'ollama',
          model: model || this.defaultModel,
          finishReason,
        },
      };
    } catch (error: any) {
      // Check if it's an abort
      if (signal?.aborted) {
        log.warn('OllamaLLM', 'Request aborted by user');
        return {
          stopReason: 'error',
          metadata: { error: 'Aborted by user' },
        };
      }

      // Create structured error
      const llmError = this.createLLMError(error, {
        baseUrl: this.baseUrl,
        model: model || this.defaultModel,
        messageCount: openaiMessages.length,
        toolCount: openaiTools?.length || 0,
      });

      log.agentError('OllamaLLM', llmError);

      // Throw the structured error
      throw llmError;
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
    const openaiMessages: OpenAI.ChatCompletionMessageParam[] = [];

    // Add system prompt if provided
    if (systemPrompt) {
      openaiMessages.push({
        role: 'system',
        content: systemPrompt,
      });
    }

    for (const msg of messages) {
      const role = msg.info.role === 'user' ? 'user' : 'assistant';

      // Collect text content
      const textParts: string[] = [];
      const toolCalls: OpenAI.ChatCompletionMessageToolCall[] = [];
      const toolResults: { tool_call_id: string; content: string }[] = [];

      // Convert each part
      for (const part of msg.parts) {
        if (part.type === 'text') {
          textParts.push(part.text);
        } else if (part.type === 'tool') {
          if (
            role === 'assistant' &&
            (part.state.status === 'completed' || part.state.status === 'error')
          ) {
            // Add tool call to assistant message
            toolCalls.push({
              id: part.callID,
              type: 'function',
              function: {
                name: part.tool,
                arguments: JSON.stringify(part.state.input || {}),
              },
            });

            // Add tool result
            if (part.state.status === 'completed') {
              toolResults.push({
                tool_call_id: part.callID,
                content: part.state.output || '',
              });
            } else {
              toolResults.push({
                tool_call_id: part.callID,
                content: `Error: ${part.state.error || 'Unknown error'}`,
              });
            }
          } else if (role === 'user') {
            // User messages with tool results
            if (part.state.status === 'completed') {
              toolResults.push({
                tool_call_id: part.callID,
                content: part.state.output || '',
              });
            } else if (part.state.status === 'error') {
              toolResults.push({
                tool_call_id: part.callID,
                content: `Error: ${part.state.error || 'Unknown error'}`,
              });
            }
          }
          // Skip pending/running tools - they don't have results yet
        }
        // Other part types (file, reasoning, etc.) are handled differently or skipped
      }

      // Add the main message
      if (role === 'assistant') {
        if (toolCalls.length > 0) {
          // Assistant message with tool calls
          openaiMessages.push({
            role: 'assistant',
            content: textParts.join('\n') || null,
            tool_calls: toolCalls,
          });

          // Add tool results as separate 'tool' role messages
          for (const result of toolResults) {
            openaiMessages.push({
              role: 'tool',
              tool_call_id: result.tool_call_id,
              content: result.content,
            });
          }
        } else if (textParts.length > 0) {
          // Simple text message
          openaiMessages.push({
            role: 'assistant',
            content: textParts.join('\n'),
          });
        }
      } else {
        // User message
        if (toolResults.length > 0) {
          // User message with tool results (shouldn't normally happen, but handle it)
          for (const result of toolResults) {
            openaiMessages.push({
              role: 'tool',
              tool_call_id: result.tool_call_id,
              content: result.content,
            });
          }
        }
        if (textParts.length > 0) {
          openaiMessages.push({
            role: 'user',
            content: textParts.join('\n'),
          });
        }
      }
    }

    return openaiMessages;
  }

  /**
   * Create a structured LLM error from Ollama error
   */
  private createLLMError(error: any, context: Record<string, any>): LLMError {
    // OpenAI SDK errors have specific structures
    if (error instanceof OpenAI.APIError) {
      const status = error.status;

      if (status === 404) {
        return new LLMError(
          'The model is not available in Ollama. Make sure the model is installed.',
          `Ollama model not found: ${error.message}`,
          context,
          error,
        );
      }

      if (status === 500 || status === 502 || status === 503) {
        return new LLMError(
          'Ollama service is unavailable. Make sure Ollama is running.',
          `Ollama service unavailable: ${error.message}`,
          context,
          error,
        );
      }

      if (status === 400) {
        return new LLMError(
          'Error en la solicitud a Ollama.',
          `Ollama request error: ${error.message}`,
          context,
          error,
        );
      }
    }

    // Network errors
    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      return new LLMError(
        `Cannot connect to Ollama at ${context.baseUrl}. Make sure the service is available.`,
        `Ollama connection error: ${error.message}`,
        context,
        error instanceof Error ? error : undefined,
      );
    }

    // Generic error
    return new LLMError(
      'Error al comunicar con Ollama. Intenta de nuevo en unos segundos.',
      `Ollama error: ${error.message || 'Unknown error'}`,
      context,
      error instanceof Error ? error : undefined,
    );
  }

  getProviderInfo() {
    return {
      name: 'Ollama',
      model: this.defaultModel,
      capabilities: {
        streaming: true,
        tools: true, // Ollama supports tools with compatible models
        thinking: false,
      },
    };
  }
}

/**
 * Ollama Models Reference
 *
 * Popular models for local inference:
 * - qwen2.5:7b-instruct: Fast and capable, good for general tasks (default: 32k tokens)
 * - qwen3-coder:30b: Specialized for coding tasks, excellent for development work
 * - deepseek-r1:latest: Reasoning-focused model
 * - nemotron-3-nano:30b: High-quality general purpose
 * - llama3.3:70b: Meta's flagship open model
 * - mistral:latest: Fast and efficient
 *
 * Recommended for Teros:
 * - qwen3-coder:30b: Best for software development and technical tasks
 *
 * Check available models with: ollama list
 * Pull new models with: ollama pull <model-name>
 */
