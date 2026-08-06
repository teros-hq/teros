/**
 * agent.list-cores — List available agent cores (engines)
 */

import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import { requireSystemAdmin } from '../../../auth/auth-helpers'
import { buildAvatarUrl } from '../../../lib/avatar-url'
import type { ModelService } from '../../../services/model-service'

interface ListCoresData {
  /**
   * Filter by core status. Defaults to 'active' — inactive cores are the
   * deactivated legacy engines from the consolidation migration (no agent
   * references them), so surfacing them in the admin list is pure noise. Pass
   * 'inactive' explicitly to inspect them (e.g. before a purge).
   */
  status?: 'active' | 'inactive'
}

export function createListCoresHandler(db: Db, modelService: ModelService) {
  return async function listCores(ctx: WsHandlerContext, rawData: unknown) {
    // Cores are internal infra (TER-412): only admins may list them. This was a
    // public catalogue under the old user-facing model; internalizing cores
    // makes it admin-only (TER-510 allowlist updated accordingly).
    await requireSystemAdmin(db, ctx.userId)

    const data = (rawData ?? {}) as ListCoresData
    // Default to active so the admin UI never lists the 16 deactivated legacy
    // cores left behind (deactivated, not deleted) by the consolidation.
    const status: 'active' | 'inactive' = data.status ?? 'active'

    const cores = await modelService.listAgentCores(status)

    return {
      cores: cores.map((c) => ({
        coreId: c.coreId,
        coreType: c.coreType,
        name: c.name,
        fullName: c.fullName,
        version: c.version,
        systemPrompt: c.systemPrompt,
        personality: c.personality,
        capabilities: c.capabilities,
        defaultApps: c.defaultApps,
        avatarUrl: buildAvatarUrl(c.avatarUrl),
        modelId: c.modelId,
        modelOverrides: c.modelOverrides,
        status: c.status,
      })),
    }
  }
}
