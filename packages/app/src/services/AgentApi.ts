/**
 * AgentApi — Typed client for the agent domain
 *
 * Replaces the raw legacy patterns in TerosClient for all agent-related
 * operations. Uses the WsFramework request/response protocol via WsTransport.
 */

import type { WsTransport } from './WsTransport'

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
  availableProviders?: string[]
  selectedProviderId?: string | null
  selectedModelId?: string | null
}

export interface AgentCoreData {
  coreId: string
  name: string
  fullName: string
  version: string
  systemPrompt: string
  personality: string[]
  capabilities: string[]
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
  availableProviders: string[]
  preferredProviderId: string | null
  providers: ProviderData[]
}

// ============================================================================
// AgentApi
// ============================================================================

export class AgentApi {
  constructor(private readonly transport: WsTransport) {}

  /** List agent instances for the current user, or for a workspace */
  listAgents(workspaceId?: string): Promise<{ workspaceId?: string; agents: AgentData[] }> {
    return this.transport.request('agent.list', workspaceId ? { workspaceId } : {})
  }

  /** Create a new agent instance */
  createAgent(data: {
    coreId: string
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
    availableProviders?: string[]
    selectedProviderId?: string | null
    selectedModelId?: string | null
  }): Promise<{ agent: AgentData }> {
    return this.transport.request('agent.update', data as Record<string, unknown>)
  }

  /** Delete an agent instance */
  deleteAgent(agentId: string): Promise<{ agentId: string }> {
    return this.transport.request('agent.delete', { agentId })
  }

  /** Generate a unique agent profile via LLM */
  generateProfile(
    coreId: string,
    excludeNames: string[] = [],
  ): Promise<{ profile: GeneratedProfile }> {
    return this.transport.request('agent.generate-profile', { coreId, excludeNames }, 30_000)
  }

  /** List available agent cores (engines) */
  listCores(status?: 'active' | 'inactive'): Promise<{ cores: AgentCoreData[] }> {
    return this.transport.request('agent.list-cores', status ? { status } : {})
  }

  /** Update an agent core configuration */
  updateCore(
    coreId: string,
    updates: {
      modelId?: string
      systemPrompt?: string
      modelOverrides?: { temperature?: number; maxTokens?: number }
      status?: 'active' | 'inactive'
    },
  ): Promise<{ core: AgentCoreData }> {
    return this.transport.request('agent.update-core', { coreId, updates })
  }

  /** Get apps an agent has access to */
  getApps(agentId: string): Promise<{ agentId: string; apps: AgentAppData[] }> {
    return this.transport.request('agent.get-apps', { agentId })
  }

  /** List providers available for an agent */
  listProviders(agentId: string): Promise<AgentProvidersData> {
    return this.transport.request('agent.list-providers', { agentId })
  }

  /** Set availableProviders for an agent */
  setProviders(
    agentId: string,
    availableProviders: string[],
  ): Promise<{ agentId: string; availableProviders: string[] }> {
    return this.transport.request('agent.set-providers', { agentId, availableProviders })
  }

  /** Set preferredProviderId for an agent (null to clear) */
  setPreferredProvider(
    agentId: string,
    providerId: string | null,
  ): Promise<{ agentId: string; preferredProviderId: string | null }> {
    return this.transport.request('agent.set-preferred-provider', { agentId, providerId })
  }
}
