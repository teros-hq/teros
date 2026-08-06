import type { ModelDefinition } from "../types"

/**
 * openrouter-extra model definitions
 */
export const MODELS_OPENROUTER_EXTRA: ModelDefinition[] = [
  {
    modelId: "openrouter-claude-sonnet-4-5",
    provider: "openrouter",
    name: "Claude Sonnet 4.5 (OpenRouter)",
    description: "Anthropic Claude Sonnet 4.5 via OpenRouter. Excellent for coding and agents.",
    modelString: "anthropic/claude-sonnet-4.5",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 1000000,
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
      triggerAt: 900000,
      targetSize: 600000,
      protectRecent: 20000,
    },
    status: "active",
  },
  {
    modelId: "openrouter-claude-sonnet-4-6",
    provider: "openrouter",
    name: "Claude Sonnet 4.6 (OpenRouter)",
    description: "Latest Sonnet with frontier performance. 1M context window. Same price as 4.5.",
    modelString: "anthropic/claude-sonnet-4.6",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 1000000,
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
      triggerAt: 900000,
      targetSize: 600000,
      protectRecent: 20000,
    },
    status: "active",
  },
  {
    modelId: "openrouter-claude-opus-4-5",
    provider: "openrouter",
    name: "Claude Opus 4.5 (OpenRouter)",
    description: "Anthropic Claude Opus 4.5 via OpenRouter. Most capable model for complex tasks.",
    modelString: "anthropic/claude-opus-4.5",
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
    modelId: "openrouter-claude-opus-4-6",
    provider: "openrouter",
    name: "Claude Opus 4.6 (OpenRouter)",
    description:
      "Anthropic Claude Opus 4.6 via OpenRouter. State-of-the-art reasoning and coding with 128K output.",
    modelString: "anthropic/claude-opus-4.6",
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
    modelId: "gpt-4o-openrouter",
    provider: "openrouter",
    name: "GPT-4o (OpenRouter)",
    description: "OpenAI GPT-4o via OpenRouter. Multimodal with vision capabilities.",
    modelString: "openai/gpt-4o",
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
      maxTokens: 8192,
    },
    reservations: {
      systemPrompt: 4000,
      memory: 8000,
      output: 8192,
    },
    compaction: {
      triggerAt: 100000,
      targetSize: 60000,
      protectRecent: 15000,
    },
    status: "active",
  },
  {
    modelId: "kimi-k2.5",
    provider: "openrouter",
    name: "Kimi K2.5",
    description:
      "Moonshot AI's flagship multimodal agentic model. 256K context, MoE architecture with thinking mode.",
    modelString: "moonshotai/kimi-k2.5",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 256000,
      maxOutputTokens: 16384,
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
      triggerAt: 200000,
      targetSize: 150000,
      protectRecent: 25000,
    },
    status: "active",
  },
  {
    modelId: "openrouter-claude-opus-4-7",
    provider: "openrouter",
    name: "Claude Opus 4.7 (OpenRouter)",
    description:
      "Anthropic Claude Opus 4.7 via OpenRouter. Stronger Opus tier with strong reasoning. 1M context.",
    modelString: "anthropic/claude-opus-4.7",
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
    modelId: "openrouter-claude-opus-4-8",
    provider: "openrouter",
    name: "Claude Opus 4.8 (OpenRouter)",
    description:
      "Anthropic Claude Opus 4.8 via OpenRouter. Top Opus model for deep reasoning and long-horizon agents. 1M context.",
    modelString: "anthropic/claude-opus-4.8",
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
    modelId: "openrouter-claude-fable-5",
    provider: "openrouter",
    name: "Claude Fable 5 (OpenRouter)",
    description:
      "Anthropic Claude Fable 5 via OpenRouter. Mythos-class model for autonomous knowledge work. 1M context, $10/$50 per 1M tokens.",
    modelString: "anthropic/claude-fable-5",
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
    modelId: "openrouter-claude-sonnet-5",
    provider: "openrouter",
    name: "Claude Sonnet 5 (OpenRouter)",
    description:
      "Anthropic Claude Sonnet 5 via OpenRouter. Latest Sonnet generation for everyday agent work. 1M context, cheaper than Sonnet 4.6.",
    modelString: "anthropic/claude-sonnet-5",
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
    modelId: "openrouter-gpt-5-5",
    provider: "openrouter",
    name: "GPT-5.5 (OpenRouter)",
    description:
      "OpenAI GPT-5.5 via OpenRouter. Frontier GPT for coding, computer use, research, and knowledge work. 1M context.",
    modelString: "openai/gpt-5.5",
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
    modelId: "openrouter-qwen-3-7-max",
    provider: "openrouter",
    name: "Qwen 3.7 Max (OpenRouter)",
    description:
      "Alibaba Qwen 3.7 Max via OpenRouter. Best price/performance in top-10. Released May 21, 2026.",
    modelString: "qwen/qwen3.7-max",
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
      protectRecent: 25000,
    },
    status: "active",
  },
  {
    modelId: "openrouter-deepseek-v4-pro",
    provider: "openrouter",
    name: "DeepSeek V4 Pro (OpenRouter)",
    description:
      "DeepSeek V4 Pro via OpenRouter. Open-weights frontier model, competitive with proprietary leaders at much lower cost.",
    modelString: "deepseek/deepseek-v4-pro",
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
      systemPrompt: 4000,
      memory: 8000,
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
    modelId: "openrouter-glm-5-2",
    provider: "openrouter",
    name: "GLM 5.2 (OpenRouter)",
    description:
      "Z.ai's GLM-5.2 flagship via OpenRouter. 1M context, thinking mode, agentic workflows at low cost.",
    modelString: "z-ai/glm-5.2",
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
      systemPrompt: 4000,
      memory: 8000,
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
    modelId: "openrouter-kimi-k2-7-code",
    provider: "openrouter",
    name: "Kimi K2.7 Code (OpenRouter)",
    description:
      "Moonshot AI's coding-focused agentic model via OpenRouter. 262K context, vision, thinking mode.",
    modelString: "moonshotai/kimi-k2.7-code",
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
      systemPrompt: 4000,
      memory: 8000,
      output: 8192,
    },
    compaction: {
      triggerAt: 200000,
      targetSize: 150000,
      protectRecent: 25000,
    },
    status: "active",
  },
  {
    modelId: "openrouter-minimax-m3",
    provider: "openrouter",
    name: "MiniMax M3 (OpenRouter)",
    description:
      "MiniMax M3 via OpenRouter. Multimodal (image + video input), 524K context, thinking mode, very low cost.",
    modelString: "minimax/minimax-m3",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 524288,
      maxOutputTokens: 131072,
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
      triggerAt: 380000,
      targetSize: 250000,
      protectRecent: 25000,
    },
    status: "active",
  },
  {
    modelId: "openrouter-gemini-3-5-flash",
    provider: "openrouter",
    name: "Gemini 3.5 Flash (OpenRouter)",
    description:
      "Google Gemini 3.5 Flash via OpenRouter. Top-10 global, extremely cheap with strong reasoning.",
    modelString: "google/gemini-3.5-flash",
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
      temperature: 0.7,
      maxTokens: 16384,
    },
    reservations: {
      systemPrompt: 6000,
      memory: 12000,
      output: 16384,
    },
    compaction: {
      triggerAt: 900000,
      targetSize: 600000,
      protectRecent: 30000,
    },
    status: "active",
  },
]
