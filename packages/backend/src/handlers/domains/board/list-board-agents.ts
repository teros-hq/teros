/**
 * board.list-board-agents — List agents with board-manager or board-runner access
 *
 * Returns all agents in the workspace that have access to at least one
 * board-manager or board-runner app, along with their board role:
 *   - 'manager'  → has board-manager access only
 *   - 'runner'   → has board-runner access only
 *   - 'both'     → has both board-manager and board-runner access
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import type { WorkspaceService } from '../../../services/workspace-service'
import { config } from '../../../config'

interface ListBoardAgentsData {
  workspaceId: string
}

function buildAvatarUrl(avatarFilename?: string): string | undefined {
  if (!avatarFilename) return undefined
  return `${config.static.baseUrl}/${avatarFilename}`
}

export function createListBoardAgentsHandler(
  db: Db,
  workspaceService: WorkspaceService,
) {
  const agentsCollection = db.collection('agents')
  const agentCoresCollection = db.collection('agent_cores')
  const appsCollection = db.collection('apps')
  const accessCollection = db.collection('agent_app_access')

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

    // Fetch agent details
    const agentIds = Array.from(agentRoleMap.keys())
    const agents = await agentsCollection
      .find({ agentId: { $in: agentIds }, workspaceId })
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
