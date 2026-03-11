/**
 * agent.list-cores — List available agent cores (engines)
 */

import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import { config } from '../../../config'
import type { ModelService } from '../../../services/model-service'

function buildAvatarUrl(avatarFilename?: string): string | undefined {
  if (!avatarFilename) return undefined
  return `${config.static.baseUrl}/${avatarFilename}`
}

interface ListCoresData {
  status?: 'active' | 'inactive'
}

export function createListCoresHandler(db: Db, modelService: ModelService) {
  void db // kept for symmetry; modelService already has its own db reference

  return async function listCores(_ctx: WsHandlerContext, rawData: unknown) {
    const data = (rawData ?? {}) as ListCoresData
    const status = data.status as 'active' | 'inactive' | undefined

    const cores = await modelService.listAgentCores(status)

    return {
      cores: cores.map((c) => ({
        coreId: c.coreId,
        name: c.name,
        fullName: c.fullName,
        version: c.version,
        systemPrompt: c.systemPrompt,
        personality: c.personality,
        capabilities: c.capabilities,
        avatarUrl: buildAvatarUrl(c.avatarUrl),
        modelId: c.modelId,
        modelOverrides: c.modelOverrides,
        status: c.status,
      })),
    }
  }
}
