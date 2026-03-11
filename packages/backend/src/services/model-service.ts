/**
 * Model Service
 *
 * Resolves LLM configuration by joining:
 * - Model catalog (base config)
 * - Agent core overrides (temperature, maxTokens, etc.)
 *
 * Provides the effective configuration to use when creating LLM clients.
 */

import type { Db } from 'mongodb';
import type {
  AgentCore,
  AgentInstance,
  Model,
  ResolvedAgentCore,
  Workspace,
} from '../types/database';

export interface EffectiveLLMConfig {
  /** Model ID (unique identifier in our DB) */
  modelId: string;
  /**
   * Provider type:
   * - 'anthropic': Uses API key
   * - 'anthropic-oauth': Uses OAuth (Claude Max)
   * - 'openai': OpenAI API
   * - 'openrouter': OpenRouter unified API (400+ models)
   * - 'google': Google AI (Gemini)
   * - 'groq': Groq API
   * - 'zhipu': Z.ai / ZhipuAI (GLM models)
   * - 'zhipu-coding': Z.ai coding API (GLM models optimized for coding)
   * - 'ollama': Local Ollama models
   * - 'openai-codex-oauth': Uses OAuth (ChatGPT Pro/Plus subscription via Codex)
   */
  provider:
    | 'anthropic'
    | 'anthropic-oauth'
    | 'openai'
    | 'openai-codex-oauth'
    | 'openrouter'
    | 'google'
    | 'groq'
    | 'zhipu'
    | 'zhipu-coding'
    | 'ollama';
  modelString: string;
  temperature: number;
  maxTokens: number;
  capabilities: Model['capabilities'];
  context: Model['context'];
  /** Auto-compaction settings */
  compaction: Model['compaction'];
  /** Maximum conversation steps before termination (default: 20) */
  maxSteps?: number;
  /** Provider-specific configuration (e.g., OpenRouter routingStrategy) */
  providerConfig?: Record<string, any>;
}

/**
 * Complete agent configuration including LLM config and system prompt
 */
export interface EffectiveAgentConfig {
  /** LLM configuration */
  llm: EffectiveLLMConfig;
  /** Combined system prompt (core + agent customization) */
  systemPrompt: string;
  /** Agent metadata */
  agent: {
    agentId: string;
    name: string;
    fullName: string;
    role: string;
    maxSteps?: number; // Agent-specific max steps override
  };
}

export class ModelService {
  private modelsCollection;
  private coresCollection;
  private workspacesCollection;

  constructor(private db: Db) {
    this.modelsCollection = db.collection<Model>('models');
    this.coresCollection = db.collection<AgentCore>('agent_cores');
    this.workspacesCollection = db.collection<Workspace>('workspaces');
  }

  /**
   * Get all available models
   */
  async listModels(status?: Model['status']): Promise<Model[]> {
    const filter = status ? { status } : {};
    return this.modelsCollection.find(filter).toArray();
  }

  /**
   * Get a model by ID
   */
  async getModel(modelId: string): Promise<Model | null> {
    return this.modelsCollection.findOne({ modelId });
  }

  /**
   * Get all agent cores
   */
  async listAgentCores(status?: AgentCore['status']): Promise<AgentCore[]> {
    const filter = status ? { status } : {};
    return this.coresCollection.find(filter).toArray();
  }

  /**
   * Get an agent core by ID
   */
  async getAgentCore(coreId: string): Promise<AgentCore | null> {
    return this.coresCollection.findOne({ coreId });
  }

  /**
   * Get resolved agent core with model data
   */
  async getResolvedAgentCore(coreId: string): Promise<ResolvedAgentCore | null> {
    const core = await this.getAgentCore(coreId);
    if (!core) return null;

    const model = await this.getModel(core.modelId);
    if (!model) {
      console.error(`[ModelService] Model ${core.modelId} not found for core ${coreId}`);
      return null;
    }

    // Calculate effective config (model defaults + core overrides)
    const effectiveConfig = {
      temperature: core.modelOverrides?.temperature ?? model.defaults.temperature,
      maxTokens: core.modelOverrides?.maxTokens ?? model.defaults.maxTokens,
    };

    // Remove modelId and add resolved data
    const { modelId, ...coreWithoutModelId } = core;

    return {
      ...coreWithoutModelId,
      model,
      effectiveConfig,
    };
  }

  /**
   * Get effective LLM configuration for an agent core
   *
   * This is the main method used by MessageHandler to get
   * the configuration needed to create an LLM client.
   */
  async getEffectiveLLMConfig(coreId: string): Promise<EffectiveLLMConfig | null> {
    const resolved = await this.getResolvedAgentCore(coreId);
    if (!resolved) return null;

    return {
      modelId: resolved.model.modelId,
      provider: resolved.model.provider,
      modelString: resolved.model.modelString,
      temperature: resolved.effectiveConfig.temperature,
      maxTokens: resolved.effectiveConfig.maxTokens,
      capabilities: resolved.model.capabilities,
      context: resolved.model.context,
      compaction: resolved.model.compaction,
    };
  }

