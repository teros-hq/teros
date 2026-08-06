/**
 * Admin domain — registers all admin handlers with the router
 *
 * Actions:
 *   admin.list-users          → Paginated/searchable list of users (admin only)
 *   admin.get-user            → Get detailed user info (admin only)
 *   admin.get-user-detail     → Expensive per-user enrichment for expanded card (admin only)
 *   admin.update-user-role    → Update a user's role (super only)
 *   admin.update-user-status  → Update a user's status (admin only)
 *   admin.grant-access        → Grant platform access to a user (admin only)
 *   admin.impersonate         → Start impersonating a user (super only)
 *   admin.stop-impersonation  → Stop impersonating and restore admin session (super only)
 */

import type { WsRouter } from '../../../ws-framework/WsRouter'
import type { Db } from 'mongodb'
import { UserService } from '../../../auth/user-service'
import { IdentityService } from '../../../auth/identity-service'
import { SessionService } from '../../../auth/session-service'

import { createListUsersHandler } from './list-users'
import { createGetUserHandler } from './get-user'
import { createGetUserDetailHandler } from './get-user-detail'
import { createUpdateUserRoleHandler } from './update-user-role'
import { createUpdateUserStatusHandler } from './update-user-status'
import { createGrantAccessHandler } from './grant-access'
import { createImpersonateHandler, createStopImpersonationHandler } from './impersonate'
import { createUpdateBillingSubscriptionHandler } from './update-billing-subscription'
import { createAdminListPlansHandler } from './list-plans'
import { createGetBillingAuditHandler } from './get-billing-audit'
import { createListAccessRequestsHandler } from './list-access-requests'
import { createResolveAccessRequestHandler } from './resolve-access-request'
import { createGrantHourBoostHandler } from './grant-hour-boost'
import { createRevokeHourBoostHandler } from './revoke-hour-boost'
import {
  createListTerosProviderConfigsHandler,
  createCreateTerosProviderConfigHandler,
  createUpdateTerosProviderConfigHandler,
  createDeleteTerosProviderConfigHandler,
} from './teros-provider-configs'
import {
  createListBillingTeamsHandler,
  createGetTeamMembersHandler,
  createCreateBillingTeamHandler,
  createUpdateBillingTeamHandler,
  createDeleteBillingTeamHandler,
} from './billing-teams'
import { config } from '../../../config'

export interface AdminDomainDeps {
  db: Db
  userService?: UserService | null
  identityService?: IdentityService | null
  sessionService?: SessionService | null
  stripePaymentService?: import('../../../services/stripe-payment-service').StripePaymentService | null
  pubSubService?: import('../../../services/agent-hours-tracker').BillingEventPublisher | null
}

export function register(router: WsRouter, deps: AdminDomainDeps): void {
  const { db } = deps
  const userService = deps.userService ?? new UserService(db)
  const identityService = deps.identityService ?? new IdentityService(db)
  const sessionService = deps.sessionService ?? new SessionService(db)

  // User management (admin/super only)
  router.register('admin.list-users', createListUsersHandler(userService, db))
  router.register('admin.get-user', createGetUserHandler(userService, db))
  router.register('admin.get-user-detail', createGetUserDetailHandler(userService, db))
  router.register('admin.update-user-role', createUpdateUserRoleHandler(userService))
  router.register('admin.update-user-status', createUpdateUserStatusHandler(userService))
  router.register('admin.grant-access', createGrantAccessHandler(userService))

  // Billing subscription management (admin only)
  router.register(
    'admin.update-billing-subscription',
    createUpdateBillingSubscriptionHandler(userService, db, deps.stripePaymentService ?? null),
  )
  // Full plan catalogue (incl. hidden internal tiers) for the admin plan picker.
  router.register('admin.list-plans', createAdminListPlansHandler(userService, db))
  router.register('admin.get-billing-audit', createGetBillingAuditHandler(userService, db))

  // Request-access queue (FASE 6): admins list + approve/deny boost/upgrade.
  // The queue carries the requester's billing context + estimated boost value
  // (TER-596 A1), so it needs the same boost pricing config as purchase-boost.
  router.register(
    'admin.list-access-requests',
    createListAccessRequestsHandler(userService, db, {
      boostHourPrice: config.billing.boostHourPrice,
      boostCurrency: config.billing.boostCurrency,
    }),
  )
  router.register(
    'admin.resolve-access-request',
    createResolveAccessRequestHandler(
      userService,
      db,
      deps.pubSubService ?? null,
      deps.stripePaymentService ?? null,
    ),
  )
  // Direct admin grant/revoke of period hour boosts (TER-686) — no prior user
  // request. Reuses the same BillingHourBoost mechanism; expires at rollover.
  router.register(
    'admin.grant-hour-boost',
    createGrantHourBoostHandler(userService, db, deps.pubSubService ?? null),
  )
  router.register(
    'admin.revoke-hour-boost',
    createRevokeHourBoostHandler(userService, db, deps.pubSubService ?? null),
  )

  // Billing team management (admin only)
  router.register(
    'admin.list-billing-teams',
    createListBillingTeamsHandler(userService, db),
  )
  router.register(
    'admin.get-team-members',
    createGetTeamMembersHandler(userService, db),
  )
  router.register(
    'admin.create-billing-team',
    createCreateBillingTeamHandler(userService, db),
  )
  router.register(
    'admin.update-billing-team',
    createUpdateBillingTeamHandler(userService, db),
  )
  router.register(
    'admin.delete-billing-team',
    createDeleteBillingTeamHandler(userService, db),
  )

  // Teros provider config management (admin only)
  router.register(
    'admin.list-teros-provider-configs',
    createListTerosProviderConfigsHandler(userService, db),
  )
  router.register(
    'admin.create-teros-provider-config',
    createCreateTerosProviderConfigHandler(userService, db),
  )
  router.register(
    'admin.update-teros-provider-config',
    createUpdateTerosProviderConfigHandler(userService, db),
  )
  router.register(
    'admin.delete-teros-provider-config',
    createDeleteTerosProviderConfigHandler(userService, db),
  )

  // Impersonation (super only)
  router.register(
    'admin.impersonate',
    createImpersonateHandler(userService, identityService, sessionService),
  )
  router.register(
    'admin.stop-impersonation',
    createStopImpersonationHandler(userService, sessionService),
  )
}
