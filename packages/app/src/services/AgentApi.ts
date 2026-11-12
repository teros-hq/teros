/**
 * AgentApi — Typed client for the agent domain
 *
 * Replaces the raw legacy patterns in TerosClient for all agent-related
 * operations. Uses the WsFramework request/response protocol via WsTransport.
 */

import type { Transport } from './transport/types'

// ============================================================================
// Shared types
// ============================================================================

export interface AgentData {
  agentId: string
  name: string
  fullName: string
  role: string
  intro: string
  context?: string
  maxSteps?: number
  avatarUrl?: string
  coreId?: string
  workspaceId?: string
  selectedProviderId?: string | null
  selectedModelId?: string | null
  /** System-capability toggles (v1.4.4) — mcaIds the agent has explicitly
   * disabled (default-ON caps) / enabled (default-OFF power caps). */
  disabledSystemApps?: string[]
  enabledSystemApps?: string[]
}

export interface AgentCoreData {
  coreId: string
  coreType?: 'agent' | 'super-agent'
  name: string
  fullName: string
  version: string
  systemPrompt: string
  personality: string[]
  capabilities: string[]
  defaultApps?: string[]
  avatarUrl: string
  modelId: string
  modelOverrides?: { temperature?: number; maxTokens?: number }
  status: 'active' | 'inactive'
}

export interface GeneratedProfile {
  name: string
  fullName: string
  role: string
  intro: string
  responseStyle: string
}

export interface AgentAppData {
  appId: string
  name: string
  mcaId: string
  description: string
  icon?: string
  hasAccess: boolean
  grantedAt: string
}

export interface ProviderData {
  providerId: string
  providerType: string
  displayName: string
  status: string
  models: any[]
}

export interface AgentProvidersData {
  agentId: string
  selectedProviderId: string | null
  selectedModelId: string | null
  providers: ProviderData[]
}

// ============================================================================
// AgentApi
// ============================================================================

export class AgentApi {
  constructor(private readonly transport: Transport) {}

  /** List agent instances for the current user, or for a workspace */
  listAgents(workspaceId?: string): Promise<{ workspaceId?: string; agents: AgentData[] }> {
    return this.transport.request('agent.list', workspaceId ? { workspaceId } : {})
  }

  /** Create a new agent instance. The core is assigned server-side by scope. */
  createAgent(data: {
    name: string
    fullName: string
    role: string
    intro: string
    avatarUrl?: string
    workspaceId?: string
    context?: string
  }): Promise<{ agent: AgentData }> {
    return this.transport.request('agent.create', data as Record<string, unknown>)
  }

  /** Update an existing agent instance */
  updateAgent(data: {
    agentId: string
    name?: string
    fullName?: string
    role?: string
    intro?: string
    avatarUrl?: string
    maxSteps?: number
    context?: string
    selectedProviderId?: string | null
    selectedModelId?: string | null
    appearance?: { color?: string; icon?: string }
    /** System-capability toggles (v1.4.4) — full-list PUT semantics. */
    disabledSystemApps?: string[]
    enabledSystemApps?: string[]
  }): Promise<{ agent: AgentData }> {
    return this.transport.request('agent.update', data as Record<string, unknown>)
  }

  /** Delete an agent instance */
  deleteAgent(agentId: string): Promise<{ agentId: string }> {
    return this.transport.request('agent.delete', { agentId })
  }

  /** Generate a unique agent profile via LLM. Core is resolved server-side by scope. */
  generateProfile(
    excludeNames: string[] = [],
    workspaceId?: string,
  ): Promise<{ profile: GeneratedProfile }> {
    return this.transport.request(
      'agent.generate-profile',
      { workspaceId, excludeNames },
      { timeout: 30_000 },
    )
  }

  /** List available agent cores (engines) */
  listCores(status?: 'active' | 'inactive'): Promise<{ cores: AgentCoreData[] }> {
    return this.transport.request('agent.list-cores', status ? { status } : {})
  }

  /** Create a new agent core (engine). Created active by default. */
  createCore(data: {
    coreId: string
    coreType: 'agent' | 'super-agent'
    name: string
    fullName: string
    version?: string
    systemPrompt: string
    personality?: string[]
    capabilities?: string[]
    defaultApps?: string[]
    avatarUrl?: string
    modelId: string
    modelOverrides?: { temperature?: number; maxTokens?: number }
    status?: 'active' | 'inactive'
  }): Promise<{ core: AgentCoreData }> {
    return this.transport.request('agent.create-core', data as Record<string, unknown>)
  }

  /** Update an agent core configuration (coreId/coreType are immutable) */
  updateCore(
    coreId: string,
    updates: {
      name?: string
      fullName?: string
      version?: string
      modelId?: string
      systemPrompt?: string
      personality?: string[]
      capabilities?: string[]
      defaultApps?: string[]
      modelOverrides?: { temperature?: number; maxTokens?: number }
      status?: 'active' | 'inactive'
    },
  ): Promise<{ core: AgentCoreData }> {
    return this.transport.request('agent.update-core', { coreId, updates })
  }

  /** Get apps an agent has access to */
  getApps(agentId: string, workspaceId?: string): Promise<{ agentId: string; apps: AgentAppData[] }> {
    return this.transport.request('agent.get-apps', { agentId, workspaceId })
  }

  /** List providers available for an agent */
  listProviders(agentId: string): Promise<AgentProvidersData> {
    return this.transport.request('agent.list-providers', { agentId })
  }

  /**
   * Pin an agent to an exact model (selectedProviderId + selectedModelId).
   * Pass providerId: null to clear the pin (System Default = the user's
   * default provider + its defaultModelId).
   */
  setModel(
    agentId: string,
    providerId: string | null,
    modelId?: string | null,
  ): Promise<{ agentId: string; selectedProviderId: string | null; selectedModelId: string | null }> {
    return this.transport.request('agent.set-model', { agentId, providerId, modelId: modelId ?? null })
  }
}
