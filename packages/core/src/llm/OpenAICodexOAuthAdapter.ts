/**
 * OpenAICodexOAuthAdapter - OpenAI Codex with OAuth authentication
 *
 * Uses the OpenAI Responses API (not chat/completions) via the Codex endpoint:
 *   POST https://chatgpt.com/backend-api/codex/responses
 *
 * Key differences from chat/completions:
 * - Body uses `input` (not `messages`) with Responses API format
 * - System prompt goes as `{ role: "developer", content }` (not "system")
 * - Tool calls are `{ type: "function_call", call_id, name, arguments }`
 * - Tool results are `{ type: "function_call_output", call_id, output }`
 * - Uses `max_output_tokens` (not `max_tokens`)
 * - `temperature` must be omitted (reasoning model)
 * - Requires `truncation: "auto"`
 * - Required headers: `originator: "opencode"`, `User-Agent`
 *
 * @see OpenCode reference: packages/opencode/src/plugin/codex.ts
 * @see OpenCode responses model: packages/opencode/src/provider/sdk/copilot/responses/
 */

import { LLMError } from '../errors/AgentError';
import { createLogger, log } from '../logger';
import type { MessageWithParts } from '../session/types';
import type { ILLMClient, LLMResponse, StreamMessageOptions, ToolCall } from './ILLMClient';
import { isContextLengthExceeded } from './context-length-error';
import { collectEmbeddedImages, DocumentExtractor, formatDocumentsAsText } from './DocumentExtractor';
import { ImagePipeline, type ProcessedImage } from './ImagePipeline';
import {
  CODEX_OAUTH_CONFIG,
  type CodexOAuthTokens,
  codexTokensNeedRefresh,
  refreshCodexTokens,
} from './CodexOAuth';

const MODULE = 'OpenAICodexOAuth';

export interface OpenAICodexOAuthConfig {
  model: string;
  defaultMaxTokens?: number;
  tokens: CodexOAuthTokens;
  onTokenRefresh?: (newTokens: CodexOAuthTokens) => Promise<void>;
}

// ── Responses API types ───────────────────────────────────────────────────────

type ResponsesInputContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string; detail?: 'auto' | 'low' | 'high' };

type ResponsesInputItem =
  | { role: 'developer'; content: string }
  | { role: 'user'; content: Array<ResponsesInputContentPart> }
  | { role: 'assistant'; content: Array<{ type: 'output_text'; text: string }>; id?: string }
  | { type: 'function_call'; call_id: string; name: string; arguments: string; id?: string }
  | { type: 'function_call_output'; call_id: string; output: string };

interface ResponsesRequestBody {
  model: string;
  input: ResponsesInputItem[];
  instructions?: string;
  store: false;
  tools?: ResponsesTool[];
  stream: true;
}

interface ResponsesTool {
  type: 'function';
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

// ── Streaming event types ─────────────────────────────────────────────────────

interface StreamEvent {
  type: string;
  output_index?: number;
  item?: {
    type: string;
    id?: string;
    call_id?: string;
    name?: string;
  };
  delta?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

export class OpenAICodexOAuthAdapter implements ILLMClient {
  private defaultModel: string;
  private defaultMaxTokens: number;
  private tokens: CodexOAuthTokens;
  private onTokenRefresh?: (newTokens: CodexOAuthTokens) => Promise<void>;
  private logger = createLogger(MODULE);
  private imagePipeline = new ImagePipeline();
  private documentExtractor = new DocumentExtractor();

  constructor(config: OpenAICodexOAuthConfig) {
    if (!config.model) throw new Error('OpenAICodexOAuthAdapter: model is required');
    this.defaultModel = config.model;
    this.defaultMaxTokens = config.defaultMaxTokens ?? 8192;
    this.tokens = config.tokens;
    this.onTokenRefresh = config.onTokenRefresh;
  }

  // ── Token refresh ───────────────────────────────────────────────────────────

  private async ensureValidToken(): Promise<void> {
    if (!codexTokensNeedRefresh(this.tokens)) return;

    log.info(MODULE, 'Codex access token expired or expiring soon, refreshing...');
    const refreshed = await refreshCodexTokens(this.tokens.refreshToken, this.tokens.accountId);
    if (!refreshed) {
      log.warn(MODULE, 'Token refresh failed, will attempt request with existing token');
      return;
    }
    this.tokens = refreshed;
    if (this.onTokenRefresh) {
      try {
        await this.onTokenRefresh(refreshed);
      } catch (err) {
        log.error(MODULE, 'onTokenRefresh callback failed', err as Error);
      }
    }
  }

  // ── Message conversion ──────────────────────────────────────────────────────

