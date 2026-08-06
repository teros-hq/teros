import type { ModelDefinition } from "../types"

/**
 * openai model definitions
 */
export const MODELS_OPENAI: ModelDefinition[] = [
  // ============================================================================
  // OPENAI (2025 Models)
  // https://platform.openai.com/docs/models
  // ============================================================================

  // --- GPT-5 Series (Flagship) ---
  {
    modelId: "gpt-5.5",
    provider: "openai",
    name: "GPT-5.5",
    description:
      "OpenAI's flagship frontier model for coding, computer use, research, and knowledge work. 1M context.",
    modelString: "gpt-5.5",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 1050000,
      maxOutputTokens: 128000,
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
      // 850k leaves 200k headroom > maxOutputTokens (128000): a turn at the
      // trigger plus a full-length output stays under the 1.05M context cap.
      triggerAt: 850000,
      targetSize: 600000,
      protectRecent: 25000,
    },
    status: "active",
  },
  {
    modelId: "gpt-5.5-pro",
    provider: "openai",
    name: "GPT-5.5 Pro",
    description: "Highest-accuracy GPT-5.5 tier for slower, precision-heavy reasoning and coding.",
    modelString: "gpt-5.5-pro",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 1050000,
      maxOutputTokens: 128000,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 16384,
    },
    reservations: {
      systemPrompt: 6000,
      memory: 12000,
      output: 16384,
    },
    compaction: {
      triggerAt: 850000,
      targetSize: 600000,
      protectRecent: 25000,
    },
    status: "disabled", // Enable for premium use cases
  },
  {
    modelId: "gpt-5.4",
    provider: "openai",
    name: "GPT-5.4",
    description:
      "Agent-ready GPT for coding and computer-use workflows at a lower cost than GPT-5.5. 1M context.",
    modelString: "gpt-5.4",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 1050000,
      maxOutputTokens: 128000,
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
      protectRecent: 25000,
    },
    status: "active",
  },
  {
    modelId: "gpt-5.4-mini",
    provider: "openai",
    name: "GPT-5.4 Mini",
    description: "Strong small GPT for subagents, quick tool use, and high-volume workloads.",
    modelString: "gpt-5.4-mini",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 400000,
      maxOutputTokens: 128000,
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
      triggerAt: 300000,
      targetSize: 200000,
      protectRecent: 15000,
    },
    status: "active",
  },
  {
    modelId: "gpt-5.2",
    provider: "openai",
    name: "GPT-5.2",
    description:
      "GPT-5.2 flagship generation. Strong for advanced reasoning, coding, and agentic tasks.",
    modelString: "gpt-5.2",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 400000,
      maxOutputTokens: 128000,
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
      triggerAt: 300000,
      targetSize: 200000,
      protectRecent: 25000,
    },
    status: "active",
  },
  {
    modelId: "gpt-5-mini",
    provider: "openai",
    name: "GPT-5 Mini",
    description: "Cost-efficient GPT-5 variant for high-throughput workloads.",
    modelString: "gpt-5-mini",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 400000,
      maxOutputTokens: 128000,
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
      triggerAt: 300000,
      targetSize: 200000,
      protectRecent: 15000,
    },
    status: "active",
  },

  // --- O-Series (Reasoning) ---
  {
    modelId: "o3",
    provider: "openai",
    name: "o3",
    description: "OpenAI's advanced reasoning model with strong multimodal capabilities.",
    modelString: "o3",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 200000,
      maxOutputTokens: 100000,
    },
    defaults: {
      temperature: 1.0, // o-series uses fixed temperature
      maxTokens: 32768,
    },
    reservations: {
      systemPrompt: 6000,
      memory: 12000,
      output: 32768,
    },
    compaction: {
      triggerAt: 150000,
      targetSize: 100000,
      protectRecent: 25000,
    },
    status: "active",
  },
  {
    modelId: "o3-pro",
    provider: "openai",
    name: "o3 Pro",
    description: "o3 with extended reasoning time for more reliable outputs on complex tasks.",
    modelString: "o3-pro",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 200000,
      maxOutputTokens: 100000,
    },
    defaults: {
      temperature: 1.0,
      maxTokens: 32768,
    },
    reservations: {
      systemPrompt: 6000,
      memory: 12000,
      output: 32768,
    },
    compaction: {
      triggerAt: 150000,
      targetSize: 100000,
      protectRecent: 25000,
    },
    status: "disabled", // Enable for premium use cases
  },
  {
    modelId: "o4-mini",
    provider: "openai",
    name: "o4 Mini",
    description: "High-volume reasoning model. Fast and cost-efficient.",
    modelString: "o4-mini",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 200000,
      maxOutputTokens: 100000,
    },
    defaults: {
      temperature: 1.0,
      maxTokens: 16384,
    },
    reservations: {
      systemPrompt: 4000,
      memory: 8000,
      output: 16384,
    },
    compaction: {
      triggerAt: 100000,
      targetSize: 80000,
      protectRecent: 15000,
    },
    status: "active",
  },

  // --- GPT-4.1 Series ---
  {
    modelId: "gpt-4.1",
    provider: "openai",
    name: "GPT-4.1",
    description:
      "Excellent for coding and precise instruction following. Replaces GPT-4.5 preview.",
    modelString: "gpt-4.1",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: false,
    },
    context: {
      maxTokens: 1047576,
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
      targetSize: 500000,
      protectRecent: 15000,
    },
    status: "active",
  },
  {
    modelId: "gpt-4.1-mini",
    provider: "openai",
    name: "GPT-4.1 Mini",
    description: "Cost-efficient GPT-4.1 variant for high-throughput use cases.",
    modelString: "gpt-4.1-mini",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: false,
    },
    context: {
      maxTokens: 1047576,
      maxOutputTokens: 32768,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 4096,
    },
    reservations: {
      systemPrompt: 2000,
      memory: 4000,
      output: 4096,
    },
    compaction: {
      triggerAt: 800000,
      targetSize: 500000,
      protectRecent: 10000,
    },
    status: "active",
  },

  // --- Legacy (still available but superseded) ---
  {
    modelId: "gpt-4o",
    provider: "openai",
    name: "GPT-4o (Legacy)",
    description: "Multimodal model with image capabilities. Migrating to GPT-4.1/5.x.",
    modelString: "gpt-4o",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: false,
    },
    context: {
      maxTokens: 128000,
      maxOutputTokens: 16384,
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
      triggerAt: 100000,
      targetSize: 80000,
      protectRecent: 15000,
    },
    status: "disabled", // Legacy, use gpt-4.1 or gpt-5.2 instead
  },
]
