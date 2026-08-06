/**
 * admin-api.feature-flags — Feature flag management (super only)
 *
 * Actions:
 *   admin-api.feature-flags-list           → List all flags with override counts
 *   admin-api.feature-flags-get            → Get a single flag with its overrides
 *   admin-api.feature-flags-update         → Change a flag's default value
 *   admin-api.feature-flags-reset-default  → Reset flag to registry default
 *   admin-api.feature-flags-get-overrides  → List overrides for a flag
 *   admin-api.feature-flags-set-override   → Create/update an override
 *   admin-api.feature-flags-delete-override → Delete an override
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import { requireSuperAdmin } from '../../../auth/auth-helpers'
import type { FeatureFlagService } from '../../../services/feature-flag-service'
import type { FeatureFlagValue, FeatureFlagTargetType } from '@teros/shared'

// ── List ───────────────────────────────────────────────────────────────────

export function createFeatureFlagsListHandler(db: Db, featureFlagService: FeatureFlagService) {
  return async function featureFlagsList(ctx: WsHandlerContext, _rawData: unknown) {
    await requireSuperAdmin(db, ctx.userId)

    const [flags, overrides] = await Promise.all([
      featureFlagService.listFlags(),
      featureFlagService.getOverridesForAllFlags(),
    ])

    const overrideCounts = new Map<string, number>()
    for (const o of overrides) {
      overrideCounts.set(o.key, (overrideCounts.get(o.key) ?? 0) + 1)
    }

    return {
      flags: flags.map((f) => ({
        key: f.key,
        type: f.type,
        description: f.description,
        defaultValue: f.defaultValue,
        category: f.category,
        enumValues: f.enumValues,
        overrideCount: overrideCounts.get(f.key) ?? 0,
        rollout: f.rollout ?? null,
      })),
    }
  }
}

// ── Get ────────────────────────────────────────────────────────────────────

export function createFeatureFlagsGetHandler(db: Db, featureFlagService: FeatureFlagService) {
  return async function featureFlagsGet(ctx: WsHandlerContext, rawData: unknown) {
    await requireSuperAdmin(db, ctx.userId)
    const data = rawData as { key?: string }

    if (!data.key) {
      throw new HandlerError('MISSING_FIELDS', 'key is required')
    }

    const flag = await featureFlagService.getFlag(data.key)
    if (!flag) {
      throw new HandlerError('NOT_FOUND', `Feature flag '${data.key}' not found`)
    }

    const overrides = await featureFlagService.listOverrides(data.key)

    return {
      flag: {
        key: flag.key,
        type: flag.type,
        description: flag.description,
        defaultValue: flag.defaultValue,
        category: flag.category,
        enumValues: flag.enumValues,
        overrides: overrides.map((o) => ({
          targetType: o.targetType,
          targetId: o.targetId,
          value: o.value,
          note: o.note,
          createdBy: o.createdBy,
          createdAt: o.createdAt,
          updatedAt: o.updatedAt,
        })),
      },
    }
  }
}

// ── Update default ─────────────────────────────────────────────────────────

export function createFeatureFlagsUpdateHandler(db: Db, featureFlagService: FeatureFlagService) {
  return async function featureFlagsUpdate(ctx: WsHandlerContext, rawData: unknown) {
    await requireSuperAdmin(db, ctx.userId)
    const data = rawData as { key?: string; defaultValue?: FeatureFlagValue }

    if (!data.key || data.defaultValue === undefined) {
      throw new HandlerError('MISSING_FIELDS', 'key and defaultValue are required')
    }

    await featureFlagService.setDefault(data.key, data.defaultValue, ctx.userId)

    return { success: true, key: data.key }
  }
}

// ── Reset default ──────────────────────────────────────────────────────────

export function createFeatureFlagsResetDefaultHandler(
  db: Db,
  featureFlagService: FeatureFlagService,
) {
  return async function featureFlagsResetDefault(ctx: WsHandlerContext, rawData: unknown) {
    await requireSuperAdmin(db, ctx.userId)
    const data = rawData as { key?: string }

    if (!data.key) {
      throw new HandlerError('MISSING_FIELDS', 'key is required')
    }

    await featureFlagService.resetToRegistryDefault(data.key, ctx.userId)

    return { success: true, key: data.key }
  }
}

// ── Get overrides ──────────────────────────────────────────────────────────

export function createFeatureFlagsGetOverridesHandler(
  db: Db,
  featureFlagService: FeatureFlagService,
) {
  return async function featureFlagsGetOverrides(ctx: WsHandlerContext, rawData: unknown) {
    await requireSuperAdmin(db, ctx.userId)
    const data = rawData as { key?: string }

    if (!data.key) {
      throw new HandlerError('MISSING_FIELDS', 'key is required')
    }

    const overrides = await featureFlagService.listOverrides(data.key)

    return {
      overrides: overrides.map((o) => ({
        key: o.key,
        targetType: o.targetType,
        targetId: o.targetId,
        value: o.value,
        note: o.note,
        createdBy: o.createdBy,
        createdAt: o.createdAt,
        updatedAt: o.updatedAt,
      })),
    }
  }
}

// ── Set override ───────────────────────────────────────────────────────────

export function createFeatureFlagsSetOverrideHandler(
  db: Db,
  featureFlagService: FeatureFlagService,
) {
  return async function featureFlagsSetOverride(ctx: WsHandlerContext, rawData: unknown) {
    await requireSuperAdmin(db, ctx.userId)
    const data = rawData as {
      key?: string
      targetType?: FeatureFlagTargetType
      targetId?: string
      value?: FeatureFlagValue
      note?: string
    }

    if (!data.key || !data.targetType || !data.targetId || data.value === undefined) {
      throw new HandlerError('MISSING_FIELDS', 'key, targetType, targetId, and value are required')
    }

    const validTargetTypes: FeatureFlagTargetType[] = ['user', 'workspace', 'company']
    if (!validTargetTypes.includes(data.targetType)) {
      throw new HandlerError('INVALID_TARGET_TYPE', 'targetType must be user, workspace, or company')
    }

    await featureFlagService.setOverride(
      data.key,
      data.targetType,
      data.targetId,
      data.value,
      ctx.userId,
      data.note,
    )

    return { success: true, key: data.key, targetType: data.targetType, targetId: data.targetId }
  }
}

// ── Delete override ──────────────────────────────────────────────────────

export function createFeatureFlagsDeleteOverrideHandler(
  db: Db,
  featureFlagService: FeatureFlagService,
) {
  return async function featureFlagsDeleteOverride(ctx: WsHandlerContext, rawData: unknown) {
    await requireSuperAdmin(db, ctx.userId)
    const data = rawData as {
      key?: string
      targetType?: FeatureFlagTargetType
      targetId?: string
    }

    if (!data.key || !data.targetType || !data.targetId) {
      throw new HandlerError('MISSING_FIELDS', 'key, targetType, and targetId are required')
    }

    await featureFlagService.deleteOverride(data.key, data.targetType, data.targetId, ctx.userId)

    return { success: true, key: data.key, targetType: data.targetType, targetId: data.targetId }
  }
}

// ── Set rollout ──────────────────────────────────────────────────────────────

export function createFeatureFlagsSetRolloutHandler(
  db: Db,
  featureFlagService: FeatureFlagService,
) {
  return async function featureFlagsSetRollout(ctx: WsHandlerContext, rawData: unknown) {
    await requireSuperAdmin(db, ctx.userId)
    const data = rawData as { key?: string; value?: FeatureFlagValue; percentage?: number; note?: string }

    if (!data.key || data.value === undefined || data.percentage === undefined) {
      throw new HandlerError('MISSING_FIELDS', 'key, value, and percentage are required')
    }
    if (!Number.isInteger(data.percentage) || data.percentage < 0 || data.percentage > 100) {
      throw new HandlerError('INVALID_PERCENTAGE', 'percentage must be an integer in [0, 100]')
    }

    // For agent-core rollout flags, the value is a coreId — validate it exists,
    // is active, and matches the flag's coreType (so we never roll out onto a
    // missing/inactive/mismatched core). Generic flags skip this.
    if (data.key.startsWith('core.')) {
      const coreType = data.key.slice('core.'.length)
      if (coreType !== 'agent' && coreType !== 'super-agent') {
        throw new HandlerError('INVALID_CORE_FLAG', `'${data.key}' is not a valid core rollout flag`)
      }
      if (typeof data.value !== 'string') {
        throw new HandlerError('INVALID_ROLLOUT_VALUE', 'core rollout value must be a coreId string')
      }
      const core = await db.collection('agent_cores').findOne({ coreId: String(data.value) })
      if (!core) {
        throw new HandlerError('CORE_NOT_FOUND', `Rollout target core '${String(data.value)}' not found`)
      }
      if (core.status !== 'active') {
        throw new HandlerError('CORE_INACTIVE', `Rollout target core '${String(data.value)}' is inactive — activate it first`)
      }
      if (core.coreType !== coreType) {
        throw new HandlerError(
          'CORE_TYPE_MISMATCH',
          `Core '${String(data.value)}' is coreType '${core.coreType}', expected '${coreType}' for flag ${data.key}`,
        )
      }
    }

    await featureFlagService.setRollout(data.key, data.value, data.percentage, ctx.userId, data.note)

    return { success: true, key: data.key, value: data.value, percentage: data.percentage }
  }
}

// ── Clear rollout ────────────────────────────────────────────────────────────

export function createFeatureFlagsClearRolloutHandler(
  db: Db,
  featureFlagService: FeatureFlagService,
) {
  return async function featureFlagsClearRollout(ctx: WsHandlerContext, rawData: unknown) {
    await requireSuperAdmin(db, ctx.userId)
    const data = rawData as { key?: string }
    if (!data.key) {
      throw new HandlerError('MISSING_FIELDS', 'key is required')
    }
    await featureFlagService.clearRollout(data.key, ctx.userId)
    return { success: true, key: data.key }
  }
}

// ── Audit log ────────────────────────────────────────────────────────────────

export function createFeatureFlagsAuditLogHandler(db: Db, featureFlagService: FeatureFlagService) {
  return async function featureFlagsAuditLog(ctx: WsHandlerContext, rawData: unknown) {
    await requireSuperAdmin(db, ctx.userId)
    const data = (rawData ?? {}) as { key?: string; limit?: number }
    if (!data.key || typeof data.key !== 'string') {
      throw new HandlerError('MISSING_FIELDS', 'key is required')
    }
    const limit = Math.min(Math.max(Number(data.limit) || 50, 1), 200)
    const entries = await featureFlagService.getAuditLog(data.key, { limit })
    return { key: data.key, entries }
  }
}