  private async convertMessages(messages: MessageWithParts[]): Promise<ResponsesInputItem[]> {
    const input: ResponsesInputItem[] = [];

    for (const msg of messages) {
      const role = msg.info.role === 'user' ? 'user' : 'assistant';

      const textParts: string[] = [];
      const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
      const toolResults: Array<{ call_id: string; output: string }> = [];

      // Collect image file parts for user messages
      const imageParts = msg.parts.filter(
        (p): p is import('../session/types').FilePart =>
          p.type === 'file' && p.mime?.startsWith('image/') && role === 'user',
      );
      let processedImages: Map<string, ProcessedImage> = new Map();
      if (imageParts.length > 0) {
        if (!this.imagePipeline.supportsVision(this.defaultModel)) {
          log.warn(
            MODULE,
            `Model ${this.defaultModel} does not support vision — skipping ${imageParts.length} image(s)`,
          );
        } else {
          try {
            processedImages = await this.imagePipeline.processImages(imageParts, 'openai');
          } catch (error: any) {
            log.error(MODULE, 'Failed to process images for message', undefined, { reason: error.message });
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
      let extractedDocumentText: string | null = null;
      const documentEmbeddedImages: ProcessedImage[] = [];
      if (documentParts.length > 0) {
        try {
          const extracted = await this.documentExtractor.extractDocuments(documentParts);
          extractedDocumentText = formatDocumentsAsText(extracted);
          const flat = collectEmbeddedImages(extracted);
          if (flat.length > 0 && this.imagePipeline.supportsVision(this.defaultModel)) {
            for (const img of flat) {
              const processed = await this.imagePipeline.processBuffer(img.buffer, img.mimeType, 'openai');
              if (processed) documentEmbeddedImages.push(processed);
            }
          } else if (flat.length > 0) {
            log.warn(
              MODULE,
              `Model ${this.defaultModel} not vision-capable — skipping ${flat.length} embedded image(s) from document(s)`,
            );
          }
        } catch (error: any) {
          log.error(MODULE, 'Failed to extract documents for message', undefined, { reason: error.message });
        }
      }

      for (const part of msg.parts) {
        if (part.type === 'text') {
          textParts.push(part.text);
        } else if (part.type === 'tool') {
          if (role === 'assistant') {
            if (part.state.status === 'completed' || part.state.status === 'error') {
              toolCalls.push({
                id: part.callID,
                name: part.tool,
                arguments: JSON.stringify(part.state.input ?? {}),
              });
              toolResults.push({
                call_id: part.callID,
                output:
                  part.state.status === 'completed'
                    ? part.state.output ?? ''
                    : `Error: ${part.state.error ?? 'Unknown error'}`,
              });
            }
          } else {
            if (part.state.status === 'completed') {
              toolResults.push({ call_id: part.callID, output: part.state.output ?? '' });
            } else if (part.state.status === 'error') {
              toolResults.push({
                call_id: part.callID,
                output: `Error: ${part.state.error ?? 'Unknown error'}`,
              });
            }
          }
        }
        // Image file parts are handled separately below
      }

      if (role === 'assistant') {
        if (textParts.length > 0) {
          input.push({
            role: 'assistant',
            content: [{ type: 'output_text', text: textParts.join('\n') }],
          });
        }
        for (const tc of toolCalls) {
          input.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
          });
        }
        for (const tr of toolResults) {
          input.push({
            type: 'function_call_output',
            call_id: tr.call_id,
            output: tr.output,
          });
        }
      } else {
        // User message: build content array with text + images
        // Documents (PPTX/DOCX/...) are prepended as a separate text block before user prose.
        // Images embedded inside those documents follow the text.
        const contentParts: ResponsesInputContentPart[] = [];
        if (extractedDocumentText) {
          contentParts.push({ type: 'input_text', text: extractedDocumentText });
        }
        for (const processed of documentEmbeddedImages) {
          contentParts.push({
            type: 'input_image',
            image_url: `data:${processed.mimeType};base64,${processed.base64}`,
          });
        }
        if (textParts.length > 0) {
          contentParts.push({ type: 'input_text', text: textParts.join('\n') });
        }
        for (const part of imageParts) {
          const processed = processedImages.get(part.url);
          if (processed) {
            contentParts.push({
              type: 'input_image',
              image_url: `data:${processed.mimeType};base64,${processed.base64}`,
            });
          }
        }
        if (contentParts.length > 0) {
          input.push({ role: 'user', content: contentParts });
        }
        for (const tr of toolResults) {
          input.push({
            type: 'function_call_output',
            call_id: tr.call_id,
            output: tr.output,
          });
        }
      }
    }

    return input;
  }

  // ── HTTP request ────────────────────────────────────────────────────────────

  private async fetchCodex(body: ResponsesRequestBody, signal?: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.tokens.accessToken}`,
      'originator': 'opencode',
      'User-Agent': 'opencode/0.1.0 (linux)',
    };

    if (this.tokens.accountId) {
      headers['ChatGPT-Account-Id'] = this.tokens.accountId;
    }

    return fetch(CODEX_OAUTH_CONFIG.codexApiEndpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
  }

  // ── ILLMClient implementation ───────────────────────────────────────────────

  async streamMessage(options: StreamMessageOptions): Promise<LLMResponse> {
    const { messages, tools, systemPrompt, model, signal, callbacks } = options;

    await this.ensureValidToken();

    const input = await this.convertMessages(messages);
    const modelName = model ?? this.defaultModel;

    const openaiTools: ResponsesTool[] | undefined = tools?.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema as Record<string, unknown>,
    }));

    const body: ResponsesRequestBody = {
      model: modelName,
      input,
      // System prompt goes as top-level `instructions`, not inside `input`
      ...(systemPrompt ? { instructions: systemPrompt } : {}),
      store: false as const,
      stream: true,
      ...(openaiTools?.length ? { tools: openaiTools } : {}),
    };

    log.info(MODULE, 'Calling Codex Responses API (OAuth)', {
      model: modelName,
      inputItems: input.length,
      toolCount: openaiTools?.length ?? 0,
      hasAccountId: !!this.tokens.accountId,
    });

    try {
      const response = await this.fetchCodex(body, signal);

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`${response.status} status code (${errorText || 'no body'})`);
      }

      if (!response.body) {
        throw new Error('No response body');
      }

      // Parse SSE stream
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      let buffer = '';
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let hasToolCalls = false;

      const pendingToolCalls = new Map<
        number,
        { call_id: string; name: string; arguments: string }
      >();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (signal?.aborted) {
          reader.cancel();
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') break;

          let event: StreamEvent;
          try {
            event = JSON.parse(data);
          } catch {
            continue;
          }

          // Capture usage wherever it appears
          if (event.usage) {
            totalInputTokens = event.usage.input_tokens;
            totalOutputTokens = event.usage.output_tokens;
          }

          switch (event.type) {
            case 'response.output_text.delta': {
              if (event.delta) {
                await callbacks?.onText?.(event.delta);
              }
              break;
            }

            // Reasoning stream (Responses API emits these while the model
            // reasons before any visible text). Route to onThinking so the
            // turn's stall watchdog counts it as progress, not a frozen socket
            // (TER-650). NOT onText — reasoning must not leak into the reply.
            case 'response.reasoning_text.delta':
            case 'response.reasoning_summary_text.delta': {
              if (event.delta) {
                await callbacks?.onThinking?.(event.delta);
              }
              break;
            }

            case 'response.output_item.added': {
              if (
                event.item?.type === 'function_call' &&
                event.output_index !== undefined &&
                event.item.call_id &&
                event.item.name
              ) {
                pendingToolCalls.set(event.output_index, {
                  call_id: event.item.call_id,
                  name: event.item.name,
                  arguments: '',
                });
              }
              break;
            }

            case 'response.function_call_arguments.delta': {
              if (event.output_index !== undefined && event.delta) {
                const tc = pendingToolCalls.get(event.output_index);
                if (tc) tc.arguments += event.delta;
                // Heartbeat: onToolCall only fires on output_item.done, so this
                // is the only progress signal while large tool args stream
                // (TER-650).
                await callbacks?.onToolInputDelta?.(event.delta);
              }
              break;
            }

            case 'response.output_item.done': {
              if (event.item?.type === 'function_call' && event.output_index !== undefined) {
                const tc = pendingToolCalls.get(event.output_index);
                if (tc) {
                  hasToolCalls = true;
                  let parsedInput: Record<string, unknown> = {};
                  try {
                    parsedInput = JSON.parse(tc.arguments || '{}');
                  } catch {
                    log.warn(MODULE, 'Failed to parse tool arguments', {
                      toolName: tc.name,
                      arguments: tc.arguments,
                    });
                  }
                  const toolCall: ToolCall = {
                    id: tc.call_id,
                    name: tc.name,
                    input: parsedInput,
                  };
                  await callbacks?.onToolCall?.(toolCall);
                  pendingToolCalls.delete(event.output_index);
                }
              }
              break;
            }
          }
        }
      }

      await callbacks?.onTextEnd?.();

      const stopReason: LLMResponse['stopReason'] = hasToolCalls ? 'tool_calls' : 'end_turn';

      log.info(MODULE, 'Codex response complete', {
        stopReason,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        model: modelName,
      });

      return {
        stopReason,
        usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
        metadata: {
          provider: 'openai-codex-oauth',
          model: modelName,
          authType: 'oauth',
        },
      };
    } catch (error: any) {
      if (signal?.aborted) {
        log.warn(MODULE, 'Request aborted by user');
        return { stopReason: 'error', metadata: { error: 'Aborted by user' } };
      }

      // Flag context-length overflow structurally so recovery fires — the
      // generic catch previously surfaced every failure (including overflow) as
      // "check your ChatGPT session", never triggering compaction. CTX-007.
      const isOverflow = isContextLengthExceeded(error?.status, error?.message, error?.code);
      const llmError = new LLMError(
        isOverflow
          ? 'The conversation is too long. Attempting to summarize...'
          : 'Cannot connect to OpenAI Codex. Please check your ChatGPT session.',
        `Codex OAuth error: ${error?.message ?? 'Unknown error'}`,
        {
          model: modelName,
          messageCount: messages.length,
          toolCount: tools?.length ?? 0,
          authType: 'oauth',
          isContextLengthError: isOverflow,
        },
        error instanceof Error ? error : undefined,
      );

      log.agentError(MODULE, llmError);
      throw llmError;
    }
  }

  getProviderInfo() {
    return {
      name: 'OpenAI Codex (OAuth)',
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
