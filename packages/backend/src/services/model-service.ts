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
import { SkillService, interpolateSkill } from './skill-service';
import { escapePromptBlockAttr, neutralizePromptTags } from './prompt-safety';
import { ProjectService } from './project-service';
import { McaService } from './mca-service';

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
    | 'ollama'
    | 'ollama-cloud'
    | 'openai-compatible'
    | 'minimax'
    | 'teros'
    | 'cloudflare'
    | 'fireworks'
    | 'together';
  modelString: string;
  temperature: number;
  /**
   * Effective output token budget for this request, already reconciled
   * against the nominal model. Built as `core.modelOverrides.maxTokens
   * ?? nominalModel.defaults.maxTokens`. When a runtime provider is
   * resolved upstream (see message-handler), this value is re-reconciled
   * against the runtime model's capability ceiling.
   */
  maxTokens: number;
  /**
   * The explicit user preference from `AgentCore.modelOverrides.maxTokens`,
   * if the operator set one — `undefined` when the core relies on the
   * nominal model's default. Keeping this separate from `maxTokens` lets
   * downstream callers (e.g., the runtime-provider reconciliation in
   * message-handler) distinguish "user explicitly asked for N" from
   * "nominal model happens to default to N", which matters when the
   * runtime model differs in family from the nominal one (Claude 8192
   * default does not apply when the same core runs over Qwen/Ollama).
   */
  maxTokensUserOverride?: number;
  capabilities: Model['capabilities'];
  context: Model['context'];
  /** Auto-compaction settings */
  compaction: Model['compaction'];
  /** Maximum conversation steps before termination (default: 20) */
  maxSteps?: number;
  /**
   * Cache block size for the mod-N breakpoint strategy.
   * When set, the cache breakpoint snaps to multiples of this value,
   * keeping it stable within each block and improving cache hit rate.
   * 0 = disabled (legacy moving breakpoint). Default (undefined) = 20.
   */
  cacheBlockSize?: number;
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

/**
 * Shape of a runtime-discovered provider model, as returned by
 * `ProviderService.resolveProviderForAgent`. Kept as a structural type here
 * to avoid a cross-file dependency between model-service and provider-service
 * (both are consumed by message-handler).
 */
export interface RuntimeProviderModel {
  modelId: string;
  modelString: string;
  capabilities: Model['capabilities'];
  context?: { maxTokens: number; maxOutputTokens: number };
}

/**
 * Reconcile an EffectiveLLMConfig (built from the *nominal* core model) with
 * the metadata of the *runtime* model actually serving the request. Returns
 * a new config; the input is not mutated.
 *
 * Called after `ProviderService.resolveProviderForAgent` resolves a runtime
 * provider + model for an agent. When the runtime model differs in family
 * from the nominal one (e.g. core "iria" → Claude Sonnet nominally, but Rai
 * has Tower/Qwopus over openai-compatible as its active provider), the
 * nominal model's capabilities/context/maxTokens are stale constraints from
 * a different model and would poison the LLM client if propagated as-is.
 *
 * Reconciliation rules:
 *   • `capabilities` and `context` are replaced by the runtime model's
 *     values when available — they describe what the runtime can do, not
 *     what the nominal model happened to advertise.
 *   • `maxTokens` is recomputed as MIN(preference, capability) where
 *     preference = explicit `AgentCore.modelOverrides.maxTokens` (captured
 *     in `maxTokensUserOverride`) and capability = runtime
 *     `context.maxOutputTokens`. When the operator expressed no preference,
 *     capability wins — the nominal model's default is not a valid cap on
 *     a different model's budget.
 *   • `providerConfig` is merged with any provider-level config (baseUrl,
 *     customHeaders, routingStrategy, etc.).
 *   • Compaction policy is intentionally *not* touched — it is a policy
 *     decision the operator made for this core, independent of which
 *     provider serves the request.
 *
 * Applies universally across every provider. When `runtime.context` is
 * absent (rare; some provider types synthesize lightweight models without
 * a full context window), capability propagation is skipped and the nominal
 * values are preserved.
 */
