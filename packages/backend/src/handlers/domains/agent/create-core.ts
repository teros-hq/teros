/**
 * agent.create-core — Create a new agent core (admin)
 *
 * Authors a new core (typically an experimental one for a rollout, TER-412).
 * Created `active` by default — safe because agent creation always resolves to
 * the canonical core (see createAgentFromCore), so an active experimental core
 * never captures new agents by birth. Admin-only for the same reason as
 * update-core: a core defines the engine (prompt + model + MCAs) of every agent
 * that uses it.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import { requireSystemAdmin } from '../../../auth/auth-helpers'
import { buildAvatarUrl } from '../../../lib/avatar-url'
import type { ModelService } from '../../../services/model-service'

interface CreateCoreData {
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
}

export function createCreateCoreHandler(db: Db, modelService: ModelService) {
  return async function createCore(ctx: WsHandlerContext, rawData: unknown) {
    await requireSystemAdmin(db, ctx.userId)

    const data = rawData as CreateCoreData

    // Validate at the boundary what JSON shape alone can't express.
    const required: Array<[keyof CreateCoreData, unknown]> = [
      ['coreId', data?.coreId],
      ['coreType', data?.coreType],
      ['name', data?.name],
      ['fullName', data?.fullName],
      ['systemPrompt', data?.systemPrompt],
      ['modelId', data?.modelId],
    ]
    for (const [field, value] of required) {
      if (typeof value !== 'string' || !value.trim()) {
        throw new HandlerError('INVALID_INPUT', `${String(field)} is required and must be a non-empty string`)
      }
    }

    let core: Awaited<ReturnType<ModelService['createAgentCore']>>
    try {
      core = await modelService.createAgentCore(data)
    } catch (err) {
      throw new HandlerError('CREATE_CORE_FAILED', (err as Error).message)
    }

    console.log(`[agent.create-core] Created agent core ${core.coreId} (${core.coreType}, ${core.status})`)

    return {
      core: {
        coreId: core.coreId,
        coreType: core.coreType,
        name: core.name,
        fullName: core.fullName,
        version: core.version,
        systemPrompt: core.systemPrompt,
        personality: core.personality,
        capabilities: core.capabilities,
        defaultApps: core.defaultApps,
        avatarUrl: buildAvatarUrl(core.avatarUrl),
        modelId: core.modelId,
        modelOverrides: core.modelOverrides,
        status: core.status,
      },
    }
  }
}
