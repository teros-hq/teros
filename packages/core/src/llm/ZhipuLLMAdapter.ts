/**
 * ZhipuLLMAdapter - Z.ai/ZhipuAI implementation of ILLMClient
 *
 * Z.ai (ZhipuAI) provides GLM models with an OpenAI-compatible API.
 * This adapter uses the OpenAI SDK with a custom base URL.
 *
 * API Documentation: https://docs.z.ai/
 *
 * Base URLs:
 * - Overseas: https://api.z.ai/api/paas/v4/
 * - China: https://open.bigmodel.cn/api/paas/v4/
 */

import OpenAI from 'openai';
import { LLMError } from '../errors/AgentError';
import { log } from '../logger';
import type { MessageWithParts, ToolPart } from '../session/types';
import type { ILLMClient, LLMResponse, StreamMessageOptions, ToolCall } from './ILLMClient';

// Default base URL for Z.ai API (overseas)
const DEFAULT_BASE_URL = 'https://api.z.ai/api/paas/v4/';
// Alternative base URL for mainland China
const CHINA_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4/';

export interface ZhipuConfig {
  apiKey: string;
  /** Model string is required - e.g. 'glm-4.6', 'glm-4', 'glm-4v' */
  model: string;
  /** Base URL - defaults to overseas API */
  baseUrl?: string;
  /** Use China API endpoint instead */
  useChina?: boolean;
  defaultMaxTokens?: number;
}

/**
 * Zhipu AI (Z.ai) LLM Adapter
 *
 * Implements the generic ILLMClient interface using OpenAI SDK
 * with Z.ai's OpenAI-compatible endpoint.
 */
export class ZhipuLLMAdapter implements ILLMClient {
  private client: OpenAI;
  private defaultModel: string;
  private defaultMaxTokens: number;

