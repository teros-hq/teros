import type { ModelDefinition } from "../types"

/**
 * Cloudflare model definitions
 *
 * User-owned Cloudflare Workers AI provider.
 * Each user configures their own Cloudflare account ID and API token.
 * Base URL: https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1
 * https://developers.cloudflare.com/workers-ai/models/
 */
export const MODELS_CLOUDFLARE: ModelDefinition[] = [
  // ============================================================================
  // CLOUDFLARE (Cloudflare Workers AI — OpenAI-compatible API, user-owned)
  // ============================================================================
  {
    modelId: "cloudflare-kimi-k2.5",
    provider: "cloudflare",
    name: "Kimi K2.5",
    description: "Moonshot AI Kimi K2.5. 256K context, function calling, reasoning, and vision.",
    modelString: "@cf/moonshotai/kimi-k2.5",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 262144,
      maxOutputTokens: 16384,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 8192,
    },
    reservations: {
      systemPrompt: 6000,
      memory: 12000,
      output: 8192,
    },
    compaction: {
      triggerAt: 200000,
      targetSize: 130000,
      protectRecent: 20000,
    },
    status: "deprecated", // Removed from the Workers AI catalog upstream — use kimi-k2.6 or kimi-k2.7-code
  },
  {
    modelId: "cloudflare-kimi-k2.6",
    provider: "cloudflare",
    name: "Kimi K2.6",
    description: "Moonshot AI Kimi K2.6. 262K context, function calling, reasoning, and vision.",
    modelString: "@cf/moonshotai/kimi-k2.6",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 262144,
      maxOutputTokens: 16384,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 8192,
    },
    reservations: {
      systemPrompt: 6000,
      memory: 12000,
      output: 8192,
    },
    compaction: {
      triggerAt: 200000,
      targetSize: 130000,
      protectRecent: 20000,
    },
    status: "active",
  },
  {
    modelId: "cloudflare-kimi-k2.7-code",
    provider: "cloudflare",
    name: "Kimi K2.7 Code",
    description:
      "Moonshot AI Kimi K2.7 Code. 262K context, coding-specialized, function calling, reasoning, and vision.",
    modelString: "@cf/moonshotai/kimi-k2.7-code",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 262144,
      maxOutputTokens: 16384,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 8192,
    },
    reservations: {
      systemPrompt: 6000,
      memory: 12000,
      output: 8192,
    },
    compaction: {
      triggerAt: 200000,
      targetSize: 130000,
      protectRecent: 20000,
    },
    status: "active",
  },
  {
    modelId: "cloudflare-glm-5.2",
    provider: "cloudflare",
    name: "GLM 5.2",
    description:
      "Zhipu AI GLM-5.2. 262K context, function calling, reasoning, and agentic workflows.",
    modelString: "@cf/zai-org/glm-5.2",
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: true,
    },
    context: {
      maxTokens: 262144,
      maxOutputTokens: 16384,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 8192,
    },
    reservations: {
      systemPrompt: 6000,
      memory: 12000,
      output: 8192,
    },
    compaction: {
      triggerAt: 200000,
      targetSize: 130000,
      protectRecent: 20000,
    },
    status: "active",
  },
]
