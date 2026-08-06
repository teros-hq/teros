/**
 * app.list-agent-access — Agents of an app's workspace + their access flag.
 *
 * Powers the "Agents" section of the AppWindow: given an installed app, list
 * the agents that could use it (the workspace's own agents plus the workspace
 * owner's / caller's superagents) and whether each currently has access. The
 * UI toggles access through the existing app.grant-access / app.revoke-access.
 *
 * Mirrors agent.list's agent-resolution rules so the two directions of the
 * relationship show the same roster. Fail-closed: the caller must have access
 * to the app's workspace.
 *
 * Layer separation: returns data (agentId + resolved name/avatar + boolean),
 * never UI copy.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import { buildAvatarUrl } from '../../../lib/avatar-url'
import type { McaService } from '../../../services/mca-service'
import type { WorkspaceService } from '../../../services/workspace-service'

interface ListAgentAccessData {
  appId: string
}

export function createListAgentAccessHandler(
  mcaService: McaService,
  db: Db,
  workspaceService?: WorkspaceService | null,
) {
  return async function listAgentAccess(ctx: WsHandlerContext, rawData: unknown) {
    const { appId } = (rawData as ListAgentAccessData) ?? {}
    if (!appId || typeof appId !== 'string') {
      throw new HandlerError('MISSING_APP_ID', 'appId is required')
    }

    const app = await mcaService.getApp(appId)
    if (!app) {
      throw new HandlerError('APP_NOT_FOUND', `App ${appId} not found`)
    }

    // Apps are always workspace-scoped (App.ownerId === workspaceId).
    const workspaceId = app.ownerType === 'workspace' ? app.ownerId : undefined
    if (!workspaceId) {
      return { appId, agents: [] }
    }

    // Fail-closed: the caller must be able to access the app's workspace.
    if (workspaceService && !(await workspaceService.canAccess(workspaceId, ctx.userId))) {
      throw new HandlerError('ACCESS_DENIED', 'You do not have access to this workspace')
    }

    // Roster: workspace agents + superagents owned by the caller or the
    // workspace owner — same rule as agent.list so both directions match.
    const workspace = await db.collection('workspaces').findOne({ workspaceId } as never)
    const workspaceOwnerId = (workspace as { ownerId?: string } | null)?.ownerId
    const superagentOwnerIds = Array.from(new Set([ctx.userId, workspaceOwnerId].filter(Boolean)))

    const agentList = await db
      .collection('agents')
      .find({
        $or: [
          { workspaceId },
          { ownerId: { $in: superagentOwnerIds }, workspaceId: { $in: [null, undefined] } },
        ],
      } as never)
      .toArray()

    const cores = await db.collection('agent_cores').find({}).toArray()
    const coreAvatar = new Map(cores.map((c) => [c.coreId as string, c.avatarUrl as string | undefined]))

    // One query for all access rows of this app → O(1) lookup per agent.
    const accessRows = await mcaService.getAppAccessList(appId)
    const granted = new Set(accessRows.map((a) => a.agentId))

    return {
      appId,
      agents: agentList.map((a) => ({
        agentId: a.agentId as string,
        name: a.name as string,
        role: (a.role as string | undefined) ?? '',
        avatarUrl: buildAvatarUrl((a.avatarUrl as string | undefined) || coreAvatar.get(a.coreId as string)),
        hasAccess: granted.has(a.agentId as string),
      })),
    }
  }
}