  constructor(config: ZhipuConfig) {
    if (!config.model) {
      throw new Error('ZhipuLLMAdapter: model is required - no defaults allowed');
    }

    // Determine base URL
    let baseUrl = config.baseUrl;
    if (!baseUrl) {
      baseUrl = config.useChina ? CHINA_BASE_URL : DEFAULT_BASE_URL;
    }

    // Use OpenAI SDK with custom base URL
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: baseUrl,
    });

    this.defaultModel = config.model;
    this.defaultMaxTokens = config.defaultMaxTokens || 8192;

    log.info('ZhipuLLM', 'Initialized ZhipuLLMAdapter', {
      model: this.defaultModel,
      baseUrl,
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

    log.info('ZhipuLLM', 'Calling Z.ai API', {
      model: model || this.defaultModel,
      messageCount: openaiMessages.length,
      toolCount: openaiTools?.length || 0,
      maxTokens: maxTokens || this.defaultMaxTokens,
      temperature: temperature ?? 0.7,
    });

    try {
      // Create streaming request
      const stream = await this.client.chat.completions.create(
        {
          model: model || this.defaultModel,
          max_tokens: maxTokens || this.defaultMaxTokens,
          temperature: temperature ?? 0.7,
          messages: openaiMessages,
          tools: openaiTools?.length ? openaiTools : undefined,
          stream: true,
        },
        {
          signal,
        },
      );

      let hasToolCalls = false;
      const toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();
      let finishReason: string | null = null;
      let usage: { prompt_tokens?: number; completion_tokens?: number } = {};

      // Process stream events
      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (!choice) continue;

        // Handle text content
        if (choice.delta?.content) {
          await callbacks?.onText?.(choice.delta.content);
        }

        // Handle tool calls
        if (choice.delta?.tool_calls) {
          for (const toolCall of choice.delta.tool_calls) {
            const index = toolCall.index;

            if (!toolCalls.has(index)) {
              toolCalls.set(index, {
                id: toolCall.id || `call_${index}`,
                name: toolCall.function?.name || '',
                arguments: '',
              });
            }

            const existing = toolCalls.get(index)!;
            if (toolCall.function?.name) {
              existing.name = toolCall.function.name;
            }
            if (toolCall.function?.arguments) {
              existing.arguments += toolCall.function.arguments;
            }
          }
          hasToolCalls = true;
        }

        // Track finish reason
        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
        }

        // Track usage if provided in stream
        if (chunk.usage) {
          usage = chunk.usage;
        }
      }

      // Notify text end
      await callbacks?.onTextEnd?.();

      // Process completed tool calls
      for (const [, toolCallData] of toolCalls) {
        try {
          const toolCall: ToolCall = {
            id: toolCallData.id,
            name: toolCallData.name,
            input: JSON.parse(toolCallData.arguments || '{}'),
          };
          await callbacks?.onToolCall?.(toolCall);
        } catch (e) {
          log.warn('ZhipuLLM', 'Failed to parse tool call arguments', {
            name: toolCallData.name,
            arguments: toolCallData.arguments,
          });
        }
      }

      // Determine stop reason
      let stopReason: LLMResponse['stopReason'] = 'end_turn';
      if (hasToolCalls || finishReason === 'tool_calls') {
        stopReason = 'tool_calls';
      } else if (finishReason === 'length') {
        stopReason = 'max_tokens';
      }

      log.info('ZhipuLLM', 'Response complete', {
        stopReason,
        inputTokens: usage.prompt_tokens,
        outputTokens: usage.completion_tokens,
        model: model || this.defaultModel,
      });

      return {
        stopReason,
        usage: usage.prompt_tokens
          ? {
              inputTokens: usage.prompt_tokens,
              outputTokens: usage.completion_tokens || 0,
            }
          : undefined,
        metadata: {
          provider: 'zhipu',
          model: model || this.defaultModel,
          finishReason,
        },
      };
    } catch (error: any) {
      // Check if it's an abort
      if (signal?.aborted) {
        log.warn('ZhipuLLM', 'Request aborted by user');
        return {
          stopReason: 'error',
          metadata: { error: 'Aborted by user' },
        };
      }

      // Create structured error - use Anthropic error handler as it's similar
      const llmError = LLMError.fromAnthropicError(error, {
        provider: 'zhipu',
        model: model || this.defaultModel,
        messageCount: openaiMessages.length,
        toolCount: openaiTools?.length || 0,
      });

      log.agentError('ZhipuLLM', llmError);

      // Throw the structured error
      throw llmError;
    }
  }

  /**
   * Convert MessageWithParts[] to OpenAI messages format
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
      const textParts = msg.parts
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('\n');

      // Collect tool parts (only from assistant messages)
      const toolParts = msg.parts.filter(
        (p): p is ToolPart => p.type === 'tool' && role === 'assistant',
      );

      // Collect tool results (completed or error)
      const toolResultParts = msg.parts.filter(
        (p): p is ToolPart =>
          p.type === 'tool' && (p.state.status === 'completed' || p.state.status === 'error'),
      );

      if (role === 'assistant') {
        // Build assistant message
        const assistantMsg: OpenAI.ChatCompletionAssistantMessageParam = {
          role: 'assistant',
          content: textParts || null,
        };

        // Add tool calls if present
        if (toolParts.length > 0) {
          assistantMsg.tool_calls = toolParts.map((p) => ({
            id: p.callID,
            type: 'function' as const,
            function: {
              name: p.tool,
              arguments: JSON.stringify(p.state.status === 'pending' ? {} : p.state.input || {}),
            },
          }));
        }

        if (textParts || assistantMsg.tool_calls?.length) {
          openaiMessages.push(assistantMsg);
        }

        // Add tool results as separate messages
        for (const toolPart of toolResultParts) {
          if (toolPart.state.status === 'completed') {
            openaiMessages.push({
              role: 'tool',
              tool_call_id: toolPart.callID,
              content: toolPart.state.output || '',
            });
          } else if (toolPart.state.status === 'error') {
            openaiMessages.push({
              role: 'tool',
              tool_call_id: toolPart.callID,
              content: `Error: ${toolPart.state.error}`,
            });
          }
        }
      } else {
        // User message
        if (textParts) {
          openaiMessages.push({
            role: 'user',
            content: textParts,
          });
        }
      }
    }

    return openaiMessages;
  }

  getProviderInfo() {
    return {
      name: 'Z.ai (ZhipuAI)',
      model: this.defaultModel,
      capabilities: {
        streaming: true,
        tools: true,
        vision: this.defaultModel.includes('v'), // glm-4v, glm-4.6v have vision
      },
    };
  }
}
