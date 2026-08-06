/**
 * agent.create — Create a new agent instance for the user or a workspace
 *
 * The core is internal: it is derived from the agent's scope by
 * AgentProvisioningService, never chosen by the user.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import { buildAgentCreatedPayload } from '../../../lib/agent-payload'
import type { AgentProvisioningService } from '../../../services/agent-provisioning-service'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { PubSubService } from '../../../services/pubsub-service'

interface CreateAgentData {
  name: string
  fullName: string
  role: string
  intro: string
  avatarUrl?: string
  workspaceId?: string
  context?: string
}

export function createCreateAgentHandler(
  provisioningService: AgentProvisioningService,
  workspaceService?: WorkspaceService | null,
  pubSubService?: PubSubService | null,
) {
  return async function createAgent(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as CreateAgentData
    console.log(`[agent.create] Creating agent for user: ${ctx.userId}`, data)

    const { name, fullName, role, intro, avatarUrl, workspaceId, context } = data

    if (!name || !fullName || !role || !intro) {
      throw new HandlerError(
        'INVALID_REQUEST',
        'Missing required fields: name, fullName, role, intro',
      )
    }

    if (workspaceId) {
      if (!workspaceService) {
        throw new HandlerError('WORKSPACE_NOT_CONFIGURED', 'Workspace service not available')
      }
      if (!(await workspaceService.canWrite(workspaceId, ctx.userId))) {
        throw new HandlerError('ACCESS_DENIED', 'You do not have write access to this workspace')
      }
      const workspace = await workspaceService.getWorkspace(workspaceId)
      if (!workspace) {
        throw new HandlerError('WORKSPACE_NOT_FOUND', `Workspace '${workspaceId}' not found`)
      }
    }

    const agent = await provisioningService.createAgentFromCore({
      ownerId: ctx.userId,
      workspaceId,
      profile: { name, fullName, role, intro, avatarUrl, context },
    })

    console.log(
      `[agent.create] Created agent: ${agent.agentId} for user ${ctx.userId}${workspaceId ? ` in workspace ${workspaceId}` : ' (global)'}`,
    )

    const agentPayload = buildAgentCreatedPayload(agent)

    if (pubSubService) {
      const event = { type: 'agent.created', agent: agentPayload }
      if (workspaceId) {
        await pubSubService.broadcastToWorkspace(workspaceId, event)
      } else {
        pubSubService.broadcastToUser(ctx.userId, event)
      }
    }

    return { agent: agentPayload }
  }
}
