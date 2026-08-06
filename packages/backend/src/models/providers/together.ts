import type { ModelDefinition } from "../types"

/**
 * Together AI model definitions
 *
 * Together AI — OpenAI-compatible API for 200+ open-source models.
 * Base URL: https://api.together.ai/v1
 * https://docs.together.ai/
 */
export const MODELS_TOGETHER: ModelDefinition[] = [
  // ============================================================================
  // TOGETHER AI (OpenAI-compatible API)
  // ============================================================================
  {
    modelId: "together-kimi-k2.6",
    provider: "together",
    name: "Kimi K2.6 (Together)",
    description:
      "Moonshot AI Kimi K2.6 via Together AI. 262K context, reasoning, function calling, and vision support.",
    modelString: "moonshotai/kimi-k2.6",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 262144,
      maxOutputTokens: 8192,
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
    cost: {
      input: 1.2,
      output: 4.5,
      cacheRead: 0.2,
    },
    status: "active",
  },
  {
    modelId: "together-deepseek-v4-pro",
    provider: "together",
    name: "DeepSeek V4 Pro (Together)",
    description:
      "DeepSeek V4 Pro via Together AI. 512K context, excellent for coding and reasoning.",
    modelString: "deepseek-ai/DeepSeek-V4-Pro",
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: true,
    },
    context: {
      maxTokens: 512000,
      maxOutputTokens: 8192,
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
      triggerAt: 400000,
      targetSize: 250000,
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
    modelId: "together-glm-5.2",
    provider: "together",
    name: "GLM 5.2 (Together)",
    description:
      "Zhipu AI GLM-5.2 via Together AI. 262K context, reasoning, function calling, and agentic workflows.",
    modelString: "zai-org/GLM-5.2",
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: true,
    },
    context: {
      maxTokens: 262144,
      maxOutputTokens: 8192,
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
    cost: {
      input: 1.4,
      output: 4.4,
      cacheRead: 0.26,
    },
    status: "active",
  },
  {
    modelId: "together-kimi-k2.7-code",
    provider: "together",
    name: "Kimi K2.7 Code (Together)",
    description:
      "Moonshot AI Kimi K2.7 Code via Together AI. 262K context, coding-specialized with agentic reasoning.",
    modelString: "moonshotai/Kimi-K2.7-Code",
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: true,
    },
    context: {
      maxTokens: 262144,
      maxOutputTokens: 8192,
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
    cost: {
      input: 0.95,
      output: 4.0,
      cacheRead: 0.19,
    },
    status: "active",
  },
  {
    modelId: "together-minimax-m3",
    provider: "together",
    name: "MiniMax M3 (Together)",
    description:
      "MiniMax M3 via Together AI. 524K context, multimodal (image input), reasoning at very low cost.",
    modelString: "MiniMaxAI/MiniMax-M3",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 524288,
      maxOutputTokens: 8192,
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
      triggerAt: 400000,
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
  // NOTE: Qwen 3.7 Max deliberadamente excluido — es propietario (Alibaba) y exige
  // activar "third-party data sharing" en la org de Together: los prompts saldrían
  // hacia Alibaba bajo sus términos, rompiendo la privacidad por defecto del catálogo.
  {
    modelId: "together-qwen-3.5-397b",
    provider: "together",
    name: "Qwen 3.5 397B (Together)",
    description:
      "Qwen 3.5 397B A17B via Together AI. 262K context, MoE architecture, cost-efficient.",
    modelString: "Qwen/Qwen3.5-397B-A17B",
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: true,
    },
    context: {
      maxTokens: 262144,
      maxOutputTokens: 8192,
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
    cost: {
      input: 0.6,
      output: 3.6,
    },
    status: "active",
  },
  {
    modelId: "together-llama-3.3-70b",
    provider: "together",
    name: "Llama 3.3 70B (Together)",
    description:
      "Meta Llama 3.3 70B Instruct via Together AI. 128K context, reliable general-purpose model.",
    modelString: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: false,
    },
    context: {
      maxTokens: 128000,
      maxOutputTokens: 8192,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 4096,
    },
    reservations: {
      systemPrompt: 3000,
      memory: 6000,
      output: 4096,
    },
    compaction: {
      triggerAt: 100000,
      targetSize: 60000,
      protectRecent: 10000,
    },
    cost: {
      input: 1.04,
      output: 1.04,
    },
    status: "active",
  },
  {
    modelId: "together-gpt-oss-120b",
    provider: "together",
    name: "GPT-OSS 120B (Together)",
    description: "OpenAI GPT-OSS 120B via Together AI. 131K context, fully open weights.",
    modelString: "openai/gpt-oss-120b",
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: false,
    },
    context: {
      maxTokens: 131072,
      maxOutputTokens: 8192,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 4096,
    },
    reservations: {
      systemPrompt: 3000,
      memory: 6000,
      output: 4096,
    },
    compaction: {
      triggerAt: 100000,
      targetSize: 60000,
      protectRecent: 10000,
    },
    cost: {
      input: 0.15,
      output: 0.6,
    },
    status: "active",
  },
  {
    modelId: "together-gemma-4-31b",
    provider: "together",
    name: "Gemma 4 31B (Together)",
    description: "Google Gemma 4 31B via Together AI. 262K context, lightweight and efficient.",
    modelString: "google/gemma-4-31B-it",
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: false,
    },
    context: {
      maxTokens: 262144,
      maxOutputTokens: 8192,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 4096,
    },
    reservations: {
      systemPrompt: 3000,
      memory: 6000,
      output: 4096,
    },
    compaction: {
      triggerAt: 200000,
      targetSize: 130000,
      protectRecent: 10000,
    },
    cost: {
      input: 0.39,
      output: 0.97,
    },
    status: "active",
  },
]
