/**
 * agent.set-model — Set the agent's model pin (selectedProviderId + selectedModelId)
 *
 * The availableProviders list is GONE (2026-10-21): a pin is a single
 * (provider, model) pair. An agent without a pin resolves to the user's
 * default provider (System Default).
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import { isProviderTypeAllowedInEdition } from '@teros/shared'
import type { Db } from 'mongodb'
import { assertOwnProviders } from './provider-ownership'

interface SetModelData {
  agentId: string
  providerId: string | null
  modelId?: string | null
}

/** @spec ONB-REQ-14 */
export function createSetModelHandler(db: Db) {
  return async function setModel(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as SetModelData
    const { agentId, providerId, modelId } = data

    if (typeof agentId !== 'string' || !agentId) {
      throw new HandlerError('MISSING_AGENT_ID', 'agentId is required')
    }

    const agent = await db.collection('agents').findOne({ agentId })
    if (!agent) {
      throw new HandlerError('AGENT_NOT_FOUND', 'Agent not found')
    }

    if (agent.ownerId !== ctx.userId) {
      throw new HandlerError('PERMISSION_DENIED', 'You do not have permission to modify this agent')
    }

    // Only the caller's own providers (MOD-8)
    await assertOwnProviders(db, ctx.userId, [providerId])

    if (providerId) {
      // Edition gate (TER-EDITION): a cloud deployment must never accept a NEW
      // pin onto a local-Ollama provider — the runtime resolver refuses it, so
      // refusing here gives an immediate, clear error instead of a pin that
      // only explodes on the next turn.
      const targetProvider = await db.collection('user_providers').findOne({ providerId })
      if (targetProvider && !isProviderTypeAllowedInEdition(targetProvider.providerType)) {
        throw new HandlerError(
          'PROVIDER_NOT_AVAILABLE_IN_EDITION',
          `Provider '${targetProvider.displayName}' (${targetProvider.providerType} — local Ollama daemon) is ` +
            `only available in the self-hosted edition. Pin the agent to a cloud-compatible model ` +
            `(e.g. an 'ollama-cloud' model) instead.`,
        )
      }

      // Model must be served by the pinned provider
      if (modelId) {
        const provider = await db.collection('user_providers').findOne({ providerId })
        const model = (provider?.models ?? []).find((m: any) => m.modelId === modelId)
        if (!model) {
          throw new HandlerError(
            'MODEL_NOT_SERVED',
            `Model '${modelId}' is not served by provider '${providerId}'`,
          )
        }
        // ONB-REQ-14: agent turns always send tools; a model marked as unable
        // to take them would fail on the next turn.
        if (model.capabilities?.tools === false) {
          throw new HandlerError(
            'MODEL_WITHOUT_TOOLS',
            `Model '${model.modelString ?? modelId}' cannot use tools, and agents need them. Pick another model.`,
          )
        }
      }

      await db.collection('agents').updateOne(
        { agentId },
        {
          $set: {
            selectedProviderId: providerId,
            selectedModelId: modelId ?? null,
            updatedAt: new Date().toISOString(),
          },
        },
      )
    } else {
      // providerId === null → clear the pin (System Default)
      await db.collection('agents').updateOne(
        { agentId },
        {
          $set: {
            selectedProviderId: null,
            selectedModelId: null,
            updatedAt: new Date().toISOString(),
          },
        },
      )
    }

    console.log(`[agent.set-model] Set model pin for agent ${agentId} to ${providerId}/${modelId ?? '(provider default)'}`)

    return { agentId, selectedProviderId: providerId ?? null, selectedModelId: modelId ?? null }
  }
}
