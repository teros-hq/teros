import type { ModelDefinition } from "../types"

/**
 * google model definitions
 */
export const MODELS_GOOGLE: ModelDefinition[] = [
  // ============================================================================
  // GOOGLE (Gemini)
  // ============================================================================
  {
    modelId: "gemini-2.0-flash",
    provider: "google",
    name: "Gemini 2.0 Flash",
    description: "Google's fast multimodal model with native tool use. 1M context.",
    modelString: "gemini-2.0-flash",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: false,
    },
    context: {
      maxTokens: 1000000,
      maxOutputTokens: 8192,
    },
    defaults: {
      temperature: 1.0,
      maxTokens: 4096,
    },
    reservations: {
      systemPrompt: 4000,
      memory: 8000,
      output: 4096,
    },
    compaction: {
      triggerAt: 800000,
      targetSize: 500000,
      protectRecent: 50000,
    },
    status: "disabled", // No longer available for new API keys
  },
  {
    modelId: "gemini-2.5-flash",
    provider: "google",
    name: "Gemini 2.5 Flash",
    description: "Google's best price-performance model with thinking. 1M context.",
    modelString: "gemini-2.5-flash",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 1000000,
      maxOutputTokens: 65536,
    },
    defaults: {
      temperature: 1.0,
      maxTokens: 8192,
    },
    reservations: {
      systemPrompt: 4000,
      memory: 8000,
      output: 8192,
    },
    compaction: {
      triggerAt: 800000,
      targetSize: 500000,
      protectRecent: 50000,
    },
    status: "active",
  },
  {
    modelId: "gemini-2.5-pro",
    provider: "google",
    name: "Gemini 2.5 Pro",
    description: "Google's most capable model with extended thinking. 1M context.",
    modelString: "gemini-2.5-pro",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 1000000,
      maxOutputTokens: 65536,
    },
    defaults: {
      temperature: 1.0,
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
      protectRecent: 50000,
    },
    status: "active",
  },

  {
    modelId: "gemini-3-flash-preview",
    provider: "google",
    name: "Gemini 3 Flash Preview",
    description: "Google's Gemini 3 Flash preview. Fast and capable with tool use. 1M context.",
    modelString: "gemini-3-flash-preview",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: false,
    },
    context: {
      maxTokens: 1000000,
      maxOutputTokens: 65536,
    },
    defaults: {
      temperature: 1.0,
      maxTokens: 8192,
    },
    reservations: {
      systemPrompt: 4000,
      memory: 8000,
      output: 8192,
    },
    compaction: {
      triggerAt: 800000,
      targetSize: 500000,
      protectRecent: 50000,
    },
    status: "active",
  },

  {
    modelId: "gemini-3.1-pro-preview",
    provider: "google",
    name: "Gemini 3.1 Pro Preview",
    description: "Google's latest Gemini 3.1 Pro preview. Most capable Gemini model. 1M context.",
    modelString: "gemini-3.1-pro-preview",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: false,
    },
    context: {
      maxTokens: 1000000,
      maxOutputTokens: 65536,
    },
    defaults: {
      temperature: 1.0,
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
      protectRecent: 50000,
    },
    status: "active",
  },
  {
    modelId: "gemini-3.1-flash-lite-preview",
    provider: "google",
    name: "Gemini 3.1 Flash Lite Preview",
    description:
      "Google's Gemini 3.1 Flash Lite preview. Superseded by the GA gemini-3.1-flash-lite.",
    modelString: "gemini-3.1-flash-lite-preview",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: false,
    },
    context: {
      maxTokens: 1000000,
      maxOutputTokens: 65536,
    },
    defaults: {
      temperature: 1.0,
      maxTokens: 4096,
    },
    reservations: {
      systemPrompt: 4000,
      memory: 8000,
      output: 4096,
    },
    compaction: {
      triggerAt: 800000,
      targetSize: 500000,
      protectRecent: 50000,
    },
    status: "deprecated", // Deprecated upstream — use gemini-3.1-flash-lite (GA)
  },
  {
    modelId: "gemini-3.1-flash-lite",
    provider: "google",
    name: "Gemini 3.1 Flash Lite",
    description:
      "Low-latency Gemini model for high-volume multimodal and agent workloads. 1M context.",
    modelString: "gemini-3.1-flash-lite",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: false,
    },
    context: {
      maxTokens: 1000000,
      maxOutputTokens: 65536,
    },
    defaults: {
      temperature: 1.0,
      maxTokens: 4096,
    },
    reservations: {
      systemPrompt: 4000,
      memory: 8000,
      output: 4096,
    },
    compaction: {
      triggerAt: 800000,
      targetSize: 500000,
      protectRecent: 50000,
    },
    status: "active",
  },
  {
    modelId: "gemini-3.5-flash",
    provider: "google",
    name: "Gemini 3.5 Flash",
    description:
      "Latest Gemini Flash generation. Fast multimodal reasoning and tool use at low cost. 1M context.",
    modelString: "gemini-3.5-flash",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: false,
    },
    context: {
      maxTokens: 1000000,
      maxOutputTokens: 65536,
    },
    defaults: {
      temperature: 1.0,
      maxTokens: 8192,
    },
    reservations: {
      systemPrompt: 4000,
      memory: 8000,
      output: 8192,
    },
    compaction: {
      triggerAt: 800000,
      targetSize: 500000,
      protectRecent: 50000,
    },
    status: "active",
  },
]