export function reconcileWithRuntimeModel(
  nominalConfig: EffectiveLLMConfig,
  runtime: { model: RuntimeProviderModel; providerType: EffectiveLLMConfig['provider']; providerConfig?: Record<string, any> },
): EffectiveLLMConfig {
  const reconciled: EffectiveLLMConfig = {
    ...nominalConfig,
    provider: runtime.providerType,
    modelString: runtime.model.modelString,
    modelId: runtime.model.modelId,
    capabilities: runtime.model.capabilities,
  };

  if (runtime.model.context) {
    reconciled.context = runtime.model.context;
    const capability = runtime.model.context.maxOutputTokens;
    const preference = nominalConfig.maxTokensUserOverride;
    reconciled.maxTokens =
      preference !== undefined ? Math.min(preference, capability) : capability;
  }

  if (runtime.providerConfig) {
    reconciled.providerConfig = {
      ...nominalConfig.providerConfig,
      ...runtime.providerConfig,
    };
  }

  return reconciled;
}

export class ModelService {
  private modelsCollection;
  private coresCollection;
  private workspacesCollection;
  private skillService: SkillService;
  private projectService: ProjectService;
  private mcaService: McaService;

  constructor(private db: Db) {
    this.modelsCollection = db.collection<Model>('models');
    this.coresCollection = db.collection<AgentCore>('agent_cores');
    this.workspacesCollection = db.collection<Workspace>('workspaces');
    this.skillService = new SkillService(db);
    this.projectService = new ProjectService(db);
    this.mcaService = new McaService(db);
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
      maxTokensUserOverride: resolved.modelOverrides?.maxTokens,
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
  async getEffectiveAgentConfig(
    agentId: string,
    channelId?: string,
    contextData?: {
      userName?: string;
      workspaceName?: string;
      workspaceId?: string;
      parentChannelId?: string;
    },
  ): Promise<EffectiveAgentConfig | null> {
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
      maxTokensUserOverride: resolvedCore.modelOverrides?.maxTokens,
      capabilities: resolvedCore.model.capabilities,
      context: resolvedCore.model.context,
      compaction: resolvedCore.model.compaction,
      maxSteps: agentMaxSteps,
      // cacheBlockSize: per-agent feature flag for mod-N cache strategy
      // undefined = use ConversationManager default (20)
      // 0 = disable mod-N (legacy moving breakpoint)
      cacheBlockSize: agent.cacheBlockSize,
      providerConfig: resolvedCore.model.providerConfig,
    };

    // Get workspace context — for regular agents use their own workspace; for superagents
    // (workspaceId = null) fall back to the channel's workspace passed via contextData.
    let workspaceContext: string | undefined;
    let workspaceName: string | undefined;
    const effectiveWorkspaceIdForContext = agent.workspaceId ?? contextData?.workspaceId ?? null;
    if (effectiveWorkspaceIdForContext) {
      const workspace = await this.workspacesCollection.findOne({ workspaceId: effectiveWorkspaceIdForContext });
      workspaceContext = workspace?.context || undefined;
      workspaceName = workspace?.name || undefined;
    }

    // Get project context if the channel is linked to a project
    let projectContext: string | undefined;
    let projectName: string | undefined;
    if (channelId) {
      const channel = await this.db.collection('channels').findOne(
        { channelId },
        { projection: { projectId: 1 } },
      );
      if (channel?.projectId) {
        const project = await this.projectService.get(channel.projectId);
        if (project?.context) {
          projectContext = project.context;
          projectName = project.name;
        }
      }
    }

    // Build system prompt: core prompt + agent context + skills + workspace context + project context + <context> block
    const systemPrompt = await this.buildSystemPrompt(
      resolvedCore,
      agent,
      workspaceContext,
      workspaceName,
      projectContext,
      projectName,
      channelId,
      contextData,
    );

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
   * Build the complete system prompt from core + agent context + skills + workspace context
   */
  private async buildSystemPrompt(
    core: ResolvedAgentCore,
    agent: AgentInstance,
    workspaceContext?: string,
    workspaceName?: string,
    projectContext?: string,
    projectName?: string,
    channelId?: string,
    contextData?: {
      userName?: string;
      workspaceName?: string;
      workspaceId?: string;
      parentChannelId?: string;
    },
  ): Promise<string> {
    let prompt = core.systemPrompt;

    // Add agent identity (first, right after core prompt)
    prompt += `\n\n## Your Identity\n\n`;
    prompt += `You are ${agent.fullName}, a ${agent.role}.`;

    // Add agent-specific context
    if (agent.context) {
      prompt += `\n\n## Context\n\n`;
      prompt += agent.context;
    }

    // Inject active agent skills scoped to the current workspace.
    // Skills belong to a workspace, so only skills from the active workspace
    // are injected — this ensures superagents get the right skills per workspace.
    const effectiveWorkspaceId = contextData?.workspaceId ?? agent.workspaceId;
    const skills = await this.skillService.getAgentSkills(agent.agentId, effectiveWorkspaceId ?? undefined);
    if (skills.length > 0) {
      const interpolationContext = {
        agent: {
          name: agent.name,
          fullName: agent.fullName,
          role: agent.role,
          intro: agent.intro,
          email: agent.email,
        },
        workspace: workspaceName ? { name: workspaceName } : undefined,
      };

      for (const skill of skills) {
        const interpolated = interpolateSkill(skill.content, interpolationContext);
        // Escape collaborative content so it can't break out of its <skill>
        // block or forge a fake one (TER-379).
        prompt += `\n\n<skill name="${escapePromptBlockAttr(skill.name)}">\n${neutralizePromptTags(interpolated)}\n</skill>`;
      }
    }

    // Add workspace context if available
    if (workspaceContext) {
      prompt += `\n\n## Workspace Context\n\n`;
      // No <tag> wrapper here, but the content is still workspace-editable —
      // escape it so it can't forge a <skill>/<project> block (TER-379).
      prompt += neutralizePromptTags(workspaceContext);
    }

    // Add project context if available (after workspace context)
    if (projectContext) {
      prompt += `\n\n<project name="${escapePromptBlockAttr(projectName ?? '')}">\n${neutralizePromptTags(projectContext)}\n</project>`;
    }

    // Inject per-app instructions (App.context) for the agent's active apps in
    // the current workspace. App.context is otherwise inert — this block is the
    // only place it reaches the model. Apps without a context contribute
    // nothing, so an app with no instructions never bloats the prompt. Wrapped
    // so an apps lookup failure degrades to "no app instructions" rather than
    // breaking the whole system prompt (this runs for every agent).
    try {
      const { apps: agentApps } = await this.mcaService.getAgentApps(
        agent.agentId,
        effectiveWorkspaceId ?? undefined,
      );
      for (const { app } of agentApps) {
        const appContext = (app.context ?? '').trim();
        if (!appContext) continue;
        const appName = app.name || app.mca?.name || 'App';
        const mcaId = app.mca?.mcaId ?? '';
        prompt += `\n\n<app_instructions app="${appName}"${mcaId ? ` mca="${mcaId}"` : ''}>\n${appContext}\n</app_instructions>`;
      }
    } catch (err) {
      console.error('[ModelService] Failed to inject app instructions:', err);
    }

    // Add <context> block at the very end (not cacheable — evaluated per request)
    {
      const resolvedWorkspaceName = contextData?.workspaceName ?? workspaceName;
      const resolvedWorkspaceId = contextData?.workspaceId ?? agent.workspaceId;
      let contextBlock = `\n\n<context>`;
      // The agent's own id, so self-referential platform tools work
      // (grant-app-access, list-agent-apps, skill-grant-access, …).
      contextBlock += `\nAgent id: ${agent.agentId}`;
      if (channelId) {
        contextBlock += `\nChannel: ${channelId}`;
      }
      contextBlock += `\nCurrent time: ${new Date().toISOString()}`;
      // User/workspace/project NAMES are user-editable → escape so they can't
      // break out of <context> or forge a block (TER-379). IDs/time are
      // system-generated (safe charset) and left as-is.
      if (contextData?.userName) {
        contextBlock += `\nUser: ${neutralizePromptTags(contextData.userName)}`;
      }
      if (resolvedWorkspaceName && resolvedWorkspaceId) {
        contextBlock += `\nWorkspace: ${neutralizePromptTags(resolvedWorkspaceName)} (${resolvedWorkspaceId})`;
      } else if (resolvedWorkspaceName) {
        contextBlock += `\nWorkspace: ${neutralizePromptTags(resolvedWorkspaceName)}`;
      }
      if (contextData?.parentChannelId) {
        contextBlock += `\nParent channel: ${contextData.parentChannelId}`;
      }
      if (projectName) {
        contextBlock += `\nProject: ${neutralizePromptTags(projectName)}`;
      }
      contextBlock += `\n</context>`;
      prompt += contextBlock;
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
      name?: string;
      fullName?: string;
      version?: string;
      modelId?: string;
      systemPrompt?: string;
      personality?: string[];
      capabilities?: string[];
      defaultApps?: string[];
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

    // Build update document. coreId and coreType are immutable (identity) — never
    // accepted here. Every other core field the UI shows is editable.
    const updateDoc: Record<string, any> = {
      updatedAt: new Date(),
    };

    for (const field of [
      'name',
      'fullName',
      'version',
      'modelId',
      'systemPrompt',
      'personality',
      'capabilities',
      'defaultApps',
      'status',
      'modelOverrides',
    ] as const) {
      if (updates[field] !== undefined) {
        updateDoc[field] = updates[field];
      }
    }

    const result = await this.coresCollection.findOneAndUpdate(
      { coreId },
      { $set: updateDoc },
      { returnDocument: 'after' },
    );

    return result;
  }

  /**
   * Create a new agent core. Used to author experimental cores for rollout
   * (TER-412). Created `active` by default: it is safe for an experimental core
   * to be active because agent creation always resolves to the CANONICAL core
   * (coreId === coreType) regardless of how many active cores share the coreType
   * (see createAgentFromCore). New agents never enter an experiment by birth —
   * only via the explicit apply-rollout action.
   */
  async createAgentCore(input: {
    coreId: string;
    coreType: 'agent' | 'super-agent';
    name: string;
    fullName: string;
    version?: string;
    systemPrompt: string;
    personality?: string[];
    capabilities?: string[];
    defaultApps?: string[];
    avatarUrl?: string;
    modelId: string;
    modelOverrides?: { temperature?: number; maxTokens?: number };
    status?: 'active' | 'inactive';
  }): Promise<AgentCore> {
    if (!input.coreId || !input.coreId.trim()) {
      throw new Error('coreId is required');
    }
    if (input.coreType !== 'agent' && input.coreType !== 'super-agent') {
      throw new Error(`Invalid coreType '${input.coreType}' (must be 'agent' or 'super-agent')`);
    }
    const model = await this.getModel(input.modelId);
    if (!model) {
      throw new Error(`Model ${input.modelId} not found`);
    }

    const now = new Date().toISOString();
    const core: AgentCore = {
      coreId: input.coreId,
      coreType: input.coreType,
      name: input.name,
      fullName: input.fullName,
      version: input.version ?? 'v1.0',
      systemPrompt: input.systemPrompt,
      personality: input.personality ?? [],
      capabilities: input.capabilities ?? [],
      defaultApps: input.defaultApps ?? [],
      avatarUrl: input.avatarUrl ?? 'iria-avatar.jpg',
      modelId: input.modelId,
      modelOverrides: input.modelOverrides,
      status: input.status ?? 'active',
      createdAt: now,
      updatedAt: now,
    };

    // Atomic insert-if-absent: $setOnInsert + upsert is a single atomic op, so two
    // concurrent create-core calls for the same coreId can't both succeed (no
    // check-then-insert race, and no unique index needed on agent_cores).
    const res = await this.coresCollection.updateOne(
      { coreId: input.coreId },
      { $setOnInsert: core },
      { upsert: true },
    );
    if (!res.upsertedId) {
      throw new Error(`Agent core '${input.coreId}' already exists`);
    }
    return core;
  }
}
