/**
 * Internal LLM Service
 *
 * Provides LLM capabilities for internal system tasks like:
 * - Channel auto-naming
 * - Conversation summarization
 * - Content classification
 *
 * Uses the system user's provider (no environment variables).
 * Abstracts away the provider so we can switch models easily.
 */

import { type ILLMClient, LLMClientFactory, type LLMConfig } from "@teros/core"
import type { Db } from "mongodb"
import type { ProviderService } from "./provider-service"

export interface InternalLLMServiceConfig {
  /** Model ID to use (e.g., 'claude-haiku-4-5') */
  modelId: string
}

const DEFAULT_MODEL_ID = "openrouter-claude-haiku-4-5"
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

    // Get system user's providers
    const providers = await this.providerService.listUserProviders(SYSTEM_USER_ID)
    if (providers.length === 0) {
      throw new Error(
        `[InternalLLM] No provider configured for system user. Run: npm run init:system-provider`,
      )
    }

    // Use the first active provider
    const provider = providers.find((p) => p.status === "active") || providers[0]

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

    // Get decrypted secrets
    const secrets = await this.providerService.getProviderSecrets(
      SYSTEM_USER_ID,
      provider.providerId,
    )

    if (!secrets || !secrets.apiKey) {
      throw new Error(`[InternalLLM] Failed to decrypt secrets for provider ${provider.providerId}`)
    }

    // Build LLMConfig based on provider type
    const llmConfig: LLMConfig = {
      provider: provider.providerType as LLMConfig["provider"],
    }

    // Configure provider-specific settings
    if (provider.providerType === "anthropic") {
      llmConfig.anthropic = {
        apiKey: secrets.apiKey,
        model: modelToUse.modelString,
        maxTokens: 200, // Internal tasks don't need long outputs
      }
    } else if (provider.providerType === "openai") {
      llmConfig.openai = {
        apiKey: secrets.apiKey,
        model: modelToUse.modelString,
        maxTokens: 200,
      }
    } else if (provider.providerType === "openrouter") {
      llmConfig.openrouter = {
        apiKey: secrets.apiKey,
        model: modelToUse.modelString,
        maxTokens: 200,
      }
    } else {
      throw new Error(`[InternalLLM] Unsupported provider: ${provider.providerType}`)
    }

    this.client = await LLMClientFactory.create(llmConfig)
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
        maxTokens: 30,
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
        maxTokens: 200,
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
