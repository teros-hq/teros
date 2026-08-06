/**
 * OpenAICompatibleLLMAdapter - Generic OpenAI-compatible endpoint adapter
 *
 * Enables using any OpenAI-compatible LLM endpoint (Tower, LM Studio, vLLM, etc.)
 * Supports optional Bearer auth and custom headers (e.g., Cloudflare Access).
 *
 * Architecture:
 * ConversationManager (uses MessageWithParts types)
 *   ↓
 * ILLMClient interface (generic)
 *   ↓
 * OpenAICompatibleAdapter (converts MessageWithParts ↔ OpenAI format)
 *   ↓
 * Custom OpenAI-compatible endpoint /v1/chat/completions
 */

import OpenAI from "openai"
import { LLMError } from "../errors/AgentError"
import { createLogger, log } from "../logger"
import type { MessageWithParts } from "../session/types"
import {
  collectEmbeddedImages,
  DocumentExtractor,
  formatDocumentsAsText,
} from "./DocumentExtractor"
import type {
  ILLMClient,
  LLMResponse,
  LLMUsageInfo,
  StreamMessageOptions,
  ToolCall,
} from "./ILLMClient"
import { isContextLengthExceeded } from "./context-length-error"
import { ImagePipeline, type ProcessedImage } from "./ImagePipeline"
import { decInflight, incInflight } from "./inflight-gauge"
import { populateRateLimitContext } from "./rate-limit-context"
import { extractReasoningDelta } from "./reasoningDelta"
import { uncachedInputTokens } from "./usage-normalize"

export interface OpenAICompatibleConfig {
  /** Base URL of the OpenAI-compatible endpoint (e.g., 'https://tower.romerolabs.dev') */
  baseUrl: string
  /** Model name to use */
  model: string
  /** Optional Bearer token (standard API key auth) */
  apiKey?: string
  /** Optional custom headers (e.g., Cloudflare Access: CF-Access-Client-Id, CF-Access-Client-Secret) */
  customHeaders?: Record<string, string>
  /** Default max tokens for completion */
  defaultMaxTokens?: number
  /**
   * Real upstream provider that serves this endpoint (`fireworks` | `together`
   * | `cloudflare` | …). Used as the `actualProvider` instrumentation
   * dimension so observability can tell Fireworks from Together even when the
   * logical provider is the same (`teros`). Defaults to `openai-compatible`
   * for generic endpoints (Tower, LM Studio, vLLM). Resolves gap C1.
   */
  actualProvider?: string
}

/**
 * OpenAI-Compatible LLM Adapter
 *
 * Implements the generic ILLMClient interface for any OpenAI-compatible endpoint.
 * When no apiKey is provided, uses a dummy value so the OpenAI SDK does not throw.
 * Custom headers (e.g., Cloudflare Access tokens) are injected via defaultHeaders.
 */
export class OpenAICompatibleLLMAdapter implements ILLMClient {
  private client: OpenAI
  private defaultModel: string
  private defaultMaxTokens: number
  private baseUrl: string
  /** Real upstream provider label for the `actualProvider` telemetry dimension. */
  private actualProvider: string
  private logger = createLogger("OpenAICompatibleLLM")
  private imagePipeline = new ImagePipeline()
  private documentExtractor = new DocumentExtractor()

