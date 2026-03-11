/**
 * IModelService Interface
 *
 * Interface for model and agent core configuration service.
 */

import type { AgentCore, Model, ResolvedAgentCore } from '../../types/database';
import type { EffectiveAgentConfig, EffectiveLLMConfig } from '../model-service';

/**
 * Provider types supported by the system
 */
export type LLMProvider =
  | 'anthropic'
  | 'anthropic-oauth'
  | 'openai'
  | 'google'
  | 'groq'
  | 'zhipu'
  | 'zhipu-coding';

/**
 * Interface for Model Service
 */
export interface IModelService {
  // ============================================================================
  // MODEL OPERATIONS
  // ============================================================================

  /**
   * List all available models
   */
  listModels(status?: Model['status']): Promise<Model[]>;

  /**
   * Get model by ID
   */
  getModel(modelId: string): Promise<Model | null>;

  /**
   * Get models by provider
   */
  getModelsByProvider(provider: LLMProvider): Promise<Model[]>;

  /**
   * Validate that a model exists and is active
   */
  validateModel(modelId: string): Promise<boolean>;

  // ============================================================================
  // AGENT CORE OPERATIONS
  // ============================================================================

  /**
   * List all agent cores
   */
  listAgentCores(status?: AgentCore['status']): Promise<AgentCore[]>;

  /**
   * Get agent core by ID
   */
  getAgentCore(coreId: string): Promise<AgentCore | null>;

  /**
   * Get resolved agent core (with model data)
   */
  getResolvedAgentCore(coreId: string): Promise<ResolvedAgentCore | null>;

  /**
   * Update an agent core
   */
  updateAgentCore(
    coreId: string,
    updates: Partial<
      Pick<
        AgentCore,
        | 'name'
        | 'fullName'
        | 'systemPrompt'
        | 'personality'
        | 'capabilities'
        | 'modelId'
        | 'modelOverrides'
        | 'status'
      >
    >,
  ): Promise<AgentCore | null>;

  // ============================================================================
  // EFFECTIVE CONFIGURATION
  // ============================================================================

  /**
   * Get effective LLM config for a core
   */
  getEffectiveLLMConfig(coreId: string): Promise<EffectiveLLMConfig | null>;

  /**
   * Get effective LLM config for an agent
   */
  getEffectiveLLMConfigForAgent(agentId: string): Promise<EffectiveLLMConfig | null>;

  /**
   * Get complete effective agent config (LLM + system prompt)
   */
  getEffectiveAgentConfig(agentId: string): Promise<EffectiveAgentConfig | null>;
}
