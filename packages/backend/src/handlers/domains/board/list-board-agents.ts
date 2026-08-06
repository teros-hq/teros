/**
 * board.list-board-agents — List agents with board-manager or board-runner access
 *
 * Returns all agents in the workspace (including superagents) that have access
 * to at least one board-manager or board-runner app, along with their board role:
 *   - 'manager'  → has board-manager access only
 *   - 'runner'   → has board-runner access only
 *   - 'both'     → has both board-manager and board-runner access
 *
 * Superagents (workspaceId=null) are included: they use the workspace's board apps
 * just like regular workspace agents do.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import type { WorkspaceService } from '../../../services/workspace-service'
import { buildAvatarUrl } from '../../../lib/avatar-url'

interface ListBoardAgentsData {
  workspaceId: string
}

export function createListBoardAgentsHandler(
  db: Db,
  workspaceService: WorkspaceService,
) {
  const agentsCollection = db.collection('agents')
  const agentCoresCollection = db.collection('agent_cores')
  const appsCollection = db.collection('apps')
  const accessCollection = db.collection('agent_app_access')
  const workspacesCollection = db.collection('workspaces')

  return async function listBoardAgents(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as ListBoardAgentsData
    const { workspaceId } = data

    if (!workspaceId) {
      throw new HandlerError('MISSING_FIELDS', 'workspaceId is required')
    }

    const role = await workspaceService.getUserRole(workspaceId, ctx.userId)
    if (role === null) {
      throw new HandlerError('FORBIDDEN', 'No access to this workspace')
    }

    // Resolve workspace owner so we can include their superagents in the results
    const workspace = await workspacesCollection.findOne({ workspaceId } as any) as any
    const workspaceOwnerId = workspace?.ownerId

    // Find all board-manager and board-runner apps in this workspace
    const boardApps = await appsCollection
      .find({
        ownerId: workspaceId,
        ownerType: 'workspace',
        status: 'active',
        mcaId: { $in: ['mca.teros.board-manager', 'mca.teros.board-runner'] },
      })
      .toArray() as any[]

    if (boardApps.length === 0) {
      return { workspaceId, agents: [], count: 0 }
    }

    const boardManagerAppIds = boardApps
      .filter((a) => a.mcaId === 'mca.teros.board-manager')
      .map((a) => a.appId)

    const boardRunnerAppIds = boardApps
      .filter((a) => a.mcaId === 'mca.teros.board-runner')
      .map((a) => a.appId)

    const allBoardAppIds = boardApps.map((a) => a.appId)

    // Find all access records for board apps
    const accessRecords = await accessCollection
      .find({ appId: { $in: allBoardAppIds } })
      .toArray() as any[]

    if (accessRecords.length === 0) {
      return { workspaceId, agents: [], count: 0 }
    }

    // Build a map: agentId → { hasManager, hasRunner }
    const agentRoleMap = new Map<string, { hasManager: boolean; hasRunner: boolean }>()
    for (const record of accessRecords) {
      const current = agentRoleMap.get(record.agentId) ?? { hasManager: false, hasRunner: false }
      if (boardManagerAppIds.includes(record.appId)) current.hasManager = true
      if (boardRunnerAppIds.includes(record.appId)) current.hasRunner = true
      agentRoleMap.set(record.agentId, current)
    }

    // Fetch agent details — include workspace agents AND superagents (workspaceId=null/undefined).
    // Superagents are owned by ctx.userId or the workspace owner and have no workspaceId.
    // Mirrors the query pattern used by agent.list to ensure superagents are not excluded.
    const agentIds = Array.from(agentRoleMap.keys())
    const superagentOwnerIds = Array.from(new Set([ctx.userId, workspaceOwnerId].filter(Boolean)))
    const agents = await agentsCollection
      .find({
        agentId: { $in: agentIds },
        $or: [
          { workspaceId },
          { ownerId: { $in: superagentOwnerIds }, workspaceId: { $in: [null, undefined] } },
        ],
      } as any)
      .toArray() as any[]

    // Fetch agent cores for avatar fallback
    const cores = await agentCoresCollection.find({}).toArray() as any[]
    const coreMap = new Map(cores.map((c: any) => [c.coreId, c]))

    const result = agents.map((agent: any) => {
      const roles = agentRoleMap.get(agent.agentId) ?? { hasManager: false, hasRunner: false }
      let boardRole: 'manager' | 'runner' | 'both'
      if (roles.hasManager && roles.hasRunner) boardRole = 'both'
      else if (roles.hasManager) boardRole = 'manager'
      else boardRole = 'runner'

      const core = coreMap.get(agent.coreId) as any
      const avatarUrl = agent.avatarUrl || core?.avatarUrl

      return {
        agentId: agent.agentId,
        name: agent.name,
        fullName: agent.fullName,
        role: agent.role,
        avatarUrl: buildAvatarUrl(avatarUrl),
        boardRole,
      }
    })

    return { workspaceId, agents: result, count: result.length }
  }
}
