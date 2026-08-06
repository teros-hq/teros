/**
 * Billing domain — user-facing billing actions (billing.*).
 *
 * Distinct from the admin billing handlers (admin.update-billing-subscription
 * etc.): these are scoped to the calling user managing their OWN payment method.
 */

import type { Db } from 'mongodb'
import type { WsRouter } from '../../../ws-framework/WsRouter'
import { UserService } from '../../../auth/user-service'
import type { StripePaymentService } from '../../../services/stripe-payment-service'
import type { BillingEventPublisher } from '../../../services/agent-hours-tracker'
import { createCreateSetupIntentHandler } from './create-setup-intent'
import { createSetPaymentMethodHandler } from './set-payment-method'
import { createRequestAccessHandler } from './request-access'
import { createListPlansHandler } from './list-plans'
import { createGetSubscriptionHandler } from './get-subscription'
import { createGetInvoicesHandler } from './get-invoices'
import { createChangePlanHandler } from './change-plan'
import { createPreviewPlanChangeHandler } from './preview-plan-change'
import { createPurchaseBoostHandler } from './purchase-boost'
import { config } from '../../../config'

export interface BillingDomainDeps {
  db: Db
  userService?: UserService | null
  stripePaymentService: StripePaymentService
  pubSubService?: BillingEventPublisher | null
}

export function register(router: WsRouter, deps: BillingDomainDeps): void {
  const { db, stripePaymentService } = deps
  const userService = deps.userService ?? new UserService(db)

  router.register(
    'billing.create-setup-intent',
    createCreateSetupIntentHandler(userService, stripePaymentService),
  )
  router.register('billing.set-payment-method', createSetPaymentMethodHandler(stripePaymentService))
  // Request-access flow (FASE 6): user asks for a boost / upgrade when blocked.
  router.register(
    'billing.request-access',
    createRequestAccessHandler(db, userService, deps.pubSubService ?? null),
  )

  // Self-serve plan management (TER-596 I1): the catalogue, the user's own
  // subscription + invoices, and self-serve plan changes.
  router.register('billing.list-plans', createListPlansHandler(db))
  router.register(
    'billing.get-subscription',
    createGetSubscriptionHandler(
      db,
      stripePaymentService.isEnabled() ? stripePaymentService : null,
      { boostHourPrice: config.billing.boostHourPrice, boostCurrency: config.billing.boostCurrency },
    ),
  )
  router.register('billing.get-invoices', createGetInvoicesHandler(db))
  // Read-only preview of a plan change (prorated charge / deferral) before commit.
  router.register('billing.preview-plan-change', createPreviewPlanChangeHandler(db))
  router.register(
    'billing.change-plan',
    createChangePlanHandler(db, stripePaymentService.isEnabled() ? stripePaymentService : null),
  )
  // Self-serve boost purchase (charges the vaulted payment method). Disabled
  // (PURCHASE_DISABLED) until BILLING_BOOST_HOUR_PRICE is configured.
  router.register(
    'billing.purchase-boost',
    createPurchaseBoostHandler(
      db,
      stripePaymentService.isEnabled() ? stripePaymentService : null,
      { boostHourPrice: config.billing.boostHourPrice, boostCurrency: config.billing.boostCurrency },
    ),
  )
}
