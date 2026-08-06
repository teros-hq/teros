import type { ModelDefinition } from "../types"

/**
 * Fireworks AI model definitions
 *
 * User-owned Fireworks AI provider with Zero Data Retention by default.
 * Each user configures their own Fireworks API key.
 * Base URL: https://api.fireworks.ai/inference/v1
 * https://docs.fireworks.ai/
 */
export const MODELS_FIREWORKS: ModelDefinition[] = [
  // ============================================================================
  // FIREWORKS AI (Zero Data Retention — OpenAI-compatible API, user-owned)
  // ============================================================================
  {
    modelId: "fireworks-kimi-k2p6",
    provider: "fireworks",
    name: "Kimi K2.6 (Fireworks)",
    description:
      "Moonshot AI Kimi K2.6 via Fireworks AI. 262K context, function calling, reasoning, and vision. Zero Data Retention by default.",
    modelString: "accounts/fireworks/models/kimi-k2p6",
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
    cost: {
      input: 0.95,
      output: 4.0,
      cacheRead: 0.16,
    },
    status: "active",
  },
  {
    modelId: "fireworks-glm-5p2",
    provider: "fireworks",
    name: "GLM-5.2 (Fireworks)",
    description:
      "Zhipu AI GLM-5.2 via Fireworks AI. 1M context, function calling, reasoning, and agentic workflows. Zero Data Retention by default.",
    modelString: "accounts/fireworks/models/glm-5p2",
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: true,
    },
    context: {
      maxTokens: 1048576,
      maxOutputTokens: 131072,
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
      triggerAt: 800000,
      targetSize: 500000,
      protectRecent: 20000,
    },
    cost: {
      input: 1.4,
      output: 4.4,
      cacheRead: 0.14,
    },
    status: "active",
  },
  {
    modelId: "fireworks-glm-5p2-fast",
    provider: "fireworks",
    name: "GLM-5.2 Fast (Fireworks)",
    description:
      "Zhipu AI GLM-5.2 Fast via Fireworks AI. 1M context, fast router for interactive applications, function calling, reasoning, and agentic workflows. Zero Data Retention by default.",
    modelString: "accounts/fireworks/routers/glm-5p2-fast",
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: true,
    },
    context: {
      maxTokens: 1048576,
      maxOutputTokens: 131072,
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
      triggerAt: 800000,
      targetSize: 500000,
      protectRecent: 20000,
    },
    cost: {
      input: 2.1,
      output: 6.6,
      cacheRead: 0.21,
    },
    status: "active",
  },
  {
    modelId: "fireworks-kimi-k2p7-code",
    provider: "fireworks",
    name: "Kimi K2.7 Code (Fireworks)",
    description:
      "Moonshot AI Kimi K2.7 Code via Fireworks AI. 262K context, coding-specialized, agentic reasoning, and vision. Zero Data Retention by default.",
    modelString: "accounts/fireworks/models/kimi-k2p7-code",
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
    cost: {
      input: 0.95,
      output: 4.0,
      cacheRead: 0.19,
    },
    status: "active",
  },
  {
    modelId: "fireworks-kimi-k2p7-code-fast",
    provider: "fireworks",
    name: "Kimi K2.7 Code Fast (Fireworks)",
    description:
      "Moonshot AI Kimi K2.7 Code Fast via Fireworks AI. 262K context, fast router for interactive coding, agentic reasoning, and vision. Zero Data Retention by default.",
    modelString: "accounts/fireworks/routers/kimi-k2p7-code-fast",
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
    cost: {
      input: 1.9,
      output: 8.0,
      cacheRead: 0.38,
    },
    status: "active",
  },
  {
    modelId: "fireworks-deepseek-v4-pro",
    provider: "fireworks",
    name: "DeepSeek V4 Pro (Fireworks)",
    description:
      "DeepSeek V4 Pro via Fireworks AI. 1M context, open-weights frontier model for coding and reasoning. Zero Data Retention by default.",
    modelString: "accounts/fireworks/models/deepseek-v4-pro",
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: true,
    },
    context: {
      maxTokens: 1000000,
      maxOutputTokens: 131072,
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
      triggerAt: 850000,
      targetSize: 600000,
      protectRecent: 20000,
    },
    cost: {
      input: 1.74,
      output: 3.48,
      cacheRead: 0.145,
    },
    status: "active",
  },
  {
    modelId: "fireworks-deepseek-v4-flash",
    provider: "fireworks",
    name: "DeepSeek V4 Flash (Fireworks)",
    description:
      "DeepSeek V4 Flash via Fireworks AI. 1M context, very low cost for high-volume workloads. Zero Data Retention by default.",
    modelString: "accounts/fireworks/models/deepseek-v4-flash",
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: true,
    },
    context: {
      maxTokens: 1000000,
      maxOutputTokens: 131072,
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
      triggerAt: 850000,
      targetSize: 600000,
      protectRecent: 20000,
    },
    cost: {
      input: 0.14,
      output: 0.28,
      cacheRead: 0.028,
    },
    status: "active",
  },
  {
    modelId: "fireworks-minimax-m3",
    provider: "fireworks",
    name: "MiniMax M3 (Fireworks)",
    description:
      "MiniMax M3 via Fireworks AI. 512K context, reasoning and function calling at very low cost. Zero Data Retention by default.",
    modelString: "accounts/fireworks/models/minimax-m3",
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: true,
    },
    context: {
      maxTokens: 512000,
      maxOutputTokens: 131072,
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
      triggerAt: 380000,
      targetSize: 250000,
      protectRecent: 20000,
    },
    cost: {
      input: 0.3,
      output: 1.2,
      cacheRead: 0.06,
    },
    status: "active",
  },
]
