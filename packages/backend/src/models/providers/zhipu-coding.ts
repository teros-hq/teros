import type { ModelDefinition } from "../types"

/**
 * zhipu-coding model definitions
 */
export const MODELS_ZHIPU_CODING: ModelDefinition[] = [
  {
    modelId: "glm-5.2-coding",
    provider: "zhipu-coding",
    name: "GLM 5.2 Coding",
    description:
      "Z.ai's newest flagship via the coding API (June 2026). 1M context, thinking mode (2 effort levels), agentic coding up to 8+ hours.",
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
    modelId: "glm-5.1-coding",
    provider: "zhipu-coding",
    name: "GLM 5.1 Coding",
    description:
      "Z.ai's previous flagship via the coding API. 200K context, thinking mode, agentic coding up to 8+ hours.",
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
    modelId: "glm-5-coding",
    provider: "zhipu-coding",
    name: "GLM 5 Coding",
    description: "GLM-5 via the coding API endpoint. Thinking mode, 200K context.",
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
    modelId: "glm-5-turbo-coding",
    provider: "zhipu-coding",
    name: "GLM 5 Turbo Coding",
    description: "Fast GLM-5 via the coding API. Optimized for long agent execution chains.",
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
    modelId: "glm-5v-turbo-coding",
    provider: "zhipu-coding",
    name: "GLM 5V Turbo Coding",
    description:
      "Z.ai's fast vision model via the coding API. Screenshots, documents, and multimodal agent tasks.",
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
    modelId: "glm-4.7-flashx-coding",
    provider: "zhipu-coding",
    name: "GLM 4.7 FlashX Coding",
    description:
      "Ultra-fast GLM-4.7 via the coding API. Lowest latency for high-throughput coding tasks.",
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
    modelId: "glm-4.7-flash-coding",
    provider: "zhipu-coding",
    name: "GLM 4.7 Flash Coding",
    description: "Lightweight 30B GLM-4.7 via the coding API. Good balance of speed and quality.",
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
    modelId: "glm-4.7-coding",
    provider: "zhipu-coding",
    name: "GLM 4.7 Coding",
    description:
      "GLM-4.7 coding-optimized via the coding API endpoint. 200K context, optimized for real-world development.",
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
    modelId: "glm-4.6-coding",
    provider: "zhipu-coding",
    name: "GLM 4.6 Coding",
    description: "Z.ai's previous coding-optimized model via the coding API endpoint.",
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
]
