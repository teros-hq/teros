/**
 * AnthropicLLMAdapter - Anthropic implementation of ILLMClient
 *
 * This adapter converts between the previous implementation's MessageWithParts format
 * and Anthropic's API format, enabling provider-agnostic LLM usage.
 *
 * Architecture:
 * ConversationManager (uses the previous implementation types)
 *   ↓
 * ILLMClient interface (generic)
 *   ↓
 * AnthropicAdapter (converts the previous implementation ↔ Anthropic)
 *   ↓
 * Anthropic SDK
 */

import Anthropic from '@anthropic-ai/sdk';
import { LLMError } from '../errors/AgentError';
import { createLogger, log } from '../logger';
import type { FilePart, MessageWithParts, ToolStateCompleted } from '../session/types';
import { collectEmbeddedImages, DocumentExtractor, formatDocumentsAsText } from './DocumentExtractor';
import { ImagePipeline, type ProcessedImage } from './ImagePipeline';

/**
 * Sanitize a tool call ID so it matches Anthropic's required pattern: ^[a-zA-Z0-9_-]+$
 * IDs stored in DB may come from other providers (e.g. OpenAI legacy format uses dots
 * and colons like "functions.bash-admin_bash:37"). We translate at the adapter boundary
 * so the DB remains provider-agnostic.
 */
function sanitizeToolId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}
import type { ILLMClient, LLMResponse, StreamMessageOptions, ToolCall } from './ILLMClient';

export interface AnthropicConfig {
  apiKey: string;
  /** Model string is required - no defaults */
  model: string;
  defaultMaxTokens?: number;
  /** Override base URL for Anthropic-compatible APIs (e.g., MiniMax) */
  baseURL?: string;
  /** Override provider name for logging/metadata (defaults to 'Anthropic') */
  providerName?: string;
}

/**
 * Anthropic LLM Adapter
 *
 * Implements the generic ILLMClient interface using Anthropic's SDK.
 * Handles all format conversions between the previous implementation and Anthropic formats.
 */
export class AnthropicLLMAdapter implements ILLMClient {
  private client: Anthropic;
  private defaultModel: string;
  private defaultMaxTokens: number;
  private providerName: string;
  private logger = createLogger('AnthropicLLM');
  private imagePipeline = new ImagePipeline();
  private documentExtractor = new DocumentExtractor();

