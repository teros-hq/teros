/**
 * AnthropicOAuthAdapter - Anthropic with OAuth authentication
 *
 * This adapter is similar to AnthropicLLMAdapter but uses OAuth Bearer tokens
 * instead of API keys. Required for Claude Max subscriptions.
 *
 * ============================================================================
 * IMPORTANT: Claude Code Impersonation Requirements
 * ============================================================================
 *
 * OAuth tokens obtained from Claude Max subscriptions are ONLY authorized for
 * use with Claude Code. Anthropic validates this on their servers. To use these
 * tokens, we MUST fulfill the following requirements:
 *
 * 1. BETA HEADER: Must include 'claude-code-20250219' in the anthropic-beta header
 *    Example: anthropic-beta: oauth-2025-04-20,claude-code-20250219
 *
 * 2. SYSTEM PROMPT FORMAT: Must be an ARRAY of text blocks (not a string)
 *    The FIRST element MUST be exactly:
 *    "You are Claude Code, Anthropic's official CLI for Claude."
 *
 *    Example:
 *    system: [
 *      { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
 *      { type: 'text', text: "Your actual system prompt here..." }
 *    ]
 *
 * 3. AUTHORIZATION: Use 'Authorization: Bearer <token>' (NOT 'x-api-key')
 *
 * If any of these requirements are not met, Anthropic will return:
 * - 401 Unauthorized, or
 * - 400 Bad Request with validation errors
 *
 * These requirements were discovered through trial and error - they are not
 * officially documented by Anthropic as of 2025-01.
 * ============================================================================
 *
 * Key differences from API key auth:
 * - Uses 'Authorization: Bearer <token>' instead of 'x-api-key'
 * - Requires 'anthropic-beta: oauth-2025-04-20,claude-code-20250219' headers
 * - Requires system prompt as array with Claude Code prefix (see above)
 * - Tokens expire and need refresh (handled automatically)
 */

import Anthropic from '@anthropic-ai/sdk';
import { LLMError } from '../errors/AgentError';
import { log } from '../logger';
import type { MessageWithParts } from '../session/types';
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
import {
  getOAuthAccessToken,
  getOAuthBetaHeaders,
  loadOAuthTokens,
  refreshOAuthTokens,
  tokensNeedRefresh,
} from './ClaudeOAuth';
import type { ILLMClient, LLMResponse, StreamMessageOptions, ToolCall } from './ILLMClient';

const MODULE = 'AnthropicOAuth';

// Required beta features for OAuth (claude-code-20250219 is REQUIRED for OAuth tokens)
const OAUTH_BETAS = [
  'oauth-2025-04-20',
  'claude-code-20250219',
  'interleaved-thinking-2025-05-14',
  'prompt-caching-2024-07-31',
];

// Required system prompt prefix for OAuth tokens (Anthropic restriction)
// OAuth tokens from Claude Max are only authorized for use with Claude Code
const CLAUDE_CODE_SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";

export interface AnthropicOAuthConfig {
  /** Model string is required - no defaults */
  model: string;
  defaultMaxTokens?: number;
  /** Optional: provide token directly instead of loading from storage */
  accessToken?: string;
}

/**
 * Anthropic OAuth Adapter
 *
 * Uses OAuth Bearer tokens for authentication with Claude Max subscriptions.
 * Automatically handles token refresh when needed.
 */
export class AnthropicOAuthAdapter implements ILLMClient {
  private client: Anthropic | null = null;
  private defaultModel: string;
  private defaultMaxTokens: number;
  private providedToken?: string;
  private imagePipeline = new ImagePipeline();
  private documentExtractor = new DocumentExtractor();

  constructor(config: AnthropicOAuthConfig) {
    if (!config.model) {
      throw new Error('AnthropicOAuthAdapter: model is required');
    }
    this.defaultModel = config.model;
    this.defaultMaxTokens = config.defaultMaxTokens || 8192;
    this.providedToken = config.accessToken;
  }

  /**
   * Get or create Anthropic client with valid OAuth token
   */
  private async getClient(): Promise<Anthropic> {
    // If token was provided directly, use it
    if (this.providedToken) {
      if (!this.client) {
        this.client = this.createClient(this.providedToken);
      }
      return this.client;
    }

    // Load tokens from storage
    const tokens = await loadOAuthTokens();
    if (!tokens) {
      throw new Error(
        'No OAuth tokens found. Run oauth:login first or provide accessToken in config.',
      );
    }

    // Check if refresh needed
    if (tokensNeedRefresh(tokens)) {
      log.info(MODULE, 'Refreshing OAuth token...');
      const refreshed = await refreshOAuthTokens(tokens.refreshToken);
      if (refreshed) {
        this.client = this.createClient(refreshed.accessToken);
        return this.client;
      }
      log.warn(MODULE, 'Token refresh failed, trying existing token');
    }

    // Create client with current token
    if (!this.client) {
      this.client = this.createClient(tokens.accessToken);
    }

    return this.client;
  }

