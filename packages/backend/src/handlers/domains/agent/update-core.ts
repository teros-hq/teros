/**
 * agent.update-core — Update an agent core configuration (admin)
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import { requireSystemAdmin } from '../../../auth/auth-helpers'
import { buildAvatarUrl } from '../../../lib/avatar-url'
import type { ModelService } from '../../../services/model-service'

interface UpdateCoreData {
  coreId: string
  updates: {
    name?: string
    fullName?: string
    version?: string
    modelId?: string
    systemPrompt?: string
    personality?: string[]
    capabilities?: string[]
    defaultApps?: string[]
    modelOverrides?: {
      temperature?: number
      maxTokens?: number
    }
    status?: 'active' | 'inactive'
  }
}

export function createUpdateCoreHandler(db: Db, modelService: ModelService) {
  return async function updateCore(ctx: WsHandlerContext, rawData: unknown) {
    // Admin-only: editing a core's systemPrompt/model affects every agent that
    // uses it. Without this gate any authenticated user could rewrite it (TER-513).
    await requireSystemAdmin(db, ctx.userId)

    const data = rawData as UpdateCoreData
    const { coreId, updates } = data

    const updatedCore = await modelService.updateAgentCore(coreId, updates)

    if (!updatedCore) {
      throw new HandlerError('AGENT_CORE_NOT_FOUND', `Agent core ${coreId} not found`)
    }

    console.log(`[agent.update-core] Updated agent core ${coreId}`)

    return {
      core: {
        coreId: updatedCore.coreId,
        coreType: updatedCore.coreType,
        name: updatedCore.name,
        fullName: updatedCore.fullName,
        version: updatedCore.version,
        systemPrompt: updatedCore.systemPrompt,
        personality: updatedCore.personality,
        capabilities: updatedCore.capabilities,
        defaultApps: updatedCore.defaultApps,
        avatarUrl: buildAvatarUrl(updatedCore.avatarUrl),
        modelId: updatedCore.modelId,
        modelOverrides: updatedCore.modelOverrides,
        status: updatedCore.status,
      },
    }
  }
}
