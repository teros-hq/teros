import type { ModelDefinition } from "../types"

/**
 * Helmcode model definitions
 *
 * Helmcode — Spanish (Canary Islands) private AI inference platform.
 * Open-weight models running on EU-owned hardware, zero logs, flat-rate pricing.
 * OpenAI-compatible API. Base URL: https://api.helmcode.com/v1
 * BYOK: each user brings their own API key (Bearer auth).
 * https://helmcode.com
 *
 * Billing: flat-rate per key, not per token → billingType: 'subscription', cost omitted.
 * Only models with tool calling support are included.
 */
export const MODELS_HELMCODE: ModelDefinition[] = [
  // ============================================================================
  // HELMCODE (OpenAI-compatible API — EU private inference, flat-rate, BYOK)
  // ============================================================================
  // @todo nira - 2026.09.22 : confirm modelString "glm5.3" against the live API
  // (GET /v1/models). The marketing site lists "glm-5.3" (with hyphen) but the
  // official docs (/es/docs/models) and curl examples use "glm5.3" (no hyphen).
  {
    modelId: "helmcode-glm-5.3",
    provider: "helmcode",
    name: "GLM 5.3 (Helmcode)",
    description:
      "Zhipu AI GLM-5.3 via Helmcode. 1M context, reasoning and function calling. EU-hosted, zero logs, flat-rate.",
    modelString: "glm5.3",
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: true,
    },
    context: {
      maxTokens: 1000000,
      // @todo nira - 2026.09.22 : maxOutputTokens not documented by Helmcode — using 32768 as conservative default. Confirm against API/docs.
      maxOutputTokens: 32768,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 4096,
    },
    reservations: {
      systemPrompt: 4000,
      memory: 8000,
      output: 4096,
    },
    compaction: {
      triggerAt: 800000,
      targetSize: 600000,
      protectRecent: 20000,
    },
    // @todo nira - 2026.09.22 : Helmcode is flat-rate per key (tarifa plana), not per-token.
    // Marginal cost is 0 → cost omitted, billingType set to 'subscription'.
    // If Helmcode introduces per-token billing in the future, add cost here.
    billingType: "subscription",
    status: "active",
  },
  {
    modelId: "helmcode-deepseek-v4-flash",
    provider: "helmcode",
    name: "DeepSeek V4 Flash (Helmcode)",
    description:
      "DeepSeek V4 Flash via Helmcode. 1M context, fast reasoning and function calling. EU-hosted, zero logs, flat-rate.",
    modelString: "deepseek-v4-flash",
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: true,
    },
    context: {
      maxTokens: 1000000,
      // @todo nira - 2026.09.22 : maxOutputTokens not documented by Helmcode — using 32768 as conservative default. Confirm against API/docs.
      maxOutputTokens: 32768,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 4096,
    },
    reservations: {
      systemPrompt: 4000,
      memory: 8000,
      output: 4096,
    },
    compaction: {
      triggerAt: 800000,
      targetSize: 600000,
      protectRecent: 20000,
    },
    // @todo nira - 2026.09.22 : Helmcode is flat-rate per key (tarifa plana), not per-token.
    // Marginal cost is 0 → cost omitted, billingType set to 'subscription'.
    billingType: "subscription",
    status: "active",
  },
  {
    modelId: "helmcode-qwen3.6",
    provider: "helmcode",
    name: "Qwen3.6 35B (Helmcode)",
    description:
      "Qwen3.6 35B via Helmcode. 262K context, vision, reasoning and function calling. EU-hosted, zero logs, flat-rate.",
    modelString: "qwen3.6",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 262144,
      // @todo nira - 2026.09.22 : maxOutputTokens not documented by Helmcode — using 32768 as conservative default. Confirm against API/docs.
      maxOutputTokens: 32768,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 4096,
    },
    reservations: {
      systemPrompt: 4000,
      memory: 8000,
      output: 4096,
    },
    compaction: {
      triggerAt: 200000,
      targetSize: 130000,
      protectRecent: 20000,
    },
    // @todo nira - 2026.09.22 : Helmcode is flat-rate per key (tarifa plana), not per-token.
    // Marginal cost is 0 → cost omitted, billingType set to 'subscription'.
    billingType: "subscription",
    status: "active",
  },
  {
    modelId: "helmcode-gemma4",
    provider: "helmcode",
    name: "Gemma 4 26B (Helmcode)",
    description:
      "Google Gemma 4 26B via Helmcode. 262K context, vision, reasoning and function calling. EU-hosted, zero logs, flat-rate.",
    modelString: "gemma4",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 262144,
      // @todo nira - 2026.09.22 : maxOutputTokens not documented by Helmcode — using 32768 as conservative default. Confirm against API/docs.
      maxOutputTokens: 32768,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 4096,
    },
    reservations: {
      systemPrompt: 4000,
      memory: 8000,
      output: 4096,
    },
    compaction: {
      triggerAt: 200000,
      targetSize: 130000,
      protectRecent: 20000,
    },
    // @todo nira - 2026.09.22 : Helmcode is flat-rate per key (tarifa plana), not per-token.
    // Marginal cost is 0 → cost omitted, billingType set to 'subscription'.
    billingType: "subscription",
    status: "active",
  },
]
