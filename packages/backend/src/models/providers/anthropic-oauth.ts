import type { ModelDefinition } from "../types"

/**
 * anthropic-oauth model definitions
 */
export const MODELS_ANTHROPIC_OAUTH: ModelDefinition[] = [
  // ============================================================================
  // ANTHROPIC OAUTH (Claude Max subscription)
  // Sonnet and Opus only
  // ============================================================================
  {
    modelId: "claude-sonnet-4-5-oauth",
    provider: "anthropic-oauth",
    name: "Claude Sonnet 4.5 (OAuth)",
    description: "Claude Sonnet via Claude Max subscription.",
    modelString: "claude-sonnet-4-5-20250929",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 200000,
      maxOutputTokens: 64000,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 8192,
    },
    reservations: {
      systemPrompt: 4000,
      memory: 8000,
      output: 8192,
    },
    compaction: {
      triggerAt: 150000,
      targetSize: 100000,
      protectRecent: 20000,
    },
    status: "active",
  },
  {
    modelId: "claude-opus-4-5-oauth",
    provider: "anthropic-oauth",
    name: "Claude Opus 4.5 (OAuth)",
    description: "Claude Opus via Claude Max subscription.",
    modelString: "claude-opus-4-5-20251101",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 200000,
      maxOutputTokens: 64000,
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
      triggerAt: 150000,
      targetSize: 100000,
      protectRecent: 30000,
    },
    status: "active",
  },
  {
    modelId: "claude-sonnet-4-6-oauth",
    provider: "anthropic-oauth",
    name: "Claude Sonnet 4.6 (OAuth)",
    description:
      "Claude Sonnet 4.6 via Claude Max subscription. Frontier performance with 1M context window.",
    modelString: "claude-sonnet-4-6",
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
      systemPrompt: 4000,
      memory: 8000,
      output: 8192,
    },
    compaction: {
      triggerAt: 900000,
      targetSize: 600000,
      protectRecent: 20000,
    },
    status: "active",
  },
  {
    modelId: "claude-opus-4-6-oauth",
    provider: "anthropic-oauth",
    name: "Claude Opus 4.6 (OAuth)",
    description:
      "Claude Opus 4.6 via Claude Max subscription. State-of-the-art reasoning with 1M context, 128K output tokens.",
    modelString: "claude-opus-4-6",
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
      maxTokens: 16384,
    },
    reservations: {
      systemPrompt: 6000,
      memory: 12000,
      output: 16384,
    },
    compaction: {
      // 850k leaves 150k headroom > maxOutputTokens (128000): a turn at the
      // trigger plus a full-length output stays under the 1M context cap.
      triggerAt: 850000,
      targetSize: 600000,
      protectRecent: 30000,
    },
    status: "active",
  },
  {
    modelId: "claude-opus-4-7-oauth",
    provider: "anthropic-oauth",
    name: "Claude Opus 4.7 (OAuth)",
    description:
      "Claude Opus 4.7 via Claude Max subscription. Stronger Opus tier with 1M context, 128K output tokens.",
    modelString: "claude-opus-4-7",
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
      protectRecent: 30000,
    },
    status: "active",
  },
  {
    modelId: "claude-opus-4-8-oauth",
    provider: "anthropic-oauth",
    name: "Claude Opus 4.8 (OAuth)",
    description:
      "Claude Opus 4.8 via Claude Max subscription. Top Opus model for deep reasoning and long-horizon agents. 1M context.",
    modelString: "claude-opus-4-8",
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
      protectRecent: 30000,
    },
    status: "active",
  },
  {
    modelId: "claude-fable-5-oauth",
    provider: "anthropic-oauth",
    name: "Claude Fable 5 (OAuth)",
    description:
      "Claude Fable 5 via Claude Max subscription. Mythos-class model for autonomous knowledge work. 1M context.",
    modelString: "claude-fable-5",
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
      maxTokens: 16384,
    },
    reservations: {
      systemPrompt: 6000,
      memory: 12000,
      output: 16384,
    },
    compaction: {
      // 850k leaves 150k headroom > maxOutputTokens (128000): a turn at the
      // trigger plus a full-length output stays under the 1M context cap.
      triggerAt: 850000,
      targetSize: 600000,
      protectRecent: 30000,
    },
    status: "active",
  },
  {
    modelId: "claude-sonnet-5-oauth",
    provider: "anthropic-oauth",
    name: "Claude Sonnet 5 (OAuth)",
    description:
      "Claude Sonnet 5 via Claude Max subscription. Latest Sonnet generation for everyday agent work. 1M context.",
    modelString: "claude-sonnet-5",
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
      systemPrompt: 4000,
      memory: 8000,
      output: 8192,
    },
    compaction: {
      triggerAt: 850000,
      targetSize: 600000,
      protectRecent: 20000,
    },
    status: "active",
  },
]
