import type { ModelDefinition } from "../types"

/**
 * minimax model definitions
 */
export const MODELS_MINIMAX: ModelDefinition[] = [
  // ============================================================================
  // MINIMAX (Token Plan — Anthropic-compatible API)
  // https://platform.minimax.io/docs/api-reference/text-anthropic-api
  // ============================================================================
  {
    modelId: "minimax-m3",
    provider: "minimax",
    name: "MiniMax M3",
    description:
      "MiniMax flagship multimodal model. 1M context, vision (image + video), thinking support.",
    modelString: "MiniMax-M3",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 1000000,
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
      // 850k leaves 150k headroom > maxOutputTokens (128000): a turn at the
      // trigger plus a full-length output stays under the 1M context cap.
      triggerAt: 850000,
      targetSize: 600000,
      protectRecent: 20000,
    },
    status: "active",
  },
  {
    modelId: "minimax-m2.7",
    provider: "minimax",
    name: "MiniMax M2.7",
    description: "MiniMax M2.7 with 204K context and thinking support. 60 tps.",
    modelString: "MiniMax-M2.7",
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: true,
    },
    context: {
      maxTokens: 204800,
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
      triggerAt: 155000,
      targetSize: 100000,
      protectRecent: 20000,
    },
    status: "active",
  },
  {
    modelId: "minimax-m2.7-highspeed",
    provider: "minimax",
    name: "MiniMax M2.7 Highspeed",
    description: "MiniMax flagship at 100 tps. 204K context, thinking support.",
    modelString: "MiniMax-M2.7-highspeed",
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: true,
    },
    context: {
      maxTokens: 204800,
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
      triggerAt: 155000,
      targetSize: 100000,
      protectRecent: 20000,
    },
    status: "active",
  },
  {
    modelId: "minimax-m2.5",
    provider: "minimax",
    name: "MiniMax M2.5",
    description: "MiniMax M2.5 with 204K context. 60 tps.",
    modelString: "MiniMax-M2.5",
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: false,
    },
    context: {
      maxTokens: 204800,
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
      triggerAt: 155000,
      targetSize: 100000,
      protectRecent: 20000,
    },
    status: "active",
  },
  {
    modelId: "minimax-m2.5-highspeed",
    provider: "minimax",
    name: "MiniMax M2.5 Highspeed",
    description: "MiniMax M2.5 at 100 tps. 204K context.",
    modelString: "MiniMax-M2.5-highspeed",
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: false,
    },
    context: {
      maxTokens: 204800,
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
      triggerAt: 155000,
      targetSize: 100000,
      protectRecent: 20000,
    },
    status: "active",
  },
  {
    modelId: "minimax-m2.1",
    provider: "minimax",
    name: "MiniMax M2.1",
    description: "MiniMax M2.1 with 204K context. 60 tps.",
    modelString: "MiniMax-M2.1",
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: false,
    },
    context: {
      maxTokens: 204800,
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
      triggerAt: 155000,
      targetSize: 100000,
      protectRecent: 20000,
    },
    status: "active",
  },
  {
    modelId: "minimax-m2.1-highspeed",
    provider: "minimax",
    name: "MiniMax M2.1 Highspeed",
    description: "MiniMax M2.1 at 100 tps. 204K context.",
    modelString: "MiniMax-M2.1-highspeed",
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: false,
    },
    context: {
      maxTokens: 204800,
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
      triggerAt: 155000,
      targetSize: 100000,
      protectRecent: 20000,
    },
    status: "active",
  },
  {
    modelId: "minimax-m2",
    provider: "minimax",
    name: "MiniMax M2",
    description: "MiniMax M2 base model with 204K context.",
    modelString: "MiniMax-M2",
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: false,
    },
    context: {
      maxTokens: 204800,
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
      triggerAt: 155000,
      targetSize: 100000,
      protectRecent: 20000,
    },
    status: "active",
  },
]
