/**
 * agent.update-core — Update an agent core configuration (admin)
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import { config } from '../../../config'
import type { ModelService } from '../../../services/model-service'

function buildAvatarUrl(avatarFilename?: string): string | undefined {
  if (!avatarFilename) return undefined
  return `${config.static.baseUrl}/${avatarFilename}`
}

interface UpdateCoreData {
  coreId: string
  updates: {
    modelId?: string
    systemPrompt?: string
    modelOverrides?: {
      temperature?: number
      maxTokens?: number
    }
    status?: 'active' | 'inactive'
  }
}

export function createUpdateCoreHandler(db: Db, modelService: ModelService) {
  void db // kept for symmetry; modelService already has its own db reference

  return async function updateCore(_ctx: WsHandlerContext, rawData: unknown) {
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
        name: updatedCore.name,
        fullName: updatedCore.fullName,
        version: updatedCore.version,
        systemPrompt: updatedCore.systemPrompt,
        personality: updatedCore.personality,
        capabilities: updatedCore.capabilities,
        avatarUrl: buildAvatarUrl(updatedCore.avatarUrl),
        modelId: updatedCore.modelId,
        modelOverrides: updatedCore.modelOverrides,
        status: updatedCore.status,
      },
    }
  }
}
