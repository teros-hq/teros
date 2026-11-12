/**
 * Internal LLM Service
 *
 * Provides LLM capabilities for internal system tasks like:
 * - Channel auto-naming
 * - Conversation summarization
 * - Content classification
 *
 * Always uses the system user's Teros provider — the credential-free internal
 * path (no environment variables, no user secrets). The provider is
 * provisioned on demand (self-heal), so a fresh environment works with no
 * seeds or migrations.
 *
 * Latency lane (TLANE-REQ-4): these calls run outside an agent turn and go on
 * the `background` lane unless the call site declares `interactive` because a
 * person is waiting on the result (transcript cleaner, agent.generate-profile).
 *
 * @spec TLANE-REQ-4
 */

import type { ILLMClient } from "@teros/core"
import type { Db } from "mongodb"
import type { ProviderService } from "./provider-service"
import { TerosRouterClient } from "./teros-router-client"
import { getUserTerosProviderConfig } from "./billing-gate"
import { sizeForLegacyModelId, TEROS_LANES, type TerosLane } from "../models/providers/teros"
import { secrets as secretsManager } from "../secrets/secrets-manager"

export interface InternalLLMServiceConfig {
  /** Model ID to use (e.g., 'claude-haiku-4-5') */
  modelId: string
}

// Cheap Teros-provider model for internal one-off tasks (letters, titles).
// Teros provider is credential-free for users — its upstream key comes from
// system secrets via resolveTerosUpstream, so this works on any deployment.
// glm-5p3-flash is a thinking-only model: reasoning_effort 'low' is REQUIRED
// (Fireworks rejects 'none') or it burns the whole budget reasoning and
// returns no content.
// TPROV-REQ-8: internal one-off tasks run on size S (the config says which upstream model).
const DEFAULT_MODEL_ID = "teros-s"
const SYSTEM_USER_ID = "system"

export class InternalLLMService {
  private client: ILLMClient | null = null
  private modelId: string

  constructor(
    private db: Db,
    private providerService: ProviderService,
    config?: Partial<InternalLLMServiceConfig>,
  ) {
    this.modelId = config?.modelId || DEFAULT_MODEL_ID
  }

  /**
   * Initialize the LLM client
   * Called lazily on first use
   */
  private async ensureClient(): Promise<ILLMClient> {
    if (this.client) {
      return this.client
    }

    // Self-heal FIRST (order matters — this used to run after a 0-providers
    // throw, making it dead code on a fresh environment): ensure the
    // credential-free Teros provider exists for the system user. Idempotent
    // no-op when already provisioned. The virtual `system` user is not in the
    // `users` collection, so migrations that iterate users never provision it —
    // this call is the only path that does.
    await this.providerService.ensureDefaultTerosProvider(SYSTEM_USER_ID)

    // Policy: internal LLM tasks ALWAYS use the Teros provider. No fallback to
    // "any active provider" — one path, the credential-free one.
    const providers = await this.providerService.listUserProviders(SYSTEM_USER_ID)
    const provider = providers.find((p) => p.providerType === "teros" && p.status === "active")
    if (!provider) {
      // After ensureDefaultTerosProvider this should be unreachable, but keep a
      // safety check with an actionable message.
      throw new Error(
        "[InternalLLM] Teros provider unavailable for system user — ensureDefaultTerosProvider failed (check .secrets/system/fireworks.json)",
      )
    }

    // Find the requested model in this provider
    const model = provider.models.find((m) => m.modelId === this.modelId)
    if (!model) {
      // Fallback to first available model
      const fallbackModel = provider.models[0]
      console.warn(`[InternalLLM] Model ${this.modelId} not found, using ${fallbackModel.modelId}`)
      this.modelId = fallbackModel.modelId
    }

    const modelToUse = model || provider.models[0]

    console.log(
      `[InternalLLM] Using model: ${modelToUse.modelId} (${provider.providerType}) from system provider`,
    )

    // Always the credential-free Teros provider: the size router resolves the
    // upstream/model from the default config + system secrets (TPROV-REQ-8).
    const cfg = await getUserTerosProviderConfig(this.db, SYSTEM_USER_ID)
    if (!cfg?.sizes || !cfg.failover) {
      throw new Error("[InternalLLM] Teros provider config has no size routes — run migrations 20261103_001 and 20261109_001")
    }
    const client = new TerosRouterClient({
      size: sizeForLegacyModelId(modelToUse.modelId),
      config: { sizes: cfg.sizes, failover: cfg.failover },
      secrets: secretsManager,
      maxTokens: 1000, // default headroom; per-call values override
    })
    if (TEROS_LANES.some((lane) => !client.primaryRoute(lane))) {
      throw new Error("[InternalLLM] Teros upstream not configured (missing system secret for the configured upstream)")
    }
    this.client = client
    return this.client
  }

