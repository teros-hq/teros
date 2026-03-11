/**
 * admin-api.agents — CRUD de agentes (admin)
 *
 * Actions:
 *   admin-api.agents-list        → GET  /admin/agents
 *   admin-api.agents-get         → GET  /admin/agents/:agentId
 *   admin-api.agents-create      → POST /admin/agents
 *   admin-api.agents-update      → PATCH /admin/agents/:agentId
 *   admin-api.agents-delete      → DELETE /admin/agents/:agentId
 *   admin-api.agents-get-apps    → GET  /admin/agents/:agentId/apps
 *   admin-api.agent-cores-list   → GET  /admin/agent-cores
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import { generateAgentId } from '@teros/core'
import type { McaService } from '../../../services/mca-service'

async function requireAdmin(db: Db, userId: string): Promise<void> {
  const user = await db.collection('users').findOne({ userId })
  if (user?.role !== 'admin' && user?.role !== 'super') {
    throw new HandlerError('FORBIDDEN', 'Admin privileges required')
  }
}

export function createAgentsListHandler(db: Db) {
  const agents = db.collection('agents')
  const agentCores = db.collection('agent_cores')

  return async function agentsList(ctx: WsHandlerContext, rawData: unknown) {
    await requireAdmin(db, ctx.userId)
    const data = (rawData ?? {}) as { workspaceId?: string }

    const filter: Record<string, unknown> = { status: 'active' }
    if (data.workspaceId) filter.workspaceId = data.workspaceId

    const agentList = await agents.find(filter).toArray()
    const cores = await agentCores.find({}).toArray()
    const coreMap = new Map(cores.map((c: any) => [c.coreId, c]))

    return {
      agents: agentList.map((a: any) => {
        const core = coreMap.get(a.coreId)
        return {
          agentId: a.agentId,
          name: a.name,
          fullName: a.fullName,
          role: a.role,
          intro: a.intro,
          avatarUrl: a.avatarUrl || core?.avatarUrl,
          coreId: a.coreId,
          workspaceId: a.workspaceId,
          ownerId: a.ownerId,
          createdAt: a.createdAt,
        }
      }),
    }
  }
}

export function createAgentsGetHandler(db: Db) {
  const agents = db.collection('agents')
  const agentCores = db.collection('agent_cores')

  return async function agentsGet(ctx: WsHandlerContext, rawData: unknown) {
    await requireAdmin(db, ctx.userId)
    const data = rawData as { agentId: string }
    if (!data.agentId) throw new HandlerError('VALIDATION_ERROR', 'agentId is required')

    const agent = await agents.findOne({ agentId: data.agentId })
    if (!agent) throw new HandlerError('NOT_FOUND', 'Agent not found')

    const core = await agentCores.findOne({ coreId: (agent as any).coreId })
    return {
      ...agent,
      avatarUrl: (agent as any).avatarUrl || (core as any)?.avatarUrl,
      core: core
        ? { coreId: (core as any).coreId, name: (core as any).name, fullName: (core as any).fullName }
        : null,
    }
  }
}

export function createAgentsCreateHandler(db: Db) {
  const agents = db.collection('agents')
  const agentCores = db.collection('agent_cores')

  return async function agentsCreate(ctx: WsHandlerContext, rawData: unknown) {
    await requireAdmin(db, ctx.userId)
    const data = rawData as {
      coreId: string; name: string; fullName: string; role: string; intro: string
      workspaceId?: string; ownerId?: string
    }

    if (!data.coreId || !data.name || !data.fullName || !data.role || !data.intro) {
      throw new HandlerError('VALIDATION_ERROR', 'Missing required fields: coreId, name, fullName, role, intro')
    }

    const core = await agentCores.findOne({ coreId: data.coreId })
    if (!core) throw new HandlerError('NOT_FOUND', `Agent core '${data.coreId}' not found`)

    const agentId = generateAgentId()
    const now = new Date().toISOString()

    const newAgent = {
      agentId,
      coreId: data.coreId,
      ownerId: data.ownerId || 'system',
      workspaceId: data.workspaceId,
      name: data.name,
      fullName: data.fullName,
      role: data.role,
      intro: data.intro,
      avatarUrl: (core as any).avatarUrl,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    }

    await agents.insertOne(newAgent)
    return { agent: newAgent }
  }
}

export function createAgentsUpdateHandler(db: Db) {
  const agents = db.collection('agents')

  return async function agentsUpdate(ctx: WsHandlerContext, rawData: unknown) {
    await requireAdmin(db, ctx.userId)
    const data = rawData as {
      agentId: string; name?: string; fullName?: string; role?: string
      intro?: string; avatarUrl?: string; maxSteps?: number
    }
    if (!data.agentId) throw new HandlerError('VALIDATION_ERROR', 'agentId is required')

    const updateFields: Record<string, unknown> = { updatedAt: new Date().toISOString() }
    if (data.name !== undefined) updateFields.name = data.name
    if (data.fullName !== undefined) updateFields.fullName = data.fullName
    if (data.role !== undefined) updateFields.role = data.role
    if (data.intro !== undefined) updateFields.intro = data.intro
    if (data.avatarUrl !== undefined) updateFields.avatarUrl = data.avatarUrl
    if (data.maxSteps !== undefined) updateFields.maxSteps = data.maxSteps

    const result = await agents.findOneAndUpdate(
      { agentId: data.agentId },
      { $set: updateFields },
      { returnDocument: 'after' },
    )

    if (!result) throw new HandlerError('NOT_FOUND', 'Agent not found')
    return { agent: result }
  }
}

export function createAgentsDeleteHandler(db: Db) {
  const agents = db.collection('agents')
  const access = db.collection('agent_app_access')

  return async function agentsDelete(ctx: WsHandlerContext, rawData: unknown) {
    await requireAdmin(db, ctx.userId)
    const data = rawData as { agentId: string }
    if (!data.agentId) throw new HandlerError('VALIDATION_ERROR', 'agentId is required')

    await access.deleteMany({ agentId: data.agentId })
    const result = await agents.deleteOne({ agentId: data.agentId })

    if (result.deletedCount === 0) throw new HandlerError('NOT_FOUND', 'Agent not found')
    return { success: true, agentId: data.agentId }
  }
}

export function createAgentsGetAppsHandler(db: Db, mcaService: McaService) {
  const access = db.collection('agent_app_access')

  return async function agentsGetApps(ctx: WsHandlerContext, rawData: unknown) {
    await requireAdmin(db, ctx.userId)
    const data = rawData as { agentId: string }
    if (!data.agentId) throw new HandlerError('VALIDATION_ERROR', 'agentId is required')

    const accessList = await access.find({ agentId: data.agentId }).toArray()

    const apps = await Promise.all(
      accessList.map(async (a: any) => {
        const app = await mcaService.getApp(a.appId)
        const mca = app ? await mcaService.getMcaFromCatalog(app.mcaId) : null
        return {
          appId: a.appId,
          appName: app?.name ?? 'Unknown',
          mcaId: app?.mcaId,
          mcaName: mca?.name ?? 'Unknown',
          grantedAt: a.grantedAt,
          grantedBy: a.grantedBy,
          permissions: a.permissions,
        }
      }),
    )

    return { agentId: data.agentId, apps }
  }
}

export function createAgentCoresListHandler(db: Db) {
  const agentCores = db.collection('agent_cores')

  return async function agentCoresList(ctx: WsHandlerContext, _rawData: unknown) {
    await requireAdmin(db, ctx.userId)
    const cores = await agentCores.find({ status: 'active' }).toArray()
    return { cores }
  }
}
