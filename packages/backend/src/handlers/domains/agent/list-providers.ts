/**
 * agent.list-providers — List providers available for an agent
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import type { UserProviderRecord } from '../../../services/provider-service'

interface ListProvidersData {
  agentId: string
}

export function createListProvidersHandler(db: Db) {
  return async function listProviders(_ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as ListProvidersData
    const { agentId } = data

    if (!agentId) {
      throw new HandlerError('MISSING_AGENT_ID', 'agentId is required')
    }

    const agent = await db.collection('agents').findOne({ agentId })
    if (!agent) {
      throw new HandlerError('AGENT_NOT_FOUND', 'Agent not found')
    }

    const availableProviders: string[] = agent.availableProviders ?? []

    let providerDetails: any[] = []
    if (availableProviders.length > 0) {
      const records = await db
        .collection<UserProviderRecord>('user_providers')
        .find({ providerId: { $in: availableProviders } })
        .toArray()

      providerDetails = records.map((p) => ({
        providerId: p.providerId,
        providerType: p.providerType,
        displayName: p.displayName,
        status: p.status,
        models: p.models,
      }))
    }

    return {
      agentId,
      availableProviders,
      preferredProviderId: agent.preferredProviderId ?? null,
      providers: providerDetails,
    }
  }
}