  /**
   * Generate a channel name based on conversation context
   */
  async generateChannelName(
    messages: Array<{ role: string; text: string }>,
  ): Promise<string | null> {
    try {
      const client = await this.ensureClient()

      const conversationContext = messages.map((m) => `${m.role}: ${m.text}`).join("\n")

      const prompt = `Generate a conversation title. Follow ALL rules or your output will be rejected.

MANDATORY FORMAT (will be rejected if violated):
✓ Exactly ONE line (no \\n characters)
✓ 5-10 words, max 70 characters
✓ Same language as conversation
✓ Plain text only (no quotes, asterisks, formatting)

CONTENT:
✓ Main topic or user objective
✓ Specific details (tech, names, actions)
✓ Only what was discussed (no assumptions)

EXAMPLES OF VALID OUTPUT:
Debugging login error in React Native app
Setting up push notifications on iOS
Q3 sales analysis for presentation

INVALID OUTPUT (DO NOT OUTPUT THESE):
❌ "Based on...", "Here's...", "Title:"
❌ Multiple lines or explanations
❌ Questions like "I need more context..."
❌ Generic titles like "Programming help"

Conversation:
${conversationContext}

Output (title only, one line):`

      let generatedText = ""

      await client.streamMessage({
        messages: [
          {
            info: {
              id: "internal-naming",
              sessionID: "internal",
              role: "user",
              time: { created: Date.now() },
            },
            parts: [
              {
                type: "text",
                id: "part-1",
                sessionID: "internal",
                messageID: "internal-naming",
                text: prompt,
              },
            ],
          },
        ],
        // Thinking models (default teros-glm-5p3-flash) spend budget on
        // reasoning before content — 30 tokens produced empty titles.
        maxTokens: 500,
        lane: "background", // TLANE-REQ-4: titles are not waited on
        callbacks: {
          onText: (chunk) => {
            generatedText += chunk
          },
        },
      })

      const title = generatedText.trim()

      if (!title) {
        return null
      }

      console.log(`[InternalLLM] Generated channel name: "${title}"`)
      return title
    } catch (error) {
      console.error("[InternalLLM] Error generating channel name:", error)
      return null
    }
  }

  /**
   * Generate structured text (e.g. JSON) for internal features that need more
   * than a one-liner — like the new-conversation letter. Same provider setup
   * as generateChannelName but with a configurable token budget.
   */
  async generateStructured(prompt: string, maxTokens = 1200): Promise<string | null> {
    try {
      const client = await this.ensureClient()

      let generatedText = ""

      await client.streamMessage({
        messages: [
          {
            info: {
              id: "internal-structured",
              sessionID: "internal",
              role: "user",
              time: { created: Date.now() },
            },
            parts: [
              {
                type: "text",
                id: "part-1",
                sessionID: "internal",
                messageID: "internal-structured",
                text: prompt,
              },
            ],
          },
        ],
        maxTokens,
        lane: "background", // TLANE-REQ-4: letters, suggested prompts
        callbacks: {
          onText: (chunk) => {
            generatedText += chunk
          },
        },
      })

      const result = generatedText.trim()
      if (!result) {
        return null
      }

      return result
    } catch (error) {
      console.error("[InternalLLM] Error generating structured text:", error)
      return null
    }
  }

  /**
   * Generic one-shot text generation for internal features (e.g.
   * agent.generate-profile). Same stream-with-accumulator pattern as the
   * other generators, but errors propagate to the caller (the handler wraps
   * them into its own error reporting) and the trimmed text is returned as-is
   * — an empty response is the caller's business.
   */
  async generateText(
    prompt: string,
    /** `lane`: `interactive` when a person waits on the result; `background` otherwise (TLANE-REQ-4). */
    opts?: { maxTokens?: number; systemPrompt?: string; lane?: TerosLane },
  ): Promise<string> {
    const client = await this.ensureClient()

    let generatedText = ""

    await client.streamMessage({
      messages: [
        {
          info: {
            id: "internal-generate",
            sessionID: "internal",
            role: "user",
            time: { created: Date.now() },
          },
          parts: [
            {
              type: "text",
              id: "part-1",
              sessionID: "internal",
              messageID: "internal-generate",
              text: prompt,
            },
          ],
        },
      ],
      maxTokens: opts?.maxTokens ?? 1000,
      systemPrompt: opts?.systemPrompt,
      lane: opts?.lane ?? "background",
      callbacks: {
        onText: (chunk) => {
          generatedText += chunk
        },
      },
    })

    return generatedText.trim()
  }

  /**
   * Generate a summary of conversation messages
   * Used for compaction and context management
   */
  async generateSummary(
    messages: Array<{ role: string; text: string }>,
    maxLength: number = 500,
  ): Promise<string | null> {
    try {
      const client = await this.ensureClient()

      const conversationContext = messages.map((m) => `${m.role}: ${m.text}`).join("\n")

      const prompt = `Summarize this conversation in ${maxLength} characters or less.
Focus on:
- Key decisions made
- Important information shared
- Action items or next steps
- Main topics discussed

Keep the same language as the conversation.

Conversation:
${conversationContext}`

      let generatedText = ""

      await client.streamMessage({
        messages: [
          {
            info: {
              id: "internal-summary",
              sessionID: "internal",
              role: "user",
              time: { created: Date.now() },
            },
            parts: [
              {
                type: "text",
                id: "part-1",
                sessionID: "internal",
                messageID: "internal-summary",
                text: prompt,
              },
            ],
          },
        ],
        maxTokens: 1000, // thinking models need headroom for reasoning + summary
        lane: "background", // TLANE-REQ-4
        callbacks: {
          onText: (chunk) => {
            generatedText += chunk
          },
        },
      })

      return generatedText.trim() || null
    } catch (error) {
      console.error("[InternalLLM] Error generating summary:", error)
      return null
    }
  }

  /**
   * Check if the service is available (client can be created)
   */
  async isAvailable(): Promise<boolean> {
    try {
      await this.ensureClient()
      return true
    } catch {
      return false
    }
  }
}
