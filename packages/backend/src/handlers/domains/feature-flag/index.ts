/**
 * Feature Flag domain — registers all feature flag handlers with the router
 *
 * Actions:
 *   featureFlags.list           → List all flags with override counts (super only)
 *   featureFlags.get            → Get resolved values for keys (any auth user)
 *   featureFlags.getAll         → Get all flags resolved for caller's context (any auth user)
 *   featureFlags.update         → Update a flag's default value (super only)
 *   featureFlags.resetDefault   → Reset flag to registry default (super only)
 *   featureFlags.setOverride    → Create/update an override (super only)
 *   featureFlags.deleteOverride → Delete an override (super only)
 *   featureFlags.getOverrides   → List overrides for a flag (super only)
 */

import type { WsRouter } from '../../../ws-framework/WsRouter'
import type { Db } from 'mongodb'
import { UserService } from '../../../auth/user-service'
import { FeatureFlagService } from '../../../services/feature-flag-service'
import type { WorkspaceService } from '../../../services/workspace-service'
import { createListFlagsHandler } from './list'
import { createGetFlagsHandler } from './get'
import { createGetAllFlagsHandler } from './get-all'
import { createUpdateFlagHandler } from './update'
import { createResetDefaultHandler } from './reset-default'
import { createSetOverrideHandler } from './set-override'
import { createDeleteOverrideHandler } from './delete-override'
import { createGetOverridesHandler } from './get-overrides'

export interface FeatureFlagDomainDeps {
  db: Db
  userService?: UserService | null
  workspaceService?: WorkspaceService | null
  featureFlagService?: FeatureFlagService | null
}

export function register(router: WsRouter, deps: FeatureFlagDomainDeps): void {
  const { db } = deps
  const userService = deps.userService ?? new UserService(db)
  const workspaceService = deps.workspaceService ?? undefined
  const featureFlagService = deps.featureFlagService ?? new FeatureFlagService(db)

  // ── Admin-only handlers (super) ──
  router.register('featureFlags.list', createListFlagsHandler(featureFlagService, userService))
  router.register('featureFlags.update', createUpdateFlagHandler(featureFlagService, userService))
  router.register(
    'featureFlags.resetDefault',
    createResetDefaultHandler(featureFlagService, userService),
  )
  router.register('featureFlags.setOverride', createSetOverrideHandler(featureFlagService, userService))
  router.register(
    'featureFlags.deleteOverride',
    createDeleteOverrideHandler(featureFlagService, userService),
  )
  router.register(
    'featureFlags.getOverrides',
    createGetOverridesHandler(featureFlagService, userService),
  )

  // ── Any authenticated user handlers ──
  if (workspaceService) {
    router.register('featureFlags.get', createGetFlagsHandler(featureFlagService, workspaceService))
    router.register(
      'featureFlags.getAll',
      createGetAllFlagsHandler(featureFlagService, workspaceService),
    )
  }
}
