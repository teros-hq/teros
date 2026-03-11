/**
 * provider.list-models — List available LLM models (active)
 */

import type { WsHandlerContext } from '@teros/shared'
import { ModelService } from '../../../services/model-service'
import type { Db } from 'mongodb'

export function createListModelsHandler(db: Db) {
  return async function listModels(_ctx: WsHandlerContext) {
    const modelService = new ModelService(db)
    const models = await modelService.listModels('active')

    return {
      models: models.map((m) => ({
        modelId: m.modelId,
        name: m.name,
        provider: m.provider,
        description: m.description,
        modelString: m.modelString,
        context: m.context,
        defaults: m.defaults,
        capabilities: m.capabilities,
        status: m.status,
      })),
    }
  }
}
