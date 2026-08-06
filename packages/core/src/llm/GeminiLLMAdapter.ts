/**
 * GeminiLLMAdapter - Google Gemini implementation of ILLMClient
 *
 * This adapter converts between the MessageWithParts format
 * and Google's Gemini API format, enabling provider-agnostic LLM usage.
 *
 * Architecture:
 * ConversationManager (uses MessageWithParts types)
 *   ↓
 * ILLMClient interface (generic)
 *   ↓
 * GeminiLLMAdapter (converts MessageWithParts ↔ Gemini)
 *   ↓
 * @google/genai SDK
 *
 * Notes on Gemini's API format:
 * - System prompt is passed separately (not as a message)
 * - Roles are 'user' | 'model' (not 'assistant')
 * - Tool calls: functionCall parts in model messages
 * - Tool results: functionResponse parts in user messages
 * - Streaming: generateContentStream()
 */

import {
  type Content,
  FunctionCallingConfigMode,
  type FunctionDeclaration,
  GoogleGenAI,
  type Tool,
} from "@google/genai"
import { LLMError } from "../errors/AgentError"
import { createLogger, log } from "../logger"
import type { FilePart, MessageWithParts, ToolStateCompleted } from "../session/types"
import {
  collectEmbeddedImages,
  DocumentExtractor,
  formatDocumentsAsText,
} from "./DocumentExtractor"
import type { ILLMClient, LLMResponse, StreamMessageOptions, ToolCall } from "./ILLMClient"
import { isContextLengthExceeded } from "./context-length-error"
import { ImagePipeline, type ProcessedImage } from "./ImagePipeline"
import { uncachedInputTokens } from "./usage-normalize"

export interface GeminiConfig {
  apiKey: string
  /** Model string is required (e.g., 'gemini-2.0-flash', 'gemini-2.5-pro-preview-06-05') */
  model: string
  defaultMaxTokens?: number
}

/**
 * Google Gemini LLM Adapter
 *
 * Implements the generic ILLMClient interface using Google's @google/genai SDK.
 * Handles all format conversions between MessageWithParts and Gemini formats.
 */
export class GeminiLLMAdapter implements ILLMClient {
  private client: GoogleGenAI
  private defaultModel: string
  private defaultMaxTokens: number
  private logger = createLogger("GeminiLLM")
  private imagePipeline = new ImagePipeline()
  private documentExtractor = new DocumentExtractor()

  constructor(config: GeminiConfig) {
    if (!config.model) {
      throw new Error("GeminiLLMAdapter: model is required - no defaults allowed")
    }
    if (!config.apiKey) {
      throw new Error("GeminiLLMAdapter: apiKey is required")
    }
    this.client = new GoogleGenAI({ apiKey: config.apiKey })
    this.defaultModel = config.model
    this.defaultMaxTokens = config.defaultMaxTokens || 8192
  }

