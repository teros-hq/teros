/**
 * agent.get-apps — Get apps an agent has access to
 */

import type { WsHandlerContext } from '@teros/shared'
import type { McaService } from '../../../services/mca-service'

interface GetAppsData {
  agentId: string
}

export function createGetAppsHandler(mcaService: McaService) {
  return async function getApps(_ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as GetAppsData
    const { agentId } = data

    console.log(`[agent.get-apps] Getting apps for agent: ${agentId}`)

    const agentApps = await mcaService.getAgentApps(agentId)
    console.log(`[agent.get-apps] Got ${agentApps.apps.length} apps for agent ${agentId}`)

    const apps = await Promise.all(
      agentApps.apps.map(async ({ app, access }) => ({
        appId: app.appId,
        name: app.name,
        mcaId: app.mca.mcaId,
        description: app.mca.description,
        icon: app.mca.icon,
        hasAccess: true,
        grantedAt: access.grantedAt,
      })),
    )

    return { agentId, apps }
  }
}
