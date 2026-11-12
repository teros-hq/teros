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
    modelId: "fireworks-kimi-k3",
    provider: "fireworks",
    name: "Kimi K3 (Fireworks)",
    description:
      "Moonshot AI Kimi K3 via Fireworks AI. 1M context, function calling, reasoning, and vision. Zero Data Retention by default.",
    modelString: "accounts/fireworks/models/kimi-k3",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
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
      triggerAt: 850000,
      targetSize: 600000,
      protectRecent: 20000,
    },
    cost: {
      input: 3,
      output: 15,
      cacheRead: 0.3,
    },
    status: "active",
  },
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
      maxOutputTokens: 262000,
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
    status: "deprecated",
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
    status: "deprecated",
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
    status: "deprecated",
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
      maxOutputTokens: 262000,
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
    status: "deprecated",
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
    status: "deprecated",
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
    status: "deprecated",
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
    status: "deprecated",
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
      maxOutputTokens: 512000,
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
  // ── New models (2026-08) ──────────────────────────────────────────────
  {
    modelId: "fireworks-glm-5p3",
    provider: "fireworks",
    name: "GLM-5.3 (Fireworks)",
    description:
      "Zhipu AI GLM-5.3 via Fireworks AI. 1M context, flagship GLM model for long-horizon coding, agents, and complex project delivery. Zero Data Retention by default.",
    modelString: "accounts/fireworks/models/glm-5p3",
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: true,
    },
    context: {
      maxTokens: 1048576,
      maxOutputTokens: 262144,
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
      cacheRead: 0.26,
    },
    status: "active",
  },
  {
    modelId: "fireworks-glm-5p3-fast",
    provider: "fireworks",
    name: "GLM-5.3 Fast (Fireworks)",
    description:
      "Zhipu AI GLM-5.3 Fast via Fireworks AI. 1M context, fast router for interactive applications, flagship GLM for long-horizon coding and agents. Zero Data Retention by default.",
    modelString: "accounts/fireworks/routers/glm-5p3-fast",
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: true,
    },
    context: {
      maxTokens: 1048576,
      maxOutputTokens: 262144,
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
      cacheRead: 0.39,
    },
    status: "active",
  },
  {
    modelId: "fireworks-glm-5p3-flash",
    provider: "fireworks",
    name: "GLM-5.3 Flash (Fireworks)",
    description:
      "Zhipu AI GLM-5.3 Flash via Fireworks AI. 1M context, native multimodal (vision), efficient coding and long-horizon agent tasks at very low cost. Zero Data Retention by default.",
    modelString: "accounts/fireworks/models/glm-5p3-flash",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
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
      input: 0.15,
      output: 0.5,
      cacheRead: 0.03,
    },
    status: "active",
  },
  {
    modelId: "fireworks-deepseek-v4-flash-vision-exp",
    provider: "fireworks",
    name: "DeepSeek V4 Flash Vision Exp (Fireworks)",
    description:
      "Experimental multimodal DeepSeek V4 Flash via Fireworks AI. 1M context, image understanding, coding, and agentic work. Zero Data Retention by default.",
    modelString: "accounts/fireworks/models/deepseek-v4-flash-vision-exp",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 1000000,
      maxOutputTokens: 384000,
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
      triggerAt: 600000,
      targetSize: 450000,
      protectRecent: 20000,
    },
    cost: {
      input: 0.22,
      output: 0.66,
      cacheRead: 0.007,
    },
    status: "deprecated",
  },
  {
    modelId: "fireworks-inkling",
    provider: "fireworks",
    name: "Inkling (Fireworks)",
    description:
      "Multimodal MoE reasoning model (975B total, 41B active) via Fireworks AI. 1M context, text, image, and audio input. Zero Data Retention by default.",
    modelString: "accounts/fireworks/models/inkling",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 1048576,
      maxOutputTokens: 1048576,
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
      input: 1,
      output: 4.05,
      cacheRead: 0.17,
    },
    status: "active",
  },
  {
    modelId: "fireworks-qwen3p7-plus",
    provider: "fireworks",
    name: "Qwen 3.7 Plus (Fireworks)",
    description:
      "Qwen 3.7 Plus via Fireworks AI. 262K context, vision-language model for visual reasoning, documents, and agent tasks. Zero Data Retention by default.",
    modelString: "accounts/fireworks/models/qwen3p7-plus",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 262144,
      maxOutputTokens: 65536,
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
      input: 0.4,
      output: 1.6,
      cacheRead: 0.08,
    },
    status: "deprecated",
  },
  // ── New models (2026-09) ──────────────────────────────────────────────
  {
    modelId: "fireworks-kimi-k3-fast",
    provider: "fireworks",
    name: "Kimi K3 Fast (Fireworks)",
    description:
      "Moonshot AI Kimi K3 Fast via Fireworks AI. 1M context, fast router for interactive long-horizon agent work, function calling, reasoning, and vision. Zero Data Retention by default.",
    modelString: "accounts/fireworks/routers/kimi-k3-fast",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
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
      triggerAt: 850000,
      targetSize: 600000,
      protectRecent: 20000,
    },
    cost: {
      input: 4.5,
      output: 22.5,
      cacheRead: 0.45,
    },
    status: "active",
  },
  {
    modelId: "fireworks-deepseek-v4p1-flash",
    provider: "fireworks",
    name: "DeepSeek V4.1 Flash (Fireworks)",
    description:
      "DeepSeek V4.1 Flash via Fireworks AI. 1M context, native multimodal (vision), efficient coding and agentic work at very low cost. Replaces the retired V4 Pro 0813 / V4 Flash generation. Zero Data Retention by default.",
    modelString: "accounts/fireworks/models/deepseek-v4p1-flash",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 1048576,
      maxOutputTokens: 384000,
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
      input: 0.22,
      output: 0.66,
      cacheRead: 0.007,
    },
    status: "active",
  },
]
