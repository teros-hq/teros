import type { ModelDefinition } from '../types';

/**
 * openrouter model definitions
 */
export const MODELS_OPENROUTER: ModelDefinition[] = [
  // ============================================================================
  // OPENROUTER (Unified API for 400+ models)
  // https://openrouter.ai/models
  // ============================================================================
  {
    modelId: 'deepseek-v3',
    provider: 'openrouter',
    name: 'DeepSeek V3',
    description: 'Excellent for coding and reasoning. 90% cheaper than Claude Sonnet.',
    modelString: 'deepseek/deepseek-chat',
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: false,
    },
    context: {
      maxTokens: 64000,
      maxOutputTokens: 8192,
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
      triggerAt: 50000,
      targetSize: 30000,
      protectRecent: 10000,
    },
    status: 'active',
  },
  {
    modelId: 'llama-3.3-70b',
    provider: 'openrouter',
    name: 'Llama 3.3 70B',
    description: "Meta's Llama 3.3 70B. Free or very economical for simple tasks.",
    modelString: 'meta-llama/llama-3.3-70b-instruct',
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
    status: 'active',
  },
  {
    modelId: 'qwen-2.5-coder-32b',
    provider: 'openrouter',
    name: 'Qwen 2.5 Coder 32B',
    description: 'Specialized coding model from Alibaba. Excellent for code generation.',
    modelString: 'qwen/qwen-2.5-coder-32b-instruct',
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: false,
    },
    context: {
      maxTokens: 32768,
      maxOutputTokens: 8192,
    },
    defaults: {
      temperature: 0.7,
      maxTokens: 8192,
    },
    reservations: {
      systemPrompt: 3000,
      memory: 6000,
      output: 8192,
    },
    compaction: {
      triggerAt: 25000,
      targetSize: 15000,
      protectRecent: 5000,
    },
    status: 'active',
  },
  {
    modelId: 'openrouter-auto-cheapest',
    provider: 'openrouter',
    name: 'OpenRouter Auto (Cheapest)',
    description:
      'Automatic model selection optimized for cost. Routes to the cheapest capable model.',
    modelString: 'openrouter/auto',
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
      protectRecent: 10000,
    },
    providerConfig: {
      routingStrategy: 'cheapest',
    },
    status: 'active',
  },
  {
    modelId: 'openrouter-auto-best',
    provider: 'openrouter',
    name: 'OpenRouter Auto (Best)',
    description:
      'Automatic model selection optimized for quality. Routes to the best model for the task.',
    modelString: 'openrouter/auto',
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      thinking: false,
    },
    context: {
      maxTokens: 200000,
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
      triggerAt: 150000,
      targetSize: 100000,
      protectRecent: 20000,
    },
    providerConfig: {
      routingStrategy: 'best',
    },
    status: 'active',
  },
];
