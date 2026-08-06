import type { ModelDefinition } from "../types"

/**
 * Ollama Cloud model definitions
 *
 * Ollama Cloud is a hosted inference service by the Ollama team.
 * API: https://ollama.com/v1 (OpenAI-compatible)
 * Auth: API key from ollama.com → Settings → API Keys
 * Pricing: Subscription-based (Free / Pro $20/mo / Max $100/mo)
 *
 * Models use the `-cloud` suffix to distinguish them from local models.
 * See: https://ollama.com/search?c=cloud
 */
export const MODELS_OLLAMA_CLOUD: ModelDefinition[] = [
  // ============================================================================
  // OLLAMA CLOUD - Hosted large models
  // Requires API key from https://ollama.com/settings/api-keys
  // ============================================================================
  {
    modelId: "ollama-cloud-glm-5.2",
    provider: "ollama-cloud",
    name: "GLM 5.2 (Cloud)",
    description:
      "Zhipu AI GLM-5.2 hosted by Ollama Cloud. 976K context, thinking mode, strong for agentic workflows.",
    modelString: "glm-5.2:cloud",
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: true,
    },
    context: {
      maxTokens: 976000,
      maxOutputTokens: 32768,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 16384,
    },
    reservations: {
      systemPrompt: 4000,
      memory: 8000,
      output: 16384,
    },
    compaction: {
      triggerAt: 800000,
      targetSize: 500000,
      protectRecent: 20000,
    },
    status: "active",
  },
  {
    modelId: "ollama-cloud-kimi-k2.7-code",
    provider: "ollama-cloud",
    name: "Kimi K2.7 Code (Cloud)",
    description:
      "Moonshot AI Kimi K2.7 Code hosted by Ollama Cloud. 262K context, coding-specialized, vision and thinking.",
    modelString: "kimi-k2.7-code:cloud",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 262144,
      maxOutputTokens: 32768,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 16384,
    },
    reservations: {
      systemPrompt: 4000,
      memory: 8000,
      output: 16384,
    },
    compaction: {
      triggerAt: 200000,
      targetSize: 120000,
      protectRecent: 20000,
    },
    status: "active",
  },
  {
    modelId: "ollama-cloud-minimax-m3",
    provider: "ollama-cloud",
    name: "MiniMax M3 (Cloud)",
    description:
      "MiniMax M3 hosted by Ollama Cloud. 512K context, multimodal (image + video input), thinking mode.",
    modelString: "minimax-m3:cloud",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 512000,
      maxOutputTokens: 32768,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 16384,
    },
    reservations: {
      systemPrompt: 4000,
      memory: 8000,
      output: 16384,
    },
    compaction: {
      triggerAt: 400000,
      targetSize: 250000,
      protectRecent: 20000,
    },
    status: "active",
  },
  {
    modelId: "ollama-cloud-deepseek-v4-pro",
    provider: "ollama-cloud",
    name: "DeepSeek V4 Pro (Cloud)",
    description:
      "DeepSeek V4 Pro hosted by Ollama Cloud. 1M context, open-weights frontier model for coding and reasoning.",
    modelString: "deepseek-v4-pro:cloud",
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: true,
    },
    context: {
      maxTokens: 1048576,
      maxOutputTokens: 32768,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 16384,
    },
    reservations: {
      systemPrompt: 4000,
      memory: 8000,
      output: 16384,
    },
    compaction: {
      triggerAt: 800000,
      targetSize: 500000,
      protectRecent: 20000,
    },
    status: "active",
  },
  {
    modelId: "ollama-cloud-qwen3-coder-480b",
    provider: "ollama-cloud",
    name: "Qwen3 Coder 480B (Cloud)",
    description:
      "Massive coding model hosted by Ollama Cloud. 480B parameters, 131K context. Best for complex code generation and analysis.",
    modelString: "qwen3-coder:480b-cloud",
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: false,
    },
    context: {
      maxTokens: 131072,
      maxOutputTokens: 32768,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 16384,
    },
    reservations: {
      systemPrompt: 4000,
      memory: 8000,
      output: 16384,
    },
    compaction: {
      triggerAt: 100000,
      targetSize: 60000,
      protectRecent: 16000,
    },
    status: "active",
  },
  {
    modelId: "ollama-cloud-deepseek-v3-1-671b",
    provider: "ollama-cloud",
    name: "DeepSeek V3.1 671B (Cloud)",
    description:
      "State-of-the-art general-purpose model. 671B parameters, 262K context. Excellent for reasoning and complex tasks.",
    modelString: "deepseek-v3.1:671b-cloud",
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: false,
    },
    context: {
      maxTokens: 262144,
      maxOutputTokens: 32768,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 16384,
    },
    reservations: {
      systemPrompt: 4000,
      memory: 8000,
      output: 16384,
    },
    compaction: {
      triggerAt: 200000,
      targetSize: 120000,
      protectRecent: 20000,
    },
    status: "active",
  },
  {
    modelId: "ollama-cloud-gpt-oss-120b",
    provider: "ollama-cloud",
    name: "GPT-OSS 120B (Cloud)",
    description:
      "General-purpose OSS model hosted by Ollama Cloud. 120B parameters, 131K context. Good balance of quality and speed.",
    modelString: "gpt-oss:120b-cloud",
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: false,
    },
    context: {
      maxTokens: 131072,
      maxOutputTokens: 32768,
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
      protectRecent: 12000,
    },
    status: "active",
  },
  {
    modelId: "ollama-cloud-gpt-oss-20b",
    provider: "ollama-cloud",
    name: "GPT-OSS 20B (Cloud)",
    description:
      "Faster general-purpose OSS model. 20B parameters, 131K context. Lower latency for simpler tasks.",
    modelString: "gpt-oss:20b-cloud",
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: false,
    },
    context: {
      maxTokens: 131072,
      maxOutputTokens: 16384,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 8192,
    },
    reservations: {
      systemPrompt: 4000,
      memory: 6000,
      output: 8192,
    },
    compaction: {
      triggerAt: 100000,
      targetSize: 60000,
      protectRecent: 10000,
    },
    status: "active",
  },
  {
    modelId: "ollama-cloud-devstral-2-123b",
    provider: "ollama-cloud",
    name: "Devstral 2 123B (Cloud)",
    description:
      "Development-focused model by Mistral hosted on Ollama Cloud. 123B parameters, 131K context. Optimized for software engineering.",
    modelString: "devstral-2:123b-cloud",
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: false,
    },
    context: {
      maxTokens: 131072,
      maxOutputTokens: 32768,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 16384,
    },
    reservations: {
      systemPrompt: 4000,
      memory: 8000,
      output: 16384,
    },
    compaction: {
      triggerAt: 100000,
      targetSize: 60000,
      protectRecent: 16000,
    },
    status: "active",
  },
]
