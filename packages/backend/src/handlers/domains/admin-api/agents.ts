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
import { requireSuperAdmin } from '../../../auth/auth-helpers'
import { AgentProvisioningService } from '../../../services/agent-provisioning-service'
import { buildAvatarUrl } from '../../../lib/avatar-url'
import type { McaService } from '../../../services/mca-service'
import type { FeatureFlagService } from '../../../services/feature-flag-service'

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
    const data = (rawData ?? {}) as { workspaceId?: string; includeAll?: boolean }

    // Default: solo agents activos (compat con UsersWindow / managed agents).
    // includeAll: super admin tools (e.g. AgentUsageWindow) que necesitan
    // ver agents legacy con `status:undefined` o archivados.
    const filter: Record<string, unknown> = data.includeAll === true ? {} : { status: 'active' }
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
          avatarUrl: buildAvatarUrl(a.avatarUrl || core?.avatarUrl),
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
      avatarUrl: buildAvatarUrl((agent as any).avatarUrl || (core as any)?.avatarUrl),
      core: core
        ? { coreId: (core as any).coreId, name: (core as any).name, fullName: (core as any).fullName }
        : null,
    }
  }
}

export function createAgentsCreateHandler(db: Db, mcaService: McaService) {
  // Single creation path: the same service that backs onboarding and agent.create.
  // Guarantees an admin-created agent is shaped and provisioned identically.
  const provisioning = new AgentProvisioningService(db, mcaService)

  return async function agentsCreate(ctx: WsHandlerContext, rawData: unknown) {
    await requireAdmin(db, ctx.userId)
    const data = rawData as {
      name: string; fullName: string; role: string; intro: string
      workspaceId?: string; ownerId?: string; context?: string
    }

    if (!data.name || !data.fullName || !data.role || !data.intro) {
      throw new HandlerError('VALIDATION_ERROR', 'Missing required fields: name, fullName, role, intro')
    }

    // Cores are internal: derived from scope, never chosen. Any `coreId` in the
    // request is ignored — to re-point a core, admins use agents-change-core.
    const agent = await provisioning.createAgentFromCore({
      ownerId: data.ownerId || 'system',
      workspaceId: data.workspaceId,
      profile: {
        name: data.name,
        fullName: data.fullName,
        role: data.role,
        intro: data.intro,
        context: data.context,
      },
    })
    return { agent }
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

export function createAgentsChangeCoreHandler(db: Db, mcaService: McaService) {
  const agents = db.collection('agents')

  return async function agentsChangeCore(ctx: WsHandlerContext, rawData: unknown) {
    await requireAdmin(db, ctx.userId)
    const data = rawData as { agentId: string; coreId: string }
    if (!data.agentId || !data.coreId) {
      throw new HandlerError('VALIDATION_ERROR', 'agentId and coreId are required')
    }

    // Reassign the agent's core and (re-)provision its core default apps.
    const provisioning = new AgentProvisioningService(db, mcaService)
    await provisioning.reprovisionForCore(data.agentId, data.coreId)

    const agent = await agents.findOne({ agentId: data.agentId })
    if (!agent) throw new HandlerError('NOT_FOUND', 'Agent not found')
    return { agent }
  }
}

/**
 * admin-api.core-rollout-apply — apply the % rollout for a coreType by re-pointing
 * + reprovisioning its agents (super only; affects real users in production).
 */
export function createCoreRolloutApplyHandler(
  db: Db,
  mcaService: McaService,
  featureFlagService: FeatureFlagService,
) {
  return async function coreRolloutApply(ctx: WsHandlerContext, rawData: unknown) {
    await requireSuperAdmin(db, ctx.userId)
    const data = rawData as { coreType?: 'agent' | 'super-agent' }
    if (data.coreType !== 'agent' && data.coreType !== 'super-agent') {
      throw new HandlerError('VALIDATION_ERROR', "coreType must be 'agent' or 'super-agent'")
    }

    const provisioning = new AgentProvisioningService(db, mcaService)
    let summary: Awaited<ReturnType<AgentProvisioningService['applyCoreRollout']>>
    try {
      summary = await provisioning.applyCoreRollout(data.coreType, featureFlagService)
    } catch (err) {
      throw new HandlerError('ROLLOUT_APPLY_FAILED', (err as Error).message)
    }

    console.log(`[admin-api.core-rollout-apply] ${data.coreType}:`, summary)
    // Record the apply in the audit timeline (when / who / result). Best-effort:
    // the migration already succeeded, so a failed audit write must not fail the call.
    try {
      await featureFlagService.recordRolloutApply(`core.${data.coreType}`, ctx.userId, summary)
    } catch (err) {
      console.error('[admin-api.core-rollout-apply] failed to record audit:', err)
    }
    return { coreType: data.coreType, ...summary }
  }
}

type RolloutRequest = {
  coreType?: 'agent' | 'super-agent'
  experimentalCoreId?: string
  percentage?: number
}

/** Validate the coreType and the optional hypothetical (shared by preview/cohort). */
function parseRolloutRequest(rawData: unknown): {
  coreType: 'agent' | 'super-agent'
  hypothetical?: { experimentalCoreId: string; percentage: number }
} {
  const data = (rawData ?? {}) as RolloutRequest
  if (data.coreType !== 'agent' && data.coreType !== 'super-agent') {
    throw new HandlerError('VALIDATION_ERROR', "coreType must be 'agent' or 'super-agent'")
  }
  // Hypothetical only when BOTH are provided and valid; else the saved rollout is
  // used. Guard the percentage at the boundary (JSON Schema can't express [0,100]).
  let hypothetical: { experimentalCoreId: string; percentage: number } | undefined
  if (data.experimentalCoreId !== undefined || data.percentage !== undefined) {
    if (
      typeof data.experimentalCoreId !== 'string' ||
      data.experimentalCoreId.trim() === '' ||
      !Number.isInteger(data.percentage) ||
      (data.percentage as number) < 0 ||
      (data.percentage as number) > 100
    ) {
      throw new HandlerError(
        'VALIDATION_ERROR',
        'For a hypothetical, experimentalCoreId must be a non-empty string and percentage an integer in [0, 100]',
      )
    }
    hypothetical = { experimentalCoreId: data.experimentalCoreId, percentage: data.percentage as number }
  }
  return { coreType: data.coreType, hypothetical }
}

/**
 * admin-api.core-rollout-preview — dry-run of a coreType rollout (super only):
 * current per-core distribution + what an Apply would do, without migrating anyone.
 */
export function createCoreRolloutPreviewHandler(
  db: Db,
  mcaService: McaService,
  featureFlagService: FeatureFlagService,
) {
  return async function coreRolloutPreview(ctx: WsHandlerContext, rawData: unknown) {
    await requireSuperAdmin(db, ctx.userId)
    const { coreType, hypothetical } = parseRolloutRequest(rawData)
    const provisioning = new AgentProvisioningService(db, mcaService)
    const preview = await provisioning.previewCoreRollout(coreType, featureFlagService, hypothetical)
    return { coreType, ...preview }
  }
}

/**
 * admin-api.core-rollout-cohort — the per-agent cohort (super only): WHICH users
 * and agents a rollout touches (current/target core, kind, owner, bucket), not just
 * counts. Without a hypothetical it reflects the saved rollout (who is on the
 * experimental NOW + who an Apply would move).
 */
export function createCoreRolloutCohortHandler(
  db: Db,
  mcaService: McaService,
  featureFlagService: FeatureFlagService,
) {
  return async function coreRolloutCohort(ctx: WsHandlerContext, rawData: unknown) {
    await requireSuperAdmin(db, ctx.userId)
    const { coreType, hypothetical } = parseRolloutRequest(rawData)
    const provisioning = new AgentProvisioningService(db, mcaService)
    const cohort = await provisioning.coreRolloutCohort(coreType, featureFlagService, hypothetical)
    return { coreType, cohort }
  }
}
