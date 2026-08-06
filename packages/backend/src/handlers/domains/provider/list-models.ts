/**
 * provider.list-models — List available LLM models (active)
 */

import { type WsHandlerContext, resolveRetention } from '@teros/shared'
import { ModelService } from '../../../services/model-service'
import type { Db } from 'mongodb'

export function createListModelsHandler(db: Db, modelService?: ModelService) {
  return async function listModels(_ctx: WsHandlerContext) {
    const svc = modelService ?? new ModelService(db)
    const models = await svc.listModels('active')

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
        // Data-retention posture so the picker can warn the user before they
        // choose a model. Resolved from provider (+ config nuances like zhipu
        // useChina). Whitelist gotcha: a field omitted here is invisible to the UI.
        retention: resolveRetention(m.provider, m.providerConfig),
      })),
    }
  }
}
