/**
 * automate.quota — the caller's daily Automate execution budget.
 *
 * The quota is per subscriber (the user who creates the starters), not per
 * workspace, so no workspaceId is needed: the window shows "X of Y runs
 * today" and the agent tools answer "why didn't my reminder fire?" with it.
 */

import type { WsHandlerContext } from '@teros/shared'
import type { AutomateQuotaService } from '../../../services/automate-quota'

export function createQuotaHandler(quota: AutomateQuotaService) {
  return async (ctx: WsHandlerContext, _data: unknown) => {
    const status = await quota.getStatus(ctx.userId)
    const topStarters = status.limit > 0 ? await quota.topStartersToday(ctx.userId) : []
    return { ...status, topStarters }
  }
}