  /**
   * Get effective LLM config for an agent instance
   * (resolves agent -> core -> model)
   */
  async getEffectiveLLMConfigForAgent(agentId: string): Promise<EffectiveLLMConfig | null> {
    // Get agent instance
    const agentsCollection = this.db.collection<AgentInstance>('agents');
    const agent = await agentsCollection.findOne({ agentId });
    if (!agent) {
      console.error(`[ModelService] Agent ${agentId} not found`);
      return null;
    }

    // Resolve through core
    return this.getEffectiveLLMConfig(agent.coreId);
  }

  /**
   * Get complete agent configuration including system prompt
   *
   * This is the main method for getting everything needed to process a message:
   * - LLM config (provider, model, temperature, etc.)
   * - System prompt (core systemPrompt + agent customizations)
   */
  async getEffectiveAgentConfig(agentId: string): Promise<EffectiveAgentConfig | null> {
    // Get agent instance
    const agentsCollection = this.db.collection<AgentInstance>('agents');
    const agent = await agentsCollection.findOne({ agentId });
    if (!agent) {
      console.error(`[ModelService] Agent ${agentId} not found`);
      return null;
    }

    // Get resolved core (includes model)
    const resolvedCore = await this.getResolvedAgentCore(agent.coreId);
    if (!resolvedCore) {
      return null;
    }

    // Build LLM config
    // Handle maxSteps: 0 = unlimited, undefined/null = use default (20)
    const agentMaxSteps = agent.maxSteps === 0 ? undefined : agent.maxSteps;

    const llmConfig: EffectiveLLMConfig = {
      modelId: resolvedCore.model.modelId,
      provider: resolvedCore.model.provider,
      modelString: resolvedCore.model.modelString,
      temperature: resolvedCore.effectiveConfig.temperature,
      maxTokens: resolvedCore.effectiveConfig.maxTokens,
      capabilities: resolvedCore.model.capabilities,
      context: resolvedCore.model.context,
      compaction: resolvedCore.model.compaction,
      maxSteps: agentMaxSteps,
      providerConfig: resolvedCore.model.providerConfig,
    };

    // Get workspace context if agent belongs to a workspace
    let workspaceContext: string | undefined;
    if (agent.workspaceId) {
      const workspace = await this.workspacesCollection.findOne({ workspaceId: agent.workspaceId });
      workspaceContext = workspace?.context || undefined;
    }

    // Build system prompt: core prompt + workspace context + agent customizations
    const systemPrompt = this.buildSystemPrompt(resolvedCore, agent, workspaceContext);

    return {
      llm: llmConfig,
      systemPrompt,
      agent: {
        agentId: agent.agentId,
        name: agent.name,
        fullName: agent.fullName,
        role: agent.role,
        maxSteps: agent.maxSteps,
      },
    };
  }

  /**
   * Build the complete system prompt from core + workspace context + agent customization
   */
  private buildSystemPrompt(
    core: ResolvedAgentCore,
    agent: AgentInstance,
    workspaceContext?: string,
  ): string {
    let prompt = core.systemPrompt;

    // Add agent identity (first, right after core prompt)
    prompt += `\n\n## Your Identity\n\n`;
    prompt += `You are ${agent.fullName}, a ${agent.role}.`;

    // Add agent-specific context
    if (agent.context) {
      prompt += `\n\n## Context\n\n`;
      prompt += agent.context;
    }

    // Add workspace context if available
    if (workspaceContext) {
      prompt += `\n\n## Workspace Context\n\n`;
      prompt += workspaceContext;
    }

    return prompt;
  }

  /**
   * Validate that a model exists and is active
   */
  async validateModel(modelId: string): Promise<boolean> {
    const model = await this.getModel(modelId);
    return model !== null && model.status === 'active';
  }

  /**
   * Get models by provider
   */
  async getModelsByProvider(
    provider:
      | 'anthropic'
      | 'anthropic-oauth'
      | 'openai'
      | 'openai-codex-oauth'
      | 'openrouter'
      | 'google'
      | 'groq'
      | 'zhipu'
      | 'zhipu-coding',
  ): Promise<Model[]> {
    return this.modelsCollection.find({ provider, status: 'active' }).toArray();
  }

  /**
   * Update an agent core
   */
  async updateAgentCore(
    coreId: string,
    updates: {
      modelId?: string;
      systemPrompt?: string;
      modelOverrides?: {
        temperature?: number;
        maxTokens?: number;
      };
      status?: 'active' | 'inactive';
    },
  ): Promise<AgentCore | null> {
    // Validate modelId if provided
    if (updates.modelId) {
      const model = await this.getModel(updates.modelId);
      if (!model) {
        throw new Error(`Model ${updates.modelId} not found`);
      }
    }

    // Build update document
    const updateDoc: Record<string, any> = {
      updatedAt: new Date(),
    };

    if (updates.modelId !== undefined) {
      updateDoc.modelId = updates.modelId;
    }
    if (updates.systemPrompt !== undefined) {
      updateDoc.systemPrompt = updates.systemPrompt;
    }
    if (updates.status !== undefined) {
      updateDoc.status = updates.status;
    }
    if (updates.modelOverrides !== undefined) {
      // Merge with existing overrides or set new ones
      updateDoc.modelOverrides = updates.modelOverrides;
    }

    const result = await this.coresCollection.findOneAndUpdate(
      { coreId },
      { $set: updateDoc },
      { returnDocument: 'after' },
    );

    return result;
  }
}
