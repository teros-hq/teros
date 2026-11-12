/**
 * agent.list-providers — List the agent's provider/model configuration
 *
 * 2-level model (2026-10-21): the agent has a pin (selectedProviderId +
 * selectedModelId) or inherits the user's default provider (System Default).
 * The availableProviders list is GONE — the response lists ALL of the owner's
 * active providers so a selector can offer every option, plus the resolved
 * (provider, model) pair a run would actually use.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import { isProviderTypeAllowedInEdition } from '@teros/shared'
import type { Db } from 'mongodb'
import { canAccessAgent } from '../../../auth/workspace-access'
import type { UserProviderRecord } from '../../../services/provider-service'

interface ListProvidersData {
  agentId: string
}

export function createListProvidersHandler(db: Db) {
  return async function listProviders(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as ListProvidersData
    const { agentId } = data

    if (!agentId) {
      throw new HandlerError('MISSING_AGENT_ID', 'agentId is required')
    }
    if (!(await canAccessAgent(db, ctx.userId, agentId))) {
      throw new HandlerError('FORBIDDEN', 'No access to this agent')
    }

    const agent = await db.collection('agents').findOne({ agentId })
    if (!agent) {
      throw new HandlerError('AGENT_NOT_FOUND', 'Agent not found')
    }

    const selectedProviderId: string | null = agent.selectedProviderId ?? null
    const selectedModelId: string | null = agent.selectedModelId ?? null

    // ALL of the owner's providers — the selector shows every option; the
    // availableProviders filter no longer exists. Edition gate (TER-EDITION):
    // local-Ollama providers are excluded from the OFFERED list in cloud (they
    // cannot be used or re-picked there); an already-pinned one is still listed
    // below so the UI can show the stale pin instead of hiding the problem.
    const records = (
      await db
        .collection<UserProviderRecord>('user_providers')
        .find({ userId: agent.ownerId })
        .toArray()
    ).filter(
      (p) =>
        isProviderTypeAllowedInEdition(p.providerType) ||
        p.providerId === selectedProviderId,
    )

    const providers = records.map((p) => ({
      providerId: p.providerId,
      providerType: p.providerType,
      displayName: p.displayName,
      status: p.status,
      isDefault: p.isDefault ?? false,
      defaultModelId: p.defaultModelId ?? null,
      models: p.models,
    }))

    // Resolved pair — mirrors the runtime resolver (provider-service):
    // pin → user default. Pure read, no secrets, no billing throws.
    let resolved: { providerId: string | null; modelId: string | null; source: string }
    const pinned = selectedProviderId
      ? providers.find((p) => p.providerId === selectedProviderId && p.status === 'active')
      : null

    if (pinned) {
      const model =
        (selectedModelId && (pinned.models ?? []).some((m: any) => m.modelId === selectedModelId)
          ? selectedModelId
          : null) ??
        pinned.defaultModelId ??
        (pinned.models ?? [])[0]?.modelId ??
        null
      resolved = { providerId: pinned.providerId, modelId: model, source: 'agent_pin' }
    } else {
      const def = providers.find((p) => p.isDefault && p.status === 'active') ?? null
      if (def) {
        const model =
          def.defaultModelId ?? (def.models ?? [])[0]?.modelId ?? null
        resolved = { providerId: def.providerId, modelId: model, source: 'user_default_provider' }
      } else {
        resolved = { providerId: null, modelId: null, source: 'unresolved' }
      }
    }

    return {
      agentId,
      selectedProviderId,
      selectedModelId,
      providers,
      resolved,
    }
  }
}