  constructor(config: AnthropicConfig) {
    if (!config.model) {
      throw new Error('AnthropicLLMAdapter: model is required - no defaults allowed');
    }
    this.providerName = config.providerName || 'Anthropic';
    this.client = new Anthropic({
      apiKey: config.apiKey,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
      defaultHeaders: {
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
    });
    this.defaultModel = config.model;
    // Increased from 8192 to 16384 for complex coding tasks
    this.defaultMaxTokens = config.defaultMaxTokens || 16384;
  }

  /**
   * Main streaming method
   *
   * Converts the previous implementation MessageWithParts[] to Anthropic format,
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
    } = options;

    // Convert the previous implementation messages to Anthropic format
    // Pass cacheBreakpointIndex for optimal cache placement
    const anthropicMessages = await this.convertMessages(messages, cacheBreakpointIndex);

    // Convert tools to Anthropic format
    const anthropicTools = tools?.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
    }));

    log.info('AnthropicLLM', 'Calling Anthropic API', {
      model: model || this.defaultModel,
      messageCount: anthropicMessages.length,
      toolCount: anthropicTools?.length || 0,
      maxTokens: maxTokens || this.defaultMaxTokens,
      temperature: temperature ?? 0.7,
    });

    try {
      // Build system prompt with cache control for prompt caching
      // This caches the system prompt to reduce token usage on subsequent requests
      const systemWithCache = systemPrompt
        ? [
            {
              type: 'text' as const,
              text: systemPrompt,
              cache_control: { type: 'ephemeral' as const },
            },
          ]
        : undefined;

      // Build tools with cache control on the last tool
      // This caches the entire tool definitions block
      const toolsWithCache = anthropicTools?.length
        ? anthropicTools.map((tool, index) => {
            if (index === anthropicTools.length - 1) {
              // Add cache_control to the last tool to cache all tool definitions
              return {
                ...tool,
                cache_control: { type: 'ephemeral' as const },
              };
            }
            return tool;
          })
        : undefined;

      // Create streaming request with prompt caching enabled
      const stream = await this.client.messages.stream({
        model: model || this.defaultModel,
        max_tokens: maxTokens || this.defaultMaxTokens,
        temperature: temperature ?? 0.7,
        system: systemWithCache,
        messages: anthropicMessages,
        tools: toolsWithCache,
      });

      // Handle abort signal
      if (signal) {
        signal.addEventListener('abort', () => {
          log.warn('AnthropicLLM', 'Abort signal received, stopping stream');
          stream.controller.abort();
        });
      }

      let hasToolCalls = false;
      const toolCalls: ToolCall[] = [];
      let currentBlockType: string | null = null;

      // Process stream events
      for await (const event of stream) {
        // Handle different event types
        switch (event.type) {
          case 'content_block_start':
            currentBlockType = event.content_block.type;
            if (event.content_block.type === 'tool_use') {
              // Tool call starting
              log.debug('AnthropicLLM', 'Tool call started', {
                toolName: event.content_block.name,
              });
            }
            break;

          case 'content_block_delta':
            if (event.delta.type === 'text_delta') {
              // Text content streaming
              await callbacks?.onText?.(event.delta.text);
            } else if (event.delta.type === 'thinking_delta') {
              // Extended-thinking reasoning stream. Surfaced as progress so the
              // turn's stall watchdog counts a long-but-productive reasoning
              // block as activity, not a hang (TER-650).
              await callbacks?.onThinking?.(event.delta.thinking);
            } else if (event.delta.type === 'input_json_delta') {
              // Tool input streaming: the SDK accumulates it for finalMessage();
              // surface it as a heartbeat so a long tool-args generation never
              // reads as a frozen socket to the stall watchdog (TER-650).
              await callbacks?.onToolInputDelta?.(event.delta.partial_json);
            }
            break;

          case 'content_block_stop':
            // Block completed - notify if it was a text block
            if (currentBlockType === 'text') {
              await callbacks?.onTextEnd?.();
            }
            currentBlockType = null;
            break;

          case 'message_delta':
            // Message metadata updates
            break;

          case 'message_stop':
            // Message completed
            break;
        }
      }

      // Get final message
      const finalMessage = await stream.finalMessage();

      // Extract tool calls from final message
      for (const block of finalMessage.content) {
        if (block.type === 'tool_use') {
          hasToolCalls = true;
          const toolCall: ToolCall = {
            id: block.id,
            name: block.name,
            input: block.input as Record<string, any>,
          };
          toolCalls.push(toolCall);

          // Call the callback
          await callbacks?.onToolCall?.(toolCall);
        }
      }

      // Determine stop reason
      let stopReason: LLMResponse['stopReason'] = 'end_turn';
      if (hasToolCalls) {
        stopReason = 'tool_calls';
      } else if (finalMessage.stop_reason === 'max_tokens') {
        stopReason = 'max_tokens';
      }

      // Extract usage including cache tokens
      const usage = finalMessage.usage
        ? {
            inputTokens: finalMessage.usage.input_tokens,
            outputTokens: finalMessage.usage.output_tokens,
            // Anthropic returns these for prompt caching
            cacheCreationInputTokens: (finalMessage.usage as any).cache_creation_input_tokens,
            cacheReadInputTokens: (finalMessage.usage as any).cache_read_input_tokens,
          }
        : undefined;

      log.info('AnthropicLLM', 'Response complete', {
        stopReason,
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
        cacheCreation: usage?.cacheCreationInputTokens,
        cacheRead: usage?.cacheReadInputTokens,
        model: finalMessage.model,
        requestId: finalMessage.id,
      });

      return {
        stopReason,
        usage,
        metadata: {
          provider: this.providerName.toLowerCase(),
          model: finalMessage.model,
          id: finalMessage.id,
          stopSequence: finalMessage.stop_sequence,
        },
      };
    } catch (error: any) {
      // Check if it's an abort
      if (signal?.aborted) {
        log.warn('AnthropicLLM', 'Request aborted by user');
        return {
          stopReason: 'error',
          metadata: { error: 'Aborted by user' },
        };
      }

      // Create structured error
      const llmError = LLMError.fromAnthropicError(error, {
        model: model || this.defaultModel,
        messageCount: anthropicMessages.length,
        toolCount: anthropicTools?.length || 0,
      });

      log.agentError('AnthropicLLM', llmError);

      // Throw the structured error
      throw llmError;
    }
  }

  /**
   * Convert the previous implementation MessageWithParts[] to Anthropic messages format
   *
   * the previous implementation format:
   * - MessageWithParts { info: Message, parts: Part[] }
   * - Each part has a type (text, tool, file, etc.)
   *
   * Anthropic format:
   * - { role: 'user' | 'assistant', content: [...] }
   * - Content can be text, image, or tool_use/tool_result
   *
   * IMPORTANT: Anthropic requires tool_use in assistant messages and tool_result in user messages
   * If an assistant message contains completed tools, we split it into:
   *   1. Assistant message with tool_use
   *   2. User message with tool_result
   *
   * CORRUPTION HANDLING:
   * - Filters out incomplete tools (no time.end = aborted/crashed)
   * - Filters out empty messages (no valid parts)
   * - Handles mixed text+tool+text patterns by splitting correctly
   *
   * @param messages - Messages to convert
   * @param cacheBreakpointIndex - Index in input messages where cache breakpoint should be placed.
   *                               If provided, cache_control will be added at this position.
   *                               If not provided, falls back to caching all but last 5 messages.
   */
  private async convertMessages(
    messages: MessageWithParts[],
    cacheBreakpointIndex?: number,
  ): Promise<Anthropic.MessageParam[]> {
    const anthropicMessages: Anthropic.MessageParam[] = [];

    // Track mapping from input message index to anthropic message indices
    // (one input message can become multiple anthropic messages due to tool splitting)
    const inputToAnthropicIndex: number[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const role = msg.info.role === 'user' ? 'user' : 'assistant';

      // Track where this input message starts in anthropic messages
      inputToAnthropicIndex[i] = anthropicMessages.length;

      // For assistant messages with tools, we need to handle the pattern:
      // [text, tool, text, tool, text] -> split into proper assistant/user pairs
      // Each tool_use must be immediately followed by its tool_result

      if (role === 'assistant') {
        await this.convertAssistantMessage(msg, anthropicMessages);
      } else {
        await this.convertUserMessage(msg, anthropicMessages);
      }
    }

    // Merge consecutive messages with the same role
    // This can happen after filtering out incomplete parts
    const mergedMessages = this.mergeConsecutiveMessages(anthropicMessages);

    // Filter out empty messages (messages with no content or only empty text blocks)
    // This prevents "text content blocks must be non-empty" errors from Anthropic
    const nonEmptyMessages = this.filterEmptyMessages(mergedMessages);

    // Add cache_control at the appropriate breakpoint
    // This tells Anthropic to cache everything up to this point
    this.applyCacheControl(nonEmptyMessages, inputToAnthropicIndex, cacheBreakpointIndex);

    return nonEmptyMessages;
  }

  /**
   * Convert an assistant message, handling the complex case of mixed text+tool patterns.
   *
   * Pattern: [text₁, tool₁, text₂, tool₂, text₃]
   * Becomes:
   *   - assistant: [text₁, tool_use₁]
   *   - user: [tool_result₁]
   *   - assistant: [text₂, tool_use₂]
   *   - user: [tool_result₂]
   *   - assistant: [text₃]  (only if non-empty)
   */
  private async convertAssistantMessage(
    msg: MessageWithParts,
    anthropicMessages: Anthropic.MessageParam[],
  ): Promise<void> {
    let currentTextBlocks: Anthropic.TextBlockParam[] = [];

    for (const part of msg.parts) {
      if (part.type === 'text') {
        // Skip empty text
        if (!part.text?.trim()) continue;

        currentTextBlocks.push({
          type: 'text',
          text: part.text,
        });
      } else if (part.type === 'tool') {
        // INV-1: orphan tool_use must be remediated upstream (see
        // assertInvariantINV1 in PromptBuilder). Throw rather than skip —
        // silent skips previously hid the bug from the LLM's view.
        if (part.state.status !== 'completed' && part.state.status !== 'error') {
          throw new Error(
            `INV-1 violation reached AnthropicLLMAdapter: ToolPart ${part.callID} ` +
              `(tool=${part.tool}) has status=${part.state.status}. ` +
              `Expected 'completed' or 'error' — check assertInvariantINV1 in PromptBuilder.`,
          );
        }
        const toolState = part.state as { time?: { end?: number } };
        if (!toolState.time?.end) {
          throw new Error(
            `INV-1 violation reached AnthropicLLMAdapter: ToolPart ${part.callID} ` +
              `(tool=${part.tool}) has no time.end. Synthetic recovery missing.`,
          );
        }

        // Flush accumulated text + this tool_use as assistant message
        const assistantContent: Array<Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam> = [
          ...currentTextBlocks,
          {
            type: 'tool_use',
            id: sanitizeToolId(part.callID),
            name: part.tool,
            input: part.state.input || {},
          } as Anthropic.ToolUseBlockParam,
        ];

        anthropicMessages.push({
          role: 'assistant',
          content: assistantContent,
        });

        // Reset text accumulator
        currentTextBlocks = [];

        // Add tool_result as user message immediately after
        // Build content array that may include both text and image blocks
        const toolResultContent: Array<
          Anthropic.TextBlockParam | Anthropic.ImageBlockParam
        > = [];

        if (part.state.status === 'completed') {
          // Add text output
          toolResultContent.push({
            type: 'text',
            text: part.state.output ?? '',
          });

          // Process image attachments from tool result
          const attachments = (part.state as ToolStateCompleted).attachments;
          if (attachments && attachments.length > 0) {
            const imageAttachments = attachments.filter(
              (a): a is FilePart => a.type === 'file' && a.mime?.startsWith('image/')
            );
            if (imageAttachments.length > 0 && this.imagePipeline.supportsVision(this.defaultModel)) {
              try {
                const processedImages = await this.imagePipeline.processImages(
                  imageAttachments,
                  this.providerName.toLowerCase(),
                );
                for (const img of imageAttachments) {
                  const processed = processedImages.get(img.url);
                  if (processed) {
                    toolResultContent.push({
                      type: 'image',
                      source: {
                        type: 'base64',
                        media_type: processed.mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
                        data: processed.base64,
                      },
                    } as Anthropic.ImageBlockParam);
                  }
                }
              } catch (error: any) {
                log.error('AnthropicLLM', 'Failed to process tool result images', undefined, { reason: error.message });
              }
            }
          }
        } else {
          // Error state
          toolResultContent.push({
            type: 'text',
            text: part.state.error ?? 'Unknown error',
          });
        }

        const toolResult: Anthropic.ToolResultBlockParam = {
          type: 'tool_result',
          tool_use_id: sanitizeToolId(part.callID),
          content: toolResultContent,
          is_error: part.state.status !== 'completed',
        };

        anthropicMessages.push({
          role: 'user',
          content: [toolResult],
        });
      }
      // Skip other part types (file, reasoning, etc.)
    }

    // Flush any remaining text as final assistant message
    if (currentTextBlocks.length > 0) {
      anthropicMessages.push({
        role: 'assistant',
        content: currentTextBlocks,
      });
    }
  }

  /**
   * Convert a user message.
   * User messages can contain text, image, and tool_result blocks.
   */
  private async convertUserMessage(
    msg: MessageWithParts,
    anthropicMessages: Anthropic.MessageParam[],
  ): Promise<void> {
    const content: Array<
      Anthropic.TextBlockParam | Anthropic.ToolResultBlockParam | Anthropic.ImageBlockParam
    > = [];

    // Collect image file parts for batch processing
    const imageParts = msg.parts.filter(
      (p): p is import('../session/types').FilePart => p.type === 'file' && p.mime?.startsWith('image/') && msg.info.role === 'user'
    );

    // Process images through the pipeline
    let processedImages: Map<string, ProcessedImage> = new Map();
    if (imageParts.length > 0 && this.imagePipeline.supportsVision(this.defaultModel)) {
      try {
        processedImages = await this.imagePipeline.processImages(
          imageParts,
          this.providerName.toLowerCase(),
        );
      } catch (error: any) {
        log.error('AnthropicLLM', 'Failed to process images for message', undefined, { reason: error.message });
      }
    }

    // Extract text + embedded images from non-image documents (PPTX/DOCX/XLSX/ODT/PDF/RTF/plain text)
    const documentParts = msg.parts.filter(
      (p): p is import('../session/types').FilePart =>
        p.type === 'file' &&
        !p.mime?.startsWith('image/') &&
        DocumentExtractor.supportsDocument(p.mime) &&
        msg.info.role === 'user',
    );
    if (documentParts.length > 0) {
      try {
        const extracted = await this.documentExtractor.extractDocuments(documentParts);
        const documentText = formatDocumentsAsText(extracted);
        if (documentText) {
          content.push({ type: 'text', text: documentText });
        }
        const flat = collectEmbeddedImages(extracted);
        if (flat.length > 0 && this.imagePipeline.supportsVision(this.defaultModel)) {
          for (const img of flat) {
            const processed = await this.imagePipeline.processBuffer(
              img.buffer,
              img.mimeType,
              this.providerName.toLowerCase(),
            );
            if (processed) {
              content.push({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: processed.mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
                  data: processed.base64,
                },
              } as Anthropic.ImageBlockParam);
            }
          }
        } else if (flat.length > 0) {
          log.warn(
            'AnthropicLLM',
            `Model ${this.defaultModel} not vision-capable — skipping ${flat.length} embedded image(s) from document(s)`,
          );
        }
      } catch (error: any) {
        log.error('AnthropicLLM', 'Failed to extract documents for message', undefined, { reason: error.message });
      }
    }

    for (const part of msg.parts) {
      if (part.type === 'text') {
        // Skip empty text
        if (!part.text?.trim()) continue;

        content.push({
          type: 'text',
          text: part.text,
        });
      } else if (part.type === 'tool') {
        // User messages can contain tool_result directly (from previous architecture)
        const toolResultContent: Array<
          Anthropic.TextBlockParam | Anthropic.ImageBlockParam
        > = [];

        if (part.state.status === 'completed') {
          toolResultContent.push({
            type: 'text',
            text: part.state.output ?? '',
          });

          // Process image attachments from tool result
          const attachments = (part.state as ToolStateCompleted).attachments;
          if (attachments && attachments.length > 0) {
            const imageAttachments = attachments.filter(
              (a): a is FilePart => a.type === 'file' && a.mime?.startsWith('image/')
            );
            if (imageAttachments.length > 0 && this.imagePipeline.supportsVision(this.defaultModel)) {
              try {
                const processedImages = await this.imagePipeline.processImages(
                  imageAttachments,
                  this.providerName.toLowerCase(),
                );
                for (const img of imageAttachments) {
                  const processed = processedImages.get(img.url);
                  if (processed) {
                    toolResultContent.push({
                      type: 'image',
                      source: {
                        type: 'base64',
                        media_type: processed.mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
                        data: processed.base64,
                      },
                    } as Anthropic.ImageBlockParam);
                  }
                }
              } catch (error: any) {
                log.error('AnthropicLLM', 'Failed to process tool result images in user message', undefined, { reason: error.message });
              }
            }
          }

          content.push({
            type: 'tool_result',
            tool_use_id: sanitizeToolId(part.callID),
            content: toolResultContent,
            is_error: false,
          });
        } else if (part.state.status === 'error') {
          content.push({
            type: 'tool_result',
            tool_use_id: sanitizeToolId(part.callID),
            content: part.state.error ?? 'Unknown error',
            is_error: true,
          });
        }
        // Skip pending/running tools
      } else if (part.type === 'file' && part.mime?.startsWith('image/') && msg.info.role === 'user') {
        // Convert image file to Anthropic image block
        const processed = processedImages.get(part.url);
        if (processed) {
          content.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: processed.mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
              data: processed.base64,
            },
          } as Anthropic.ImageBlockParam);
        }
        // If processing failed, skip silently (already logged by pipeline)
      }
    }

    // Only add message if it has content
    if (content.length > 0) {
      anthropicMessages.push({
        role: 'user',
        content,
      });
    }
  }

  /**
   * Merge consecutive messages with the same role.
   * This can happen after filtering out incomplete parts.
   */
  private mergeConsecutiveMessages(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
    if (messages.length === 0) return messages;

    const merged: Anthropic.MessageParam[] = [];

    for (const msg of messages) {
      const last = merged[merged.length - 1];

      if (last && last.role === msg.role) {
        // Merge content arrays
        const lastContent = Array.isArray(last.content)
          ? last.content
          : [{ type: 'text' as const, text: last.content as string }];
        const msgContent = Array.isArray(msg.content)
          ? msg.content
          : [{ type: 'text' as const, text: msg.content as string }];

        merged[merged.length - 1] = {
          role: msg.role,
          content: [...lastContent, ...msgContent] as any,
        };
      } else {
        merged.push(msg);
      }
    }

    return merged;
  }

  /**
   * Filter out messages with no content or only empty text blocks.
   * This prevents "text content blocks must be non-empty" errors from Anthropic.
   */
  private filterEmptyMessages(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
    return messages.filter((msg) => {
      // Handle string content (should always be non-empty if it exists)
      if (typeof msg.content === 'string') {
        return msg.content.trim().length > 0;
      }

      // Handle array content
      if (Array.isArray(msg.content)) {
        // Filter out empty content blocks
        const nonEmptyBlocks = msg.content.filter((block) => {
          // Text blocks must have non-empty text
          if (block.type === 'text') {
            return block.text && block.text.trim().length > 0;
          }
          // All other block types (tool_use, tool_result, image, etc.) are considered non-empty
          return true;
        });

        // Message is valid if it has at least one non-empty block
        return nonEmptyBlocks.length > 0;
      }

      // If content is neither string nor array, something is wrong - filter it out
      log.warn('AnthropicLLM', 'Message with invalid content type', { msg });
      return false;
    });
  }

  /**
   * Apply cache_control to the appropriate message for prompt caching.
   */
  private applyCacheControl(
    messages: Anthropic.MessageParam[],
    inputToAnthropicIndex: number[],
    cacheBreakpointIndex?: number,
  ): void {
    let anthropicCacheIndex: number;

    if (cacheBreakpointIndex !== undefined && cacheBreakpointIndex >= 0) {
      // Use provided breakpoint - map from input index to anthropic index
      // We want to cache up to and including the message at cacheBreakpointIndex
      // So we find the last anthropic message that corresponds to this input message
      const startIdx = inputToAnthropicIndex[cacheBreakpointIndex] ?? -1;
      const nextIdx = inputToAnthropicIndex[cacheBreakpointIndex + 1] ?? messages.length;
      anthropicCacheIndex = nextIdx - 1; // Last anthropic message for this input message

      log.debug('AnthropicLLM', 'Using provided cache breakpoint', {
        inputIndex: cacheBreakpointIndex,
        anthropicIndex: anthropicCacheIndex,
        totalMessages: messages.length,
      });
    } else {
      // Fallback: mod-N strategy — snap to nearest lower multiple of BLOCK_SIZE.
      // This prevents cache thrashing when cacheBreakpointIndex is not provided.
      const BLOCK_SIZE = 20;
      const snapped = Math.floor(messages.length / BLOCK_SIZE) * BLOCK_SIZE;
      anthropicCacheIndex = snapped > 0 ? snapped - 1 : -1;
    }

    // Apply cache_control to the breakpoint message
    if (anthropicCacheIndex >= 0 && anthropicCacheIndex < messages.length) {
      const messageToCache = messages[anthropicCacheIndex];

      if (
        messageToCache &&
        Array.isArray(messageToCache.content) &&
        messageToCache.content.length > 0
      ) {
        const lastBlock = messageToCache.content[messageToCache.content.length - 1] as any;
        lastBlock.cache_control = { type: 'ephemeral' };
      }
    }
  }

  getProviderInfo() {
    return {
      name: this.providerName,
      model: this.defaultModel,
      capabilities: {
        streaming: true,
        tools: true,
        thinking: true,
        vision: this.imagePipeline.supportsVision(this.defaultModel),
      },
    };
  }
}