  constructor(config: OpenAICompatibleConfig) {
    if (!config.model) {
      throw new Error("OpenAICompatibleLLMAdapter: model is required")
    }
    if (!config.baseUrl) {
      throw new Error("OpenAICompatibleLLMAdapter: baseUrl is required")
    }

    this.baseUrl = config.baseUrl

    // Normalize base URL: ensure it ends with /v1
    const apiBaseUrl = config.baseUrl.endsWith("/v1") ? config.baseUrl : `${config.baseUrl}/v1`

    this.client = new OpenAI({
      // Use provided key, or a dummy if none (some endpoints don't require auth)
      apiKey: config.apiKey || "no-auth",
      baseURL: apiBaseUrl,
      defaultHeaders: config.customHeaders || {},
    })

    this.defaultModel = config.model
    this.defaultMaxTokens = config.defaultMaxTokens || 32768
    this.actualProvider = config.actualProvider || "openai-compatible"

    log.info("OpenAICompatibleLLM", "Initialized adapter", {
      baseUrl: apiBaseUrl,
      model: this.defaultModel,
      actualProvider: this.actualProvider,
      hasApiKey: !!config.apiKey,
      customHeaderCount: Object.keys(config.customHeaders || {}).length,
    })
  }

  /**
   * Main streaming method
   */
  async streamMessage(options: StreamMessageOptions): Promise<LLMResponse> {
    const { messages, tools, systemPrompt, model, temperature, maxTokens, signal, callbacks } =
      options

    const openaiMessages = await this.convertMessages(messages, systemPrompt)

    const openaiTools = tools?.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }))

    log.info("OpenAICompatibleLLM", "Calling endpoint", {
      baseUrl: this.baseUrl,
      model: model || this.defaultModel,
      messageCount: openaiMessages.length,
      toolCount: openaiTools?.length || 0,
      maxTokens: maxTokens || this.defaultMaxTokens,
      temperature: temperature ?? 0.7,
    })

    // Instrumentation (TER-615): wall-clock TTFT + E2E latency measured around
    // the stream. `startedAt` / `ttftMs` / `serverTtftMs` live outside the try
    // so the catch can still emit latency-to-failure telemetry.
    const startedAt = performance.now()
    let ttftMs: number | undefined
    let serverTtftMs: number | undefined
    // Saturation gauge (TER-616/§2.1): count this stream as in-flight for the
    // duration; decremented in `finally` whether it succeeds, errors or aborts.
    incInflight(this.actualProvider)

    try {
      const createParams: any = {
        model: model || this.defaultModel,
        temperature: temperature ?? 0.7,
        messages: openaiMessages,
        tools: openaiTools?.length ? openaiTools : undefined,
        stream: true,
        // Without this, OpenAI-compatible streaming omits the final usage chunk,
        // so `chunk.usage` (consumed below) never arrives and the turn records
        // 0 tokens / $0 cost / no cache — the default Teros model (kimi via
        // Fireworks) runs through here, so this silently zeroed usage & billing
        // analytics for the primary path. Providers that don't support it ignore
        // the flag; the reader below already guards on `chunk.usage` presence.
        stream_options: { include_usage: true },
        max_tokens: maxTokens || this.defaultMaxTokens,
      }

      // `.withResponse()` exposes the raw HTTP Response alongside the stream so
      // we can read provider perf headers (Fireworks serves TTFT as a header)
      // before consuming chunks. `data` is the async-iterable stream.
      const { data: stream, response: httpResponse } = (await this.client.chat.completions
        .create(createParams, { signal })
        .withResponse()) as unknown as { data: AsyncIterable<any>; response: Response }

      // C3: Fireworks reports server-side TTFT (seconds) via this perf header.
      // Together / generic endpoints omit it → client-side `ttftMs` covers them.
      const ttftHeader = httpResponse?.headers?.get?.("fireworks-server-time-to-first-token")
      if (ttftHeader) {
        const secs = Number.parseFloat(ttftHeader)
        if (Number.isFinite(secs)) serverTtftMs = Math.round(secs * 1000)
      }

      let hasToolCalls = false
      const toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map()
      let finishReason: string | null = null
      let totalInputTokens = 0
      let totalOutputTokens = 0
      let cachedReadTokens = 0
      let reasoningTokens: number | undefined
      let generationId: string | undefined
      // Reasoning-model diagnostics: some OpenAI-compatible endpoints (llama.cpp
      // with Qwopus/QwQ/DeepSeek R1, etc.) stream `delta.reasoning_content`
      // independent from `delta.content`. The reasoning stream is NOT surfaced
      // to the UI here — we only count it so we can detect the case where the
      // model exhausts its `max_tokens` budget thinking and never emits any
      // content chunks. When that happens the endpoint reports `finish_reason:
      // "stop"` (not `"length"`) even though the effective result is budget
      // overflow, which upstream ConversationManager would otherwise treat as a
      // normal turn ending and save an empty message. We rewrite that into
      // `max_tokens` so callers can surface/retry it meaningfully.
      let reasoningCharCount = 0
      let contentCharCount = 0

      for await (const chunk of stream) {
        // Usage arrives in the FINAL chunk, which per the OpenAI streaming spec
        // has an EMPTY `choices` array when `stream_options.include_usage` is
        // on. Read it BEFORE the choice guard — otherwise `if (!choice)
        // continue` skips that chunk and the turn records 0 tokens. Same bug
        // class as the OpenAILLMAdapter fix (cbc10554); this adapter kept the
        // gap because its tests mocked the usage chunk WITH a choice (unfaithful
        // mock) — verified live against Fireworks in the 2026-07-07 audit.
        if (chunk.usage) {
          totalInputTokens = chunk.usage.prompt_tokens || 0
          totalOutputTokens = chunk.usage.completion_tokens || 0
          // C4: `cached_tokens` lives in `prompt_tokens_details` on BOTH
          // Fireworks and Together (it is NOT Anthropic-exclusive). Read-if-present.
          // The non-cached normalization happens in the usage object below (A2.1).
          cachedReadTokens = chunk.usage.prompt_tokens_details?.cached_tokens || 0
          // Together reports `reasoning_tokens` in usage; Fireworks emits
          // reasoning as text (`reasoning_content`) and never counts it → stays
          // undefined there, keeping the field honest (no invented count).
          const rt =
            chunk.usage.completion_tokens_details?.reasoning_tokens ??
            (chunk.usage as { reasoning_tokens?: number }).reasoning_tokens
          if (typeof rt === "number") reasoningTokens = rt
        }

        const choice = chunk.choices[0]
        if (!choice) continue

        // First content chunk → time-to-first-token (client-side wall clock,
        // OTel `time_to_first_chunk`). Marked once, on the first chunk carrying
        // a choice.
        if (ttftMs === undefined) {
          ttftMs = Math.round(performance.now() - startedAt)
        }
        // Provider generation id (e.g. `cmpl-…`), useful for correlation.
        if (!generationId && chunk.id) generationId = chunk.id

        const delta = choice.delta

        if (delta.content) {
          contentCharCount += delta.content.length
          await callbacks?.onText?.(delta.content)
        }

        // Reasoning stream (o-series / QwQ / DeepSeek R1 / GLM, etc.). Kept as a
        // diagnostic char count AND surfaced to onThinking so the turn's stall
        // watchdog counts a silent reasoning block as progress, not a frozen
        // socket (TER-650). The frontend does not render this channel for
        // openai-compatible; TurnDriver uses it as a heartbeat/timing signal.
        const reasoningChunk = extractReasoningDelta(delta)
        if (reasoningChunk) {
          reasoningCharCount += reasoningChunk.length
          await callbacks?.onThinking?.(reasoningChunk)
        }

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

            if (toolCallDelta.id) toolCall.id = toolCallDelta.id
            if (toolCallDelta.function?.name) toolCall.name = toolCallDelta.function.name
            if (toolCallDelta.function?.arguments)
              toolCall.arguments += toolCallDelta.function.arguments
            // Heartbeat: onToolCall only fires once the stream ends, so this is
            // the only progress signal while large tool args stream (TER-650).
            await callbacks?.onToolInputDelta?.(toolCallDelta.function?.arguments ?? "")
          }
        }

        if (choice.finish_reason) {
          finishReason = choice.finish_reason
        }
      }

      await callbacks?.onTextEnd?.()

      if (toolCalls.size > 0) {
        hasToolCalls = true
        for (const [_, tc] of toolCalls) {
          let parsedInput: Record<string, any> = {}
          try {
            parsedInput = JSON.parse(tc.arguments || "{}")
          } catch (e) {
            log.warn("OpenAICompatibleLLM", "Failed to parse tool arguments", {
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

      let stopReason: LLMResponse["stopReason"] = "end_turn"
      if (hasToolCalls || finishReason === "tool_calls") {
        stopReason = "tool_calls"
      } else if (finishReason === "length") {
        stopReason = "max_tokens"
      } else if (reasoningCharCount > 0 && contentCharCount === 0 && !hasToolCalls) {
        // Budget-overflow masquerading as a clean stop: the model produced
        // reasoning but never wrote any content, and no tool was called. The
        // endpoint reports finish_reason "stop" in this case even though the
        // user-visible result is empty. Promote to max_tokens so the caller
        // treats it as an overflow (retry with larger budget, surface error)
        // rather than persisting an empty assistant turn.
        stopReason = "max_tokens"
      }

      const usage: LLMUsageInfo = {
        // `prompt_tokens` includes `cached_tokens` (OpenAI-compatible spec) —
        // normalize to the canonical non-cached shape (A2.1). This is the
        // default managed path (teros→Fireworks/Kimi).
        inputTokens: uncachedInputTokens(totalInputTokens, cachedReadTokens),
        outputTokens: totalOutputTokens,
        ...(cachedReadTokens > 0 ? { cacheReadInputTokens: cachedReadTokens } : {}),
        ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
      }

      const latencyMs = Math.round(performance.now() - startedAt)

      // Instrumentation hooks (additive, TER-615). onUsage carries tokens;
      // onFinish carries timing + classification. Both no-op when the caller
      // didn't register them (every adapter other than this one today).
      await callbacks?.onUsage?.(usage)
      await callbacks?.onFinish?.({
        ttftMs,
        latencyMs,
        serverTtftMs,
        finishReason,
        usage,
        actualProvider: this.actualProvider,
      })

      log.info("OpenAICompatibleLLM", "Response complete", {
        stopReason,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedReadTokens,
        reasoningTokens,
        reasoningChars: reasoningCharCount,
        contentChars: contentCharCount,
        ttftMs,
        serverTtftMs,
        latencyMs,
        actualProvider: this.actualProvider,
        model: model || this.defaultModel,
      })

      return {
        stopReason,
        usage,
        metadata: {
          provider: "openai-compatible",
          actualProvider: this.actualProvider,
          model: model || this.defaultModel,
          id: generationId,
          finishReason,
          ttftMs,
          serverTtftMs,
          latencyMs,
          reasoningChars: reasoningCharCount,
          contentChars: contentCharCount,
        },
      }
    } catch (error: any) {
      if (signal?.aborted) {
        log.warn("OpenAICompatibleLLM", "Request aborted by user")
        return {
          stopReason: "error",
          metadata: { error: "Aborted by user", actualProvider: this.actualProvider },
        }
      }

      const errorClass = this.classifyErrorClass(error)

      // Emit finish telemetry for the failed call (latency-to-failure + error
      // class) so the caller can record degradation even though we re-throw. A
      // throwing hook must never mask the real LLM error.
      try {
        await callbacks?.onFinish?.({
          ttftMs,
          latencyMs: Math.round(performance.now() - startedAt),
          errorClass,
          actualProvider: this.actualProvider,
        })
      } catch {
        // swallow — instrumentation must not shadow the upstream failure
      }

      const llmError = this.createLLMError(error, {
        baseUrl: this.baseUrl,
        model: model || this.defaultModel,
        messageCount: openaiMessages.length,
        toolCount: openaiTools?.length || 0,
      })

      log.agentError("OpenAICompatibleLLM", llmError)
      throw llmError
    } finally {
      decInflight(this.actualProvider)
    }
  }

  /**
   * Convert MessageWithParts[] to OpenAI messages format
   */
  private async convertMessages(
    messages: MessageWithParts[],
    systemPrompt?: string,
  ): Promise<OpenAI.ChatCompletionMessageParam[]> {
    const openaiMessages: OpenAI.ChatCompletionMessageParam[] = []

    if (systemPrompt) {
      openaiMessages.push({ role: "system", content: systemPrompt })
    }

    for (const msg of messages) {
      const role = msg.info.role === "user" ? "user" : "assistant"

      const textParts: string[] = []
      const toolCalls: OpenAI.ChatCompletionMessageToolCall[] = []
      const toolResults: { tool_call_id: string; content: string }[] = []

      // Collect image file parts for user messages and process them
      const imageParts = msg.parts.filter(
        (p): p is import("../session/types").FilePart =>
          p.type === "file" && p.mime?.startsWith("image/") && role === "user",
      )
      let processedImages: Map<string, ProcessedImage> = new Map()
      if (imageParts.length > 0) {
        if (!this.imagePipeline.supportsVision(this.defaultModel)) {
          log.warn(
            "OpenAICompatibleLLM",
            `Model ${this.defaultModel} does not support vision — skipping ${imageParts.length} image(s)`,
          )
        } else {
          try {
            processedImages = await this.imagePipeline.processImages(imageParts, "openai")
          } catch (error: any) {
            log.error("OpenAICompatibleLLM", "Failed to process images for message", undefined, {
              reason: error.message,
            })
          }
        }
      }

      // Extract text + embedded images from non-image documents (PPTX/DOCX/XLSX/ODT/PDF/RTF/plain text)
      const documentParts = msg.parts.filter(
        (p): p is import("../session/types").FilePart =>
          p.type === "file" &&
          !p.mime?.startsWith("image/") &&
          DocumentExtractor.supportsDocument(p.mime) &&
          role === "user",
      )
      let extractedDocumentText: string | null = null
      const documentEmbeddedImages: ProcessedImage[] = []
      if (documentParts.length > 0) {
        try {
          const extracted = await this.documentExtractor.extractDocuments(documentParts)
          extractedDocumentText = formatDocumentsAsText(extracted)
          // Pass embedded images through ImagePipeline (resize/reformat) only if the
          // model supports vision; otherwise skip silently (text already captures content).
          const flat = collectEmbeddedImages(extracted)
          if (flat.length > 0 && this.imagePipeline.supportsVision(this.defaultModel)) {
            for (const img of flat) {
              const processed = await this.imagePipeline.processBuffer(
                img.buffer,
                img.mimeType,
                "openai",
              )
              if (processed) documentEmbeddedImages.push(processed)
            }
          } else if (flat.length > 0) {
            log.warn(
              "OpenAICompatibleLLM",
              `Model ${this.defaultModel} not vision-capable — skipping ${flat.length} embedded image(s) from document(s)`,
            )
          }
        } catch (error: any) {
          log.error("OpenAICompatibleLLM", "Failed to extract documents for message", undefined, {
            reason: error.message,
          })
        }
      }

      for (const part of msg.parts) {
        if (part.type === "text") {
          textParts.push(part.text)
        } else if (part.type === "tool") {
          if (
            role === "assistant" &&
            (part.state.status === "completed" || part.state.status === "error")
          ) {
            toolCalls.push({
              id: part.callID,
              type: "function",
              function: {
                name: part.tool,
                arguments: JSON.stringify(part.state.input || {}),
              },
            })

            toolResults.push({
              tool_call_id: part.callID,
              content:
                part.state.status === "completed"
                  ? part.state.output || ""
                  : `Error: ${part.state.error || "Unknown error"}`,
            })
          } else if (role === "user") {
            if (part.state.status === "completed") {
              toolResults.push({ tool_call_id: part.callID, content: part.state.output || "" })
            } else if (part.state.status === "error") {
              toolResults.push({
                tool_call_id: part.callID,
                content: `Error: ${part.state.error || "Unknown error"}`,
              })
            }
          }
        }
        // Image file parts are handled separately below
      }

      if (role === "assistant") {
        if (toolCalls.length > 0) {
          openaiMessages.push({
            role: "assistant",
            content: textParts.join("\n") || null,
            tool_calls: toolCalls,
          })
          for (const result of toolResults) {
            openaiMessages.push({
              role: "tool",
              tool_call_id: result.tool_call_id,
              content: result.content,
            })
          }
        } else if (textParts.length > 0) {
          openaiMessages.push({ role: "assistant", content: textParts.join("\n") })
        }
      } else {
        // User message - may include text, images, and tool results
        // Tool results go as separate 'tool' role messages first
        if (toolResults.length > 0) {
          for (const result of toolResults) {
            openaiMessages.push({
              role: "tool",
              tool_call_id: result.tool_call_id,
              content: result.content,
            })
          }
        }

        // Build content array with text and images
        // Documents (PPTX/DOCX/...) are prepended as a separate text block before user prose.
        // Images embedded inside those documents follow the text so the model can correlate them.
        const contentParts: any[] = []
        if (extractedDocumentText) {
          contentParts.push({ type: "text", text: extractedDocumentText })
        }
        for (const processed of documentEmbeddedImages) {
          contentParts.push({
            type: "image_url",
            image_url: { url: `data:${processed.mimeType};base64,${processed.base64}` },
          })
        }
        if (textParts.length > 0) {
          contentParts.push({ type: "text", text: textParts.join("\n") })
        }
        for (const part of imageParts) {
          const processed = processedImages.get(part.url)
          if (processed) {
            contentParts.push({
              type: "image_url",
              image_url: { url: `data:${processed.mimeType};base64,${processed.base64}` },
            })
          }
        }

        if (contentParts.length > 0) {
          // When there's only a single text part, use string for compatibility
          if (contentParts.length === 1 && contentParts[0].type === "text") {
            openaiMessages.push({ role: "user", content: contentParts[0].text })
          } else {
            openaiMessages.push({ role: "user", content: contentParts })
          }
        }
      }
    }

    return openaiMessages
  }

  /**
   * Read a normalized error type/code string tolerating Together's body shape.
   * The OpenAI SDK lifts `body.error.{type,code}` onto `error.{type,code}`, but
   * we also probe the raw `error.error` envelope for resilience. Lowercased;
   * `''` when absent.
   */
  private extractErrorType(error: any): string {
    const direct = error?.type ?? error?.code
    const envelope = error?.error
    const nested =
      envelope && typeof envelope === "object"
        ? ((envelope as { type?: string; code?: string }).type ??
          (envelope as { type?: string; code?: string }).code)
        : undefined
    return String(direct ?? nested ?? "").toLowerCase()
  }

  /**
   * HTTP status → telemetry error-class bucket. 503 (overloaded) is kept
   * distinct from the other 5xx (server_error); 402 is a non-retryable spend
   * gate. Together's body-level `dynamic_*_limited` is handled before this map.
   */
  private static readonly STATUS_ERROR_CLASS: Record<number, string> = {
    429: "rate_limited",
    503: "overloaded",
    500: "server_error",
    502: "server_error",
    504: "server_error",
    524: "server_error",
    529: "server_error",
    402: "spend_gate",
    401: "auth",
    403: "auth",
    404: "not_found",
  }

  /**
   * Map an OpenAI-compatible error to a telemetry "error class" bucket
   * (rate_limited / overloaded / server_error / spend_gate / auth / not_found /
   * connection). Shared by `createLLMError` (populates `context.errorClass`)
   * and the `onFinish` error path. Returns `undefined` for unclassified errors.
   *
   * Resolves the gap where `teros`/Fireworks 429 and 503 collapsed into the
   * generic catch-all — they are now distinguishable in the telemetry.
   */
  private classifyErrorClass(error: any): string | undefined {
    if (error instanceof OpenAI.APIError) {
      // Together signals dynamic rate-limiting in the body (`error.type`); per
      // their docs it can arrive on 429 or adjacent statuses → classify by type
      // first, regardless of HTTP status.
      const type = this.extractErrorType(error)
      if (type === "dynamic_request_limited" || type === "dynamic_token_limited") {
        return "rate_limited"
      }
      const mapped = OpenAICompatibleLLMAdapter.STATUS_ERROR_CLASS[error.status as number]
      if (mapped) return mapped
    }
    if (error?.code === "ECONNREFUSED" || error?.code === "ENOTFOUND") return "connection"
    return undefined
  }

  /**
   * HTTP status → telemetry sub-reason. Refines the coarse `errorClass` into the
   * honest attribution axis the ops dashboard needs: whose limit it is. 429 is
   * resolved separately (capacity vs account rate-limit) because the status
   * alone can't tell them apart. The user never sees these strings.
   */
  private static readonly STATUS_SUB_REASON: Record<number, string> = {
    402: "provider_billing",
    404: "model_unavailable",
    503: "provider_overloaded",
    500: "provider_server_error",
    502: "provider_server_error",
    504: "provider_server_error",
    524: "provider_server_error",
    529: "provider_server_error",
    401: "auth",
    403: "auth",
  }

  /**
   * Refine an error into a stable telemetry sub-reason that pins the honest
   * attribution — platform capacity (`provider_capacity` / `provider_overloaded`)
   * vs the shared account's billing (`provider_billing`) vs a missing model
   * (`model_unavailable`) vs a rate cap (`account_rate_limit` / `token_rate_limit`).
   * Derived from HTTP status plus a light probe of the literal upstream message;
   * `undefined` for unclassified errors. Drives the ops feed + alerts, never the UI.
   */
  private classifyErrorSubReason(error: any): string | undefined {
    if (!(error instanceof OpenAI.APIError)) return undefined

    // Together signals dynamic rate-limiting in the body type — distinguish the
    // request (RPM) bucket from the token (TPM) bucket so ops can tell them apart.
    const type = this.extractErrorType(error)
    if (type === "dynamic_token_limited") return "token_rate_limit"
    if (type === "dynamic_request_limited") return "account_rate_limit"

    const status = error.status as number
    if (status === 429) {
      // Fireworks dedicated/router deployments return 429 when the deployment's
      // own GPU capacity is saturated (Teros-side, transient) — the common case,
      // and a generic "rate limit exceeded" body. Only reclassify when the
      // message explicitly names a serverless RPM/TPM cap; never guess otherwise.
      const msg = (error.message ?? "").toLowerCase()
      if (/\btpm\b|tokens? per minute/.test(msg)) return "token_rate_limit"
      if (/\brpm\b|requests? per minute/.test(msg)) return "account_rate_limit"
      return "provider_capacity"
    }
    return OpenAICompatibleLLMAdapter.STATUS_SUB_REASON[status]
  }

  /**
   * The literal upstream message (SDK/provider), preserved verbatim for logs,
   * the frontend "technical details" disclosure, and the ops feed. NEVER shown
   * raw to the end user, and NEVER overwritten with our own copy (TER-222).
   */
  private extractUpstreamMessage(error: any): string | undefined {
    const msg = error?.message
    return typeof msg === "string" && msg.trim() ? msg : undefined
  }

  /** Human-readable provider label for user-facing error messages / the rate-limit widget. */
  private providerLabel(): string {
    const p = this.actualProvider
    if (!p || p === "openai-compatible") return "The AI service"
    return p.charAt(0).toUpperCase() + p.slice(1)
  }

  private createLLMError(error: any, context: Record<string, any>): LLMError {
    const errorClass = this.classifyErrorClass(error)
    const errorSubReason = this.classifyErrorSubReason(error)
    const upstreamMessage = this.extractUpstreamMessage(error)
    const source = this.providerLabel()
    // Carry the telemetry classification on the error context so downstream
    // consumers (handleAgentError / session telemetry / the ops feed) can read
    // it. `errorSubReason` pins the honest attribution; `upstreamMessage` keeps
    // the provider's literal text (never our copy, TER-222). All additive.
    const ctx = {
      ...context,
      ...(errorClass ? { errorClass } : {}),
      ...(errorSubReason ? { errorSubReason } : {}),
      ...(upstreamMessage ? { upstreamMessage } : {}),
    }

    if (error instanceof OpenAI.APIError) {
      const status = error.status
      const errorType = this.extractErrorType(error)

      if (status === 401 || status === 403) {
        return new LLMError(
          "Authentication failed. Check your API key or custom headers.",
          `${source} auth error: ${error.message}`,
          ctx,
          error,
        )
      }

      if (status === 404) {
        return new LLMError(
          "The model or endpoint was not found. Check the base URL and model name.",
          `${source} not found: ${error.message}`,
          ctx,
          error,
        )
      }

      // 429 — and Together's dynamic rate-limit signalled in the body even off a
      // non-429 status. Populate the rate-limit context so the frontend
      // RateLimitWidget can render a countdown; `error.headers` is a native
      // Headers instance (fetch SDK) → read via `.get()` (see populateRateLimitContext).
      if (status === 429 || errorClass === "rate_limited") {
        const rateLimit = populateRateLimitContext(error.headers, source)
        return new LLMError(
          "The service is very busy. Please try again in a few seconds.",
          `${source} rate limit exceeded${errorType ? ` (${errorType})` : ""}: ${error.message}`,
          { ...ctx, ...rateLimit, ...(errorType ? { rateLimitType: errorType } : {}) },
          error,
        )
      }

      if (status === 503) {
        return new LLMError(
          "The service is temporarily overloaded. Try again in a few seconds.",
          `${source} overloaded: ${error.message}`,
          ctx,
          error,
        )
      }

      if (status === 500 || status === 502) {
        return new LLMError(
          "The endpoint is unavailable. Make sure the server is running.",
          `${source} service unavailable: ${error.message}`,
          ctx,
          error,
        )
      }

      if (status === 400 || status === 413) {
        // Overflow on the default `teros`/OpenAICompatible provider (and
        // fireworks/together/cloudflare) previously fell through to the generic
        // error with no structural flag, so recovery never fired. Flag it so
        // `TurnDriver.isPromptTooLongError` triggers auto-compaction. CTX-007.
        const isOverflow = isContextLengthExceeded(status, error.message, upstreamMessage ?? error.code)
        return new LLMError(
          isOverflow
            ? "The conversation is too long. Attempting to summarize..."
            : "There was a problem with the request. Try rephrasing it.",
          `${source} request error: ${error.message}`,
          { ...ctx, isContextLengthError: isOverflow },
          error,
        )
      }
    }

    if (error.code === "ECONNREFUSED" || error.code === "ENOTFOUND") {
      return new LLMError(
        `Cannot connect to ${context.baseUrl}. Make sure the server is reachable.`,
        `${source} connection error: ${error.message}`,
        ctx,
        error instanceof Error ? error : undefined,
      )
    }

    return new LLMError(
      "Error communicating with the endpoint. Try again in a few seconds.",
      `${source} error: ${error.message || "Unknown error"}`,
      ctx,
      error instanceof Error ? error : undefined,
    )
  }

  getProviderInfo() {
    return {
      name: "OpenAI-Compatible",
      model: this.defaultModel,
      capabilities: {
        streaming: true,
        tools: true,
        thinking: false,
        vision: true,
      },
    }
  }
}
