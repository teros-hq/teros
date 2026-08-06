import type { ModelDefinition } from "../types"

/**
 * zhipu model definitions
 */
export const MODELS_ZHIPU: ModelDefinition[] = [
  // ============================================================================
  // ZHIPU (Z.ai / ZhipuAI - GLM models)
  // https://docs.z.ai/
  // ============================================================================
  {
    modelId: "glm-5.2",
    provider: "zhipu",
    name: "GLM 5.2",
    description:
      "Z.ai's newest flagship model (June 2026). 1M context, thinking mode (2 effort levels), agentic workflows up to 8+ hours.",
    modelString: "glm-5.2",
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
      // 850k leaves 150k headroom > maxOutputTokens (131072): a turn at the
      // trigger plus a full-length output stays under the 1M context cap.
      triggerAt: 850000,
      targetSize: 600000,
      protectRecent: 20000,
    },
    status: "active",
  },
  {
    modelId: "glm-5.1",
    provider: "zhipu",
    name: "GLM 5.1",
    description:
      "Z.ai's previous flagship (April 2026). 200K context, thinking mode, agentic workflows up to 8+ hours.",
    modelString: "glm-5.1",
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: true,
    },
    context: {
      maxTokens: 200000,
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
      triggerAt: 150000,
      targetSize: 100000,
      protectRecent: 20000,
    },
    status: "active",
  },
  {
    modelId: "glm-5",
    provider: "zhipu",
    name: "GLM 5",
    description:
      "Z.ai's GLM-5 model. 200K context with thinking mode. Excellent for complex agentic tasks.",
    modelString: "glm-5",
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: true,
    },
    context: {
      maxTokens: 200000,
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
      triggerAt: 150000,
      targetSize: 100000,
      protectRecent: 20000,
    },
    status: "active",
  },
  {
    modelId: "glm-5-turbo",
    provider: "zhipu",
    name: "GLM 5 Turbo",
    description:
      "Fast and efficient GLM-5 variant. Optimized for real-world agent workflows with long execution chains.",
    modelString: "glm-5-turbo",
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: false,
    },
    context: {
      maxTokens: 200000,
      maxOutputTokens: 8192,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 4096,
    },
    reservations: {
      systemPrompt: 6000,
      memory: 12000,
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
    modelId: "glm-5v-turbo",
    provider: "zhipu",
    name: "GLM 5V Turbo",
    description:
      "Z.ai's fast vision model. Screenshots, documents, and multimodal agent tasks with thinking mode.",
    modelString: "glm-5v-turbo",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      thinking: true,
    },
    context: {
      maxTokens: 200000,
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
      triggerAt: 150000,
      targetSize: 100000,
      protectRecent: 20000,
    },
    status: "active",
  },
  {
    modelId: "glm-4.7-flashx",
    provider: "zhipu",
    name: "GLM 4.7 FlashX",
    description: "Ultra-fast GLM-4.7 variant. Lowest latency, ideal for high-throughput use cases.",
    modelString: "glm-4.7-flashx",
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: false,
    },
    context: {
      maxTokens: 200000,
      maxOutputTokens: 8192,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 4096,
    },
    reservations: {
      systemPrompt: 6000,
      memory: 12000,
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
    modelId: "glm-4.7-flash",
    provider: "zhipu",
    name: "GLM 4.7 Flash",
    description:
      "Lightweight 30B variant of GLM-4.7. Good balance of speed and quality for everyday tasks.",
    modelString: "glm-4.7-flash",
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: false,
    },
    context: {
      maxTokens: 200000,
      maxOutputTokens: 8192,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 4096,
    },
    reservations: {
      systemPrompt: 6000,
      memory: 12000,
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
    modelId: "glm-4.7",
    provider: "zhipu",
    name: "GLM 4.7",
    description: "GLM-4.7 with 200K context. Strong for coding, reasoning, and agentic workflows.",
    modelString: "glm-4.7",
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: true,
    },
    context: {
      maxTokens: 200000,
      maxOutputTokens: 8192,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 4096,
    },
    reservations: {
      systemPrompt: 6000,
      memory: 12000,
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
    modelId: "glm-4.6",
    provider: "zhipu",
    name: "GLM 4.6",
    description:
      "Z.ai's previous flagship model with excellent reasoning and tool use capabilities.",
    modelString: "glm-4.6",
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
      systemPrompt: 4000,
      memory: 8000,
      output: 4096,
    },
    compaction: {
      triggerAt: 100000,
      targetSize: 80000,
      protectRecent: 15000,
    },
    status: "active",
  },
  {
    modelId: "glm-4.6v",
    provider: "zhipu",
    name: "GLM 4.6V",
    description: "Z.ai's vision-enabled model with multimodal capabilities.",
    modelString: "glm-4.6v",
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
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
      systemPrompt: 4000,
      memory: 8000,
      output: 4096,
    },
    compaction: {
      triggerAt: 100000,
      targetSize: 80000,
      protectRecent: 15000,
    },
    status: "active",
  },
  {
    modelId: "glm-4",
    provider: "zhipu",
    name: "GLM 4",
    description: "Z.ai's previous generation model. Still very capable.",
    modelString: "glm-4",
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
      systemPrompt: 4000,
      memory: 8000,
      output: 4096,
    },
    compaction: {
      triggerAt: 100000,
      targetSize: 80000,
      protectRecent: 15000,
    },
    status: "disabled", // Enable if needed
  },
]