  /**
   * Main streaming method
   *
   * Converts MessageWithParts[] to Gemini format,
   * streams the response, and calls callbacks for real-time updates.
   */
  async streamMessage(options: StreamMessageOptions): Promise<LLMResponse> {
    const { messages, tools, systemPrompt, model, temperature, maxTokens, signal, callbacks } =
      options

    const modelName = model || this.defaultModel
    const maxOutputTokens = maxTokens || this.defaultMaxTokens

    // Convert messages to Gemini format
    const geminiContents = await this.convertMessages(messages)

    // Convert tools to Gemini format
    const geminiTools: Tool[] | undefined = tools?.length
      ? [
          {
            functionDeclarations: tools.map(
              (tool): FunctionDeclaration => ({
                name: tool.name,
                description: tool.description,
                parametersJsonSchema: tool.input_schema,
              }),
            ),
          },
        ]
      : undefined

    log.info("GeminiLLM", "Calling Gemini API", {
      model: modelName,
      messageCount: geminiContents.length,
      toolCount: tools?.length || 0,
      maxOutputTokens,
      temperature: temperature ?? 1.0,
    })

    try {
      // Get the generative model
      const genModel = this.client.models

      // Create streaming request
      // NOTE: GenerateContentParameters only accepts {model, contents, config}.
      // All options (systemInstruction, tools, temperature, etc.) must go inside
      // config — NOT spread at the top level, which the SDK silently ignores.
      const streamResult = await genModel.generateContentStream({
        model: modelName,
        contents: geminiContents,
        config: {
          maxOutputTokens,
          temperature: temperature ?? 1.0,
          ...(systemPrompt && { systemInstruction: { parts: [{ text: systemPrompt }] } }),
          ...(geminiTools && {
            tools: geminiTools,
            toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
          }),
          abortSignal: signal,
        },
      })

      let hasToolCalls = false
      let finishReason: string | null = null
      let totalInputTokens = 0
      let totalOutputTokens = 0
      let cachedReadTokens = 0

      // Process stream chunks
      for await (const chunk of streamResult) {
        // Check for abort signal
        if (signal?.aborted) {
          break
        }

        const candidate = chunk.candidates?.[0]
        if (!candidate) continue

        const content = candidate.content
        if (!content?.parts) continue

        for (const part of content.parts) {
          if ((part as { thought?: boolean }).thought && part.text) {
            // Gemini thinking-summary part (emitted when includeThoughts is on).
            // Route to onThinking as a heartbeat for the stall watchdog — NOT to
            // onText, which would leak the reasoning summary into the assistant
            // message. Handled before the plain-text branch on purpose. TER-650.
            await callbacks?.onThinking?.(part.text)
          } else if (part.text) {
            // Text content
            await callbacks?.onText?.(part.text)
          } else if (part.functionCall) {
            // Tool call — fire immediately as chunk arrives
            hasToolCalls = true
            const thoughtSignature = (part as any).thoughtSignature
            log.debug("GeminiLLM", "Tool call chunk", {
              tool: part.functionCall.name,
              hasThoughtSignature: !!thoughtSignature,
            })
            const toolCall: ToolCall = {
              id:
                part.functionCall.id ||
                `gemini-tool-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              name: part.functionCall.name || "",
              input: (part.functionCall.args as Record<string, any>) || {},
              // thoughtSignature is a Part-level sibling field (not inside functionCall)
              // Must round-trip in history for thinking models
              ...(thoughtSignature && {
                metadata: { thoughtSignature },
              }),
            }
            await callbacks?.onToolCall?.(toolCall)
          }
        }

        // Capture finish reason
        if (candidate.finishReason) {
          finishReason = candidate.finishReason
        }

        // Capture usage metadata (usually in the last chunk)
        if (chunk.usageMetadata) {
          totalInputTokens = chunk.usageMetadata.promptTokenCount || 0
          totalOutputTokens = chunk.usageMetadata.candidatesTokenCount || 0
          // Gemini implicit context caching reports the cache hit here (the
          // registry marks google `auto`). Same pattern as the OpenAI-family
          // adapters — read-if-present, honest 0 otherwise.
          cachedReadTokens = chunk.usageMetadata.cachedContentTokenCount || 0
        }
      }

      // Notify text end
      await callbacks?.onTextEnd?.()

      // Determine stop reason
      // Gemini finish reasons: STOP, MAX_TOKENS, SAFETY, RECITATION, OTHER, FUNCTION_CALL
      let stopReason: LLMResponse["stopReason"] = "end_turn"
      if (hasToolCalls || finishReason === "FUNCTION_CALL") {
        stopReason = "tool_calls"
      } else if (finishReason === "MAX_TOKENS") {
        stopReason = "max_tokens"
      }

      const usage = {
        // `promptTokenCount` includes cachedContentTokenCount (Gemini) —
        // normalize to the canonical non-cached shape (A2.1).
        inputTokens: uncachedInputTokens(totalInputTokens, cachedReadTokens),
        outputTokens: totalOutputTokens,
        ...(cachedReadTokens > 0 ? { cacheReadInputTokens: cachedReadTokens } : {}),
      }

      log.info("GeminiLLM", "Response complete", {
        stopReason,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        model: modelName,
      })

      return {
        stopReason,
        usage,
        metadata: {
          provider: "google",
          model: modelName,
          finishReason,
        },
      }
    } catch (error: any) {
      // Check if it's an abort
      if (signal?.aborted) {
        log.warn("GeminiLLM", "Request aborted by user")
        return {
          stopReason: "error",
          metadata: { error: "Aborted by user" },
        }
      }

      const llmError = this.createLLMError(error, {
        model: modelName,
        messageCount: geminiContents.length,
        toolCount: tools?.length || 0,
      })

      log.agentError("GeminiLLM", llmError)
      throw llmError
    }
  }

  /**
   * Convert MessageWithParts[] to Gemini Content[] format
   *
   * Gemini format:
   * - role: 'user' | 'model'
   * - parts: Array<{ text } | { functionCall } | { functionResponse }>
   *
   * Key differences from OpenAI:
   * - No separate 'tool' role — function responses go in 'user' messages
   * - Tool calls are functionCall parts in 'model' messages
   * - Tool results are functionResponse parts in a subsequent 'user' message
   * - Consecutive messages of the same role must be merged
   *
   * IMPORTANT: In this codebase, both the tool call and its result are stored
   * in the same ToolPart inside the assistant (model) message. We must split
   * them: functionCall → model turn, functionResponse → next user turn.
   */
  private async convertMessages(messages: MessageWithParts[]): Promise<Content[]> {
    const contents: Content[] = []

    const pushOrMerge = (role: "user" | "model", parts: any[]) => {
      if (parts.length === 0) return
      const last = contents[contents.length - 1]
      if (last && last.role === role) {
        last.parts = [...(last.parts || []), ...parts]
      } else {
        contents.push({ role, parts })
      }
    }

    for (const msg of messages) {
      const role = msg.info.role === "user" ? "user" : "model"
      const mainParts: any[] = []
      // Tool results must become a separate 'user' turn after the model turn
      const functionResponseParts: any[] = []

      // Collect image file parts for batch processing (user messages only)
      const imageParts = msg.parts.filter(
        (p): p is import("../session/types").FilePart =>
          p.type === "file" && p.mime?.startsWith("image/") && role === "user",
      )

      // Process images through the pipeline
      let processedImages: Map<string, ProcessedImage> = new Map()
      if (imageParts.length > 0 && this.imagePipeline.supportsVision(this.defaultModel)) {
        try {
          processedImages = await this.imagePipeline.processImages(imageParts, "gemini")
        } catch (error: any) {
          log.error("GeminiLLM", "Failed to process images for message", undefined, {
            reason: error.message,
          })
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
      if (documentParts.length > 0) {
        try {
          const extracted = await this.documentExtractor.extractDocuments(documentParts)
          const documentText = formatDocumentsAsText(extracted)
          if (documentText) {
            mainParts.push({ text: documentText })
          }
          const flat = collectEmbeddedImages(extracted)
          if (flat.length > 0 && this.imagePipeline.supportsVision(this.defaultModel)) {
            for (const img of flat) {
              const processed = await this.imagePipeline.processBuffer(
                img.buffer,
                img.mimeType,
                "gemini",
              )
              if (processed) {
                mainParts.push({
                  inlineData: { mimeType: processed.mimeType, data: processed.base64 },
                })
              }
            }
          } else if (flat.length > 0) {
            log.warn(
              "GeminiLLM",
              `Model ${this.defaultModel} not vision-capable — skipping ${flat.length} embedded image(s) from document(s)`,
            )
          }
        } catch (error: any) {
          log.error("GeminiLLM", "Failed to extract documents for message", undefined, {
            reason: error.message,
          })
        }
      }

      // Collect image attachments from tool results for batch processing
      const toolResultImageParts: FilePart[] = []

      for (const part of msg.parts) {
        if (part.type === "text" && part.text) {
          mainParts.push({ text: part.text })
        } else if (part.type === "tool") {
          // INV-1: orphan tool_use must be remediated upstream (see
          // assertInvariantINV1 in PromptBuilder).
          if (part.state.status !== "completed" && part.state.status !== "error") {
            throw new Error(
              `INV-1 violation reached GeminiLLMAdapter: ToolPart ${part.callID} ` +
                `(tool=${part.tool}) has status=${part.state.status}. ` +
                `Expected 'completed' or 'error' — check assertInvariantINV1 in PromptBuilder.`,
            )
          }

          if (role === "model") {
            // The call goes in the model turn
            // thoughtSignature is a Part-level sibling, not nested inside functionCall
            log.debug("GeminiLLM", "Rebuilding history tool part", {
              tool: part.tool,
              hasThoughtSignature: !!part.metadata?.thoughtSignature,
            })
            mainParts.push({
              functionCall: {
                id: part.callID,
                name: part.tool,
                args: part.state.input || {},
              },
              ...(part.metadata?.thoughtSignature && {
                thoughtSignature: part.metadata.thoughtSignature,
              }),
            })

            // The result must go in a subsequent user turn
            if (part.state.status === "completed") {
              // Collect image attachments from tool result for processing
              const attachments = (part.state as ToolStateCompleted).attachments
              const imageAttachments = attachments?.filter(
                (a): a is FilePart => a.type === "file" && a.mime?.startsWith("image/"),
              )
              if (imageAttachments && imageAttachments.length > 0) {
                toolResultImageParts.push(...imageAttachments)
              }

              functionResponseParts.push({
                functionResponse: {
                  id: part.callID,
                  name: part.tool,
                  response: { output: part.state.output || "" },
                },
              })
            } else {
              functionResponseParts.push({
                functionResponse: {
                  id: part.callID,
                  name: part.tool,
                  response: { error: part.state.error || "Unknown error" },
                },
              })
            }
          }
          // Tool parts in user messages are not expected in this architecture
        } else if (part.type === "file" && part.mime?.startsWith("image/") && role === "user") {
          // Convert image file to Gemini inlineData part
          const processed = processedImages.get(part.url)
          if (processed) {
            mainParts.push({
              inlineData: {
                mimeType: processed.mimeType,
                data: processed.base64,
              },
            })
          }
          // If processing failed, skip silently (already logged by pipeline)
        }
      }

      // Process tool result images through the pipeline
      let processedToolResultImages: Map<string, ProcessedImage> = new Map()
      if (toolResultImageParts.length > 0 && this.imagePipeline.supportsVision(this.defaultModel)) {
        try {
          processedToolResultImages = await this.imagePipeline.processImages(
            toolResultImageParts,
            "gemini",
          )
        } catch (error: any) {
          log.error("GeminiLLM", "Failed to process tool result images", undefined, {
            reason: error.message,
          })
        }
      }

      // Add image attachments to the functionResponse user turn
      for (const img of toolResultImageParts) {
        const processed = processedToolResultImages.get(img.url)
        if (processed) {
          functionResponseParts.push({
            inlineData: {
              mimeType: processed.mimeType,
              data: processed.base64,
            },
          })
        }
      }

      pushOrMerge(role, mainParts)

      // Append function responses as a user turn immediately after the model turn
      pushOrMerge("user", functionResponseParts)
    }

    // Gemini requires the conversation to start with a 'user' turn.
    if (contents.length > 0 && contents[0].role !== "user") {
      contents.unshift({ role: "user", parts: [{ text: "" }] })
    }

    return contents
  }

  /**
   * Create a structured LLM error from Gemini error
   */
  private createLLMError(error: any, context: Record<string, any>): LLMError {
    const message = error?.message || String(error)

    // API key / auth errors
    if (message.includes("API_KEY_INVALID") || message.includes("401") || message.includes("403")) {
      return new LLMError(
        "Configuration error. Verify your Google AI API key.",
        `Gemini authentication failed: ${message}`,
        context,
        error instanceof Error ? error : undefined,
      )
    }

    // Rate limit
    if (message.includes("429") || message.includes("RESOURCE_EXHAUSTED")) {
      return new LLMError(
        "The service is very busy. Please try again in a few seconds.",
        `Gemini rate limit exceeded: ${message}`,
        context,
        error instanceof Error ? error : undefined,
      )
    }

    // Server errors
    if (message.includes("500") || message.includes("503") || message.includes("UNAVAILABLE")) {
      return new LLMError(
        "Google AI service is temporarily unavailable.",
        `Gemini service unavailable: ${message}`,
        context,
        error instanceof Error ? error : undefined,
      )
    }

    // Bad request
    if (message.includes("400") || message.includes("INVALID_ARGUMENT")) {
      // Flag context-length overflow structurally so recovery fires. Gemini
      // signals status inside the message string, so the branch is the gate and
      // the detector matches the overflow wording. CTX-007.
      const isOverflow = isContextLengthExceeded(undefined, message)
      return new LLMError(
        isOverflow
          ? "The conversation is too long. Attempting to summarize..."
          : "There was a problem with the request to Google AI.",
        `Gemini request error: ${message}`,
        { ...context, isContextLengthError: isOverflow },
        error instanceof Error ? error : undefined,
      )
    }

    return new LLMError(
      "No puedo conectar con Google AI. Intenta de nuevo en unos segundos.",
      `Gemini error: ${message}`,
      context,
      error instanceof Error ? error : undefined,
    )
  }

  getProviderInfo() {
    return {
      name: "Google Gemini",
      model: this.defaultModel,
      capabilities: {
        streaming: true,
        tools: true,
        vision: this.imagePipeline.supportsVision(this.defaultModel),
        thinking: true, // Gemini 2.5 Pro has thinking
      },
    }
  }
}