  /**
   * Create Anthropic client with OAuth configuration
   */
  private createClient(accessToken: string): Anthropic {
    return new Anthropic({
      apiKey: accessToken, // SDK uses this as Bearer token when authToken is set
      // Use fetch to add custom headers
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers);

        // Replace x-api-key with Authorization Bearer
        headers.delete('x-api-key');
        headers.set('Authorization', `Bearer ${accessToken}`);

        // Add required beta header for OAuth
        const existingBetas = headers.get('anthropic-beta') || '';
        const allBetas = existingBetas
          ? `${existingBetas},${OAUTH_BETAS.join(',')}`
          : OAUTH_BETAS.join(',');
        headers.set('anthropic-beta', allBetas);

        return fetch(url, {
          ...init,
          headers,
        });
      },
    });
  }

  /**
   * Main streaming method
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

    const client = await this.getClient();

    // Convert messages to Anthropic format
    // Pass cacheBreakpointIndex for optimal cache placement
    const anthropicMessages = await this.convertMessages(messages, cacheBreakpointIndex);

    // Convert tools to Anthropic format with cache control on the last tool
    // This caches the entire tool definitions block
    const anthropicTools = tools?.map((tool, index) => {
      const baseTool = {
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema,
      };
      // Add cache_control to the last tool to cache all tool definitions
      if (tools && index === tools.length - 1) {
        return {
          ...baseTool,
          cache_control: { type: 'ephemeral' as const },
        };
      }
      return baseTool;
    });

    // OAuth tokens require Claude Code system prompt prefix (Anthropic restriction)
    // The system prompt must be an array with the Claude Code prefix as the first element
    // This is because Anthropic validates that OAuth tokens are only used with Claude Code
    // We add cache_control to the last block to enable prompt caching
    const systemPromptBlocks: Array<{
      type: 'text';
      text: string;
      cache_control?: { type: 'ephemeral' };
    }> = [{ type: 'text', text: CLAUDE_CODE_SYSTEM_PREFIX }];
    if (systemPrompt) {
      // Add the actual system prompt with cache_control to cache both prefix and prompt
      systemPromptBlocks.push({
        type: 'text',
        text: systemPrompt,
        cache_control: { type: 'ephemeral' },
      });
    } else {
      // If no custom prompt, cache just the prefix
      systemPromptBlocks[0].cache_control = { type: 'ephemeral' };
    }

    log.info(MODULE, 'Calling Anthropic API (OAuth)', {
      model: model || this.defaultModel,
      messageCount: anthropicMessages.length,
      toolCount: anthropicTools?.length || 0,
      maxTokens: maxTokens || this.defaultMaxTokens,
    });

    try {
      // Create streaming request
      const stream = await client.messages.stream({
        model: model || this.defaultModel,
        max_tokens: maxTokens || this.defaultMaxTokens,
        temperature: temperature ?? 0.7,
        system: systemPromptBlocks,
        messages: anthropicMessages,
        tools: anthropicTools,
      });

      // Handle abort signal
      if (signal) {
        signal.addEventListener('abort', () => {
          log.warn(MODULE, 'Abort signal received, stopping stream');
          stream.controller.abort();
        });
      }

      let hasToolCalls = false;
      const toolCalls: ToolCall[] = [];
      let currentBlockType: string | null = null;

      // Process stream events
      for await (const event of stream) {
        switch (event.type) {
          case 'content_block_start':
            currentBlockType = event.content_block.type;
            if (event.content_block.type === 'tool_use') {
              log.debug(MODULE, 'Tool call started', {
                toolName: event.content_block.name,
              });
            }
            break;

          case 'content_block_delta':
            if (event.delta.type === 'text_delta') {
              await callbacks?.onText?.(event.delta.text);
            } else if (event.delta.type === 'thinking_delta') {
              // Interleaved thinking (beta interleaved-thinking-2025-05-14) →
              // progress for the stall watchdog, not silence (TER-650).
              await callbacks?.onThinking?.(event.delta.thinking);
            } else if (event.delta.type === 'input_json_delta') {
              // Tool input streaming: accumulated by the SDK for finalMessage();
              // surfaced as a heartbeat so long tool-args generations never read
              // as a frozen socket to the stall watchdog (TER-650).
              await callbacks?.onToolInputDelta?.(event.delta.partial_json);
            }
            break;

          case 'content_block_stop':
            if (currentBlockType === 'text') {
              await callbacks?.onTextEnd?.();
            }
            currentBlockType = null;
            break;
        }
      }

      // Get final message
      const finalMessage = await stream.finalMessage();

      // Extract tool calls
      for (const block of finalMessage.content) {
        if (block.type === 'tool_use') {
          hasToolCalls = true;
          const toolCall: ToolCall = {
            id: block.id,
            name: block.name,
            input: block.input as Record<string, any>,
          };
          toolCalls.push(toolCall);
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

      log.info(MODULE, 'Response complete', {
        stopReason,
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
        cacheCreation: usage?.cacheCreationInputTokens,
        cacheRead: usage?.cacheReadInputTokens,
        model: finalMessage.model,
      });

      return {
        stopReason,
        usage,
        metadata: {
          provider: 'anthropic',
          model: finalMessage.model,
          id: finalMessage.id,
          authType: 'oauth',
        },
      };
    } catch (error: any) {
      if (signal?.aborted) {
        log.warn(MODULE, 'Request aborted by user');
        return {
          stopReason: 'error',
          metadata: { error: 'Aborted by user' },
        };
      }

      // Check if it's an auth error - might need to refresh token
      if (error.status === 401) {
        log.warn(MODULE, 'Authentication failed, token may be expired');
        // Clear client to force re-auth on next request
        this.client = null;
      }

      const llmError = LLMError.fromAnthropicError(error, {
        model: model || this.defaultModel,
        messageCount: anthropicMessages.length,
        toolCount: anthropicTools?.length || 0,
        authType: 'oauth',
      });

      log.agentError(MODULE, llmError);
      throw llmError;
    }
  }

  /**
   * Convert MessageWithParts[] to Anthropic messages format
   * (Same logic as AnthropicLLMAdapter)
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

    for (const msg of messages) {
      const role = msg.info.role === 'user' ? 'user' : 'assistant';
      const textAndToolUse: Array<Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam | Anthropic.ImageBlockParam> = [];
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      // Process images for user messages
      const imageParts = msg.parts.filter(
        (p): p is import('../session/types').FilePart =>
          p.type === 'file' && p.mime?.startsWith('image/') && role === 'user',
      );
      let processedImages: Map<string, ProcessedImage> = new Map();
      if (imageParts.length > 0) {
        if (!this.imagePipeline.supportsVision(this.defaultModel)) {
          log.warn(
            'AnthropicOAuth',
            `Model ${this.defaultModel} does not support vision — skipping ${imageParts.length} image(s)`,
          );
        } else {
          try {
            processedImages = await this.imagePipeline.processImages(imageParts, 'anthropic');
          } catch (error: any) {
            log.error('AnthropicOAuth', 'Failed to process images for message', undefined, { reason: error.message });
          }
        }
      }

      // Extract text + embedded images from non-image documents (PPTX/DOCX/XLSX/ODT/PDF/RTF/plain text)
      const documentParts = msg.parts.filter(
        (p): p is import('../session/types').FilePart =>
          p.type === 'file' &&
          !p.mime?.startsWith('image/') &&
          DocumentExtractor.supportsDocument(p.mime) &&
          role === 'user',
      );
      if (documentParts.length > 0) {
        try {
          const extracted = await this.documentExtractor.extractDocuments(documentParts);
          const documentText = formatDocumentsAsText(extracted);
          if (documentText) {
            textAndToolUse.push({ type: 'text', text: documentText });
          }
          const flat = collectEmbeddedImages(extracted);
          if (flat.length > 0 && this.imagePipeline.supportsVision(this.defaultModel)) {
            for (const img of flat) {
              const processed = await this.imagePipeline.processBuffer(img.buffer, img.mimeType, 'anthropic');
              if (processed) {
                textAndToolUse.push({
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
              'AnthropicOAuth',
              `Model ${this.defaultModel} not vision-capable — skipping ${flat.length} embedded image(s) from document(s)`,
            );
          }
        } catch (error: any) {
          log.error('AnthropicOAuth', 'Failed to extract documents for message', undefined, { reason: error.message });
        }
      }

      for (const part of msg.parts) {
        if (part.type === 'text') {
          textAndToolUse.push({
            type: 'text',
            text: part.text,
          } as Anthropic.TextBlockParam);
        } else if (part.type === 'tool') {
          // INV-1: orphan tool_use must be remediated upstream (assertInvariantINV1
          // in PromptBuilder). Throw rather than skip — a silent skip drops the tool
          // from the LLM's view and corrupts history (same defense as AnthropicLLMAdapter).
          if (part.state.status !== 'completed' && part.state.status !== 'error') {
            throw new Error(
              `INV-1 violation reached AnthropicOAuthAdapter: ToolPart ${part.callID} ` +
                `(tool=${part.tool}) has status=${part.state.status}. ` +
                `Expected 'completed' or 'error' — check assertInvariantINV1 in PromptBuilder.`,
            );
          }
          if (
            role === 'assistant' &&
            (part.state.status === 'completed' || part.state.status === 'error')
          ) {
            textAndToolUse.push({
              type: 'tool_use',
              id: sanitizeToolId(part.callID),
              name: part.tool,
              input: part.state.input || {},
            } as Anthropic.ToolUseBlockParam);

            if (part.state.status === 'completed') {
              toolResults.push({
                type: 'tool_result',
                tool_use_id: sanitizeToolId(part.callID),
                content: part.state.output,
                is_error: false,
              } as Anthropic.ToolResultBlockParam);
            } else {
              toolResults.push({
                type: 'tool_result',
                tool_use_id: sanitizeToolId(part.callID),
                content: part.state.error,
                is_error: true,
              } as Anthropic.ToolResultBlockParam);
            }
          } else if (role === 'user') {
            if (part.state.status === 'completed') {
              toolResults.push({
                type: 'tool_result',
                tool_use_id: sanitizeToolId(part.callID),
                content: part.state.output,
                is_error: false,
              } as Anthropic.ToolResultBlockParam);
            } else if (part.state.status === 'error') {
              toolResults.push({
                type: 'tool_result',
                tool_use_id: sanitizeToolId(part.callID),
                content: part.state.error,
                is_error: true,
              } as Anthropic.ToolResultBlockParam);
            }
          }
        } else if (part.type === 'file' && part.mime?.startsWith('image/') && role === 'user') {
          // Convert image file to Anthropic image block
          const processed = processedImages.get(part.url);
          if (processed) {
            textAndToolUse.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: processed.mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
                data: processed.base64,
              },
            } as Anthropic.ImageBlockParam);
          }
        }
      }

      if (textAndToolUse.length > 0) {
        anthropicMessages.push({
          role,
          content: textAndToolUse,
        });
      }

      if (toolResults.length > 0 && role === 'assistant') {
        anthropicMessages.push({
          role: 'user',
          content: toolResults,
        });
      } else if (toolResults.length > 0 && role === 'user') {
        anthropicMessages.push({
          role: 'user',
          content: toolResults,
        });
      }
    }

    // Apply cache_control at the appropriate breakpoint
    // This tells Anthropic to cache everything up to this point
    this.applyCacheControl(anthropicMessages, cacheBreakpointIndex);

    return anthropicMessages;
  }

  /**
   * Apply cache_control to the appropriate message for prompt caching.
   *
   * @param messages - Anthropic messages array
   * @param cacheBreakpointIndex - Index in the INPUT messages where cache breakpoint should be placed.
   *                               Since OAuth adapter doesn't do complex message splitting like the main adapter,
   *                               we can use this index directly.
   *                               If not provided, falls back to caching all but last 5 messages.
   */
  private applyCacheControl(
    messages: Anthropic.MessageParam[],
    cacheBreakpointIndex?: number,
  ): void {
    if (messages.length === 0) return;

    let anthropicCacheIndex: number;

    if (cacheBreakpointIndex !== undefined && cacheBreakpointIndex >= 0) {
      // Use provided breakpoint
      // Since OAuth adapter doesn't split messages, we can use the index directly
      // But we need to account for the fact that one input message might become 2 anthropic messages
      // (one for tool_use, one for tool_result)
      // For simplicity, we use the provided index as-is, which should work for most cases
      anthropicCacheIndex = Math.min(cacheBreakpointIndex, messages.length - 1);

      log.debug(MODULE, 'Using provided cache breakpoint', {
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

      log.debug(MODULE, 'Using fallback cache breakpoint (mod-N block strategy)', {
        anthropicIndex: anthropicCacheIndex,
        totalMessages: messages.length,
        blockSize: BLOCK_SIZE,
      });
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

        log.debug(MODULE, 'Applied cache_control', {
          messageIndex: anthropicCacheIndex,
          messageRole: messageToCache.role,
          blockType: lastBlock.type,
        });
      }
    }
  }

  getProviderInfo() {
    return {
      name: 'Anthropic (OAuth)',
      model: this.defaultModel,
      capabilities: {
        streaming: true,
        tools: true,
        thinking: true,
        vision: true,
      },
    };
  }
}
