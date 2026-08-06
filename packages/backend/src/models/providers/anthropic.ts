import type { ModelDefinition } from "../types"

/**
 * anthropic model definitions
 */
export const MODELS_ANTHROPIC: ModelDefinition[] = [
  // ============================================================================
  // ANTHROPIC (API Key) - Claude 4.5 models
  // https://docs.anthropic.com/en/docs/about-claude/models
  // ============================================================================
  {
    modelId: "claude-haiku-4-5",
    provider: "anthropic",
    name: "Claude Haiku 4.5",
    description: "Fastest model with near-frontier intelligence. Best for simple tasks.",
    modelString: "claude-haiku-4-5-20251001",
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
      maxTokens: 4096,
    },
    reservations: {
      systemPrompt: 4000,
      memory: 8000,
      output: 4096,
    },
    compaction: {
      triggerAt: 150000,
      targetSize: 100000,
      protectRecent: 20000,
    },
    status: "active",
  },
  {
    modelId: "claude-sonnet-4-5",
    provider: "anthropic",
    name: "Claude Sonnet 4.5",
    description: "Best balance of intelligence and speed. Excellent for coding and agents.",
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
    modelId: "claude-sonnet-4-6",
    provider: "anthropic",
    name: "Claude Sonnet 4.6",
    description:
      "Sonnet 4.6 with frontier performance in coding, agents, and professional work. 1M context window.",
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
    modelId: "claude-opus-4-5",
    provider: "anthropic",
    name: "Claude Opus 4.5",
    description: "Premium model combining maximum intelligence with practical performance.",
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
    modelId: "claude-opus-4-6",
    provider: "anthropic",
    name: "Claude Opus 4.6",
    description:
      "Opus 4.6 with state-of-the-art reasoning, coding, and agentic workflows. 1M context, 128K output tokens.",
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
    modelId: "claude-opus-4-7",
    provider: "anthropic",
    name: "Claude Opus 4.7",
    description:
      "Stronger Opus tier for advanced software work and high-stakes reasoning. 1M context, 128K output tokens.",
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
    modelId: "claude-opus-4-8",
    provider: "anthropic",
    name: "Claude Opus 4.8",
    description:
      "Top Opus model for deep reasoning, coding, and long-horizon agents. 1M context, 128K output tokens.",
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
    modelId: "claude-sonnet-5",
    provider: "anthropic",
    name: "Claude Sonnet 5",
    description:
      "Latest Sonnet generation. Everyday agent model for coding, planning, and general work. 1M context, cheaper than Sonnet 4.6.",
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
  {
    modelId: "claude-fable-5",
    provider: "anthropic",
    name: "Claude Fable 5",
    description:
      "Mythos-class model above Opus for autonomous knowledge work and controlled agent workflows. 1M context, 128K output tokens.",
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
      triggerAt: 850000,
      targetSize: 600000,
      protectRecent: 30000,
    },
    status: "active",
  },
]
