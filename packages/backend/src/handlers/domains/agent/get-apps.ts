/**
 * agent.get-apps — Get apps an agent has access to
 */

import type { Db } from 'mongodb'
import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import { canAccessAgent } from '../../../auth/workspace-access'
import type { McaService } from '../../../services/mca-service'

interface GetAppsData {
  agentId: string
  workspaceId?: string
}

export function createGetAppsHandler(mcaService: McaService, db: Db) {
  return async function getApps(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as GetAppsData
    const { agentId, workspaceId } = data

    if (!(await canAccessAgent(db, ctx.userId, agentId))) {
      throw new HandlerError('FORBIDDEN', 'No access to this agent')
    }

    console.log(`[agent.get-apps] Getting apps for agent: ${agentId}`)

    const agentApps = await mcaService.getAgentApps(agentId, workspaceId)
    console.log(`[agent.get-apps] Got ${agentApps.apps.length} apps for agent ${agentId}`)

    const apps = await Promise.all(
      agentApps.apps.map(async ({ app, access }) => ({
        appId: app.appId,
        name: app.name,
        mcaId: app.mca.mcaId,
        description: app.mca.description,
        icon: app.mca.icon,
        // App.context — the per-app instructions injected into the agent's
        // system prompt (model-service.buildSystemPrompt). Exposed so the UI
        // can show what's actually steering the agent.
        context: app.context ?? '',
        hasAccess: true,
        grantedAt: access.grantedAt,
      })),
    )

    return { agentId, apps }
  }
}
