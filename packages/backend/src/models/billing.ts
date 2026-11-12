/**
 * Billing Model
 *
 * MongoDB collections for subscription billing:
 *   - billing_plans:     Base plan templates (seeded, rarely change)
 *   - billing_subscriptions: Per-user subscriptions with overrides
 *
 * Follows the same pattern as channel-subscriptions.ts:
 *   - Types + collection helpers + index ensure + seed data + helpers
 */

import type { Collection, Db } from 'mongodb'
import { DEFAULT_TEROS_SIZES, type TerosFailoverSetting, type TerosSize, type TerosSizeRoutes } from './providers/teros.js'
import { COLLECTIONS, ensureIndexesFor } from '../db'
import { encrypt } from '../auth/encryption'
import { isMongoDuplicateKey } from '../lib/mongo-errors'
import { secrets } from '../secrets/secrets-manager'

// ============================================================================
// TYPES
// ============================================================================

export interface BillingPlan {
  /** Primary key — human-readable, e.g. "plan_starter" */
  _id: string

  name: string
  displayName: string
  description: string

  // Pricing
  price: number
  currency: string

  // Consumo
  agentHoursLimit: number

  /**
   * Automate executions (any trigger kind) a subscriber may run per UTC day.
   * 0 or absent ⇒ unmetered. Enforced by AutomateQuotaService; counted per
   * starter creator (`automate_executions.createdBy`), not per workspace.
   */
  automateDailyExecutionLimit?: number

  // Features (feature-gating)
  features: {
    byok: boolean
    terosModel: boolean
    unlimitedAgents: boolean
    maxWorkspaces: number
    prioritySupport: boolean
  }

  // Visibilidad
  isPublic: boolean

  // ── Catalog display (TER-596) — optional + additive, retrocompat ──
  /** Post-beta price, shown as "then €X/mo" while `price` holds the beta price. */
  postBetaPrice?: number
  /** Highlight bullets for the plan card (onboarding selection + profile). */
  highlights?: string[]
  /** Marks the recommended plan (renders a "Popular" badge). */
  popular?: boolean
  /** Not self-serve: the card shows a "Contact sales" CTA instead of checkout. */
  contactSales?: boolean

  // Metadata
  createdAt: Date
  updatedAt: Date
}

export interface BillingSubscription {
  /** MongoDB ObjectId */
  _id: string

  userId: string
  planId: string

  // Overrides individuales
  customAgentHoursLimit: number | null
  customPrice: number | null
  customPriceNote: string | null
  /** Per-subscription override of plan.automateDailyExecutionLimit (0 ⇒ unmetered). Optional, admin-set. */
  customAutomateDailyExecutionLimit?: number | null

  // Consumo (ciclo actual)
  agentHoursUsed: number
  overageHours: number

  /**
   * Greatest hourBucket already billed into agentHoursUsed by the
   * agent-hours-tracker. Idempotency cursor — absent means "never billed".
   */
  lastBilledHourBucket?: Date

  /**
   * The value of lastBilledHourBucket at the START of THIS period — i.e. the
   * point from which the tracker began accumulating agentHoursUsed this period.
   * The reset-cron keeps lastBilledHourBucket across a renewal (monotonic
   * high-water mark), so it does NOT line up with currentPeriodStart; the
   * reconciliation cron must re-sum from THIS anchor, not currentPeriodStart, or
   * the unbilled tail of the previous period shows up as spurious drift (TER-627).
   * Absent on legacy/new subs → reconcile falls back to currentPeriodStart.
   */
  periodStartBucket?: Date

  // Ciclo de facturación
  currentPeriodStart: Date
  currentPeriodEnd: Date

  // Estado. 'ended' = a closed historical subscription (plan change or
  // cancellation). At most ONE 'active' sub per user (partial unique index
  // billing_sub_one_active). The active sub is resolved via getActiveSubscription.
  status: 'active' | 'paused' | 'cancelled' | 'past_due' | 'ended'

  /** When this subscription became the user's active one. */
  startDate?: Date
  /** When this subscription was closed (status:'ended'); null/absent = open. */
  endDate?: Date | null

  /**
   * Set by a cancellation: the sub keeps running (and granting its tier) until
   * currentPeriodEnd, then the billing-reset-cron closes it (status:'ended')
   * and opens a fresh starter sub instead of renewing. Stripe cancel_at_period_end.
   */
  cancelAtPeriodEnd?: boolean

  /**
   * A deferred downgrade (decision A/D): the user (or an admin) picked a CHEAPER
   * plan, but it only takes effect at currentPeriodEnd — they keep the paid tier
   * until then. At the cut, billing-reset-cron closes this sub and opens the
   * scheduled plan instead of renewing. Mirrors cancelAtPeriodEnd. Null/absent =
   * no pending downgrade. Upgrades are NOT deferred — they apply immediately with
   * a prorated charge (changeUserPlanImmediate).
   */
  scheduledPlanChange?: { planId: string; scheduledAt: Date } | null

  /**
   * Set by billing-reset-cron while it rewrites this sub's period, so the
   * agent-hours-tracker skips it (mutual exclusion — they run as separate crons
   * under separate leader locks and can overlap). `resettingAt` lets a later
   * run re-claim a sub abandoned by a crashed reset (see RESETTING_STALE_MS).
   */
  resetting?: boolean
  resettingAt?: Date

  /**
   * When the agent-hours-tracker emitted the 80%-consumption warning for the
   * CURRENT period (decision #11). Idempotency flag — the tracker emits the
   * warning at most once per period and the billing-reset-cron clears it on
   * renewal so the next period can warn again. Absent = not warned yet.
   */
  warned80At?: Date | null

  // Método de pago (Fase 1: manual siempre. Fase 2: stripe automático)
  paymentMethod: 'stripe' | 'manual'

  // Notas libres para el equipo Teros
  billingNotes: string

  // Teros provider config assignment (per-user, null = use default)
  terosProviderConfigId?: string | null

  // Team billing reference — for consolidated invoicing and per-seat pricing.
  // Hours are always tracked individually on this subscription.
  teamId?: string | null

  // Metadata
  createdAt: Date
  updatedAt: Date
}

export interface TerosProviderConfig {
  /** Primary key — human-readable, e.g. "cfg_default" */
  _id: string

  name: string

  /** Fireworks API key encrypted with the system encryption key (legacy; runtime routing uses system secrets). */
  fireworksApiKey: string

  /** Exactly one config must have isDefault: true */
  isDefault: boolean

  /**
   * Per-size upstream routes, one per latency lane (TPROV-REQ-4, TLANE-REQ-5).
   * Written by migrations 20261103_001 / 20261109_001 and the admin window.
   * @spec TLANE-REQ-5
   */
  sizes: Record<TerosSize, TerosSizeRoutes>
  /** Failover policy for every size (TPROV-REQ-6). */
  failover: TerosFailoverSetting

  // Metadata
  createdAt: Date
  updatedAt: Date
}

export interface BillingTeam {
  /** Primary key — human-readable, e.g. "team_acme" */
  _id: string

  name: string
  slug: string

  planId: string           // from billing_plans — for group pricing/discounts
  /**
   * Effective per-seat price = customSeatPrice ?? plan.price. Stored so invoicing
   * reads one number; recomputed by the handlers on plan/override change.
   */
  seatPrice: number
  /**
   * Manual per-seat price override negotiated by sales (decision E). Null/absent
   * = use the plan's price. FASE 7's automatic volume discount was CANCELLED — a
   * team's price is set by hand here, not derived from seatCount.
   */
  customSeatPrice?: number | null
  seatCount: number
  maxSeats: number

  status: 'active' | 'paused' | 'cancelled'

  paymentMethod: 'stripe' | 'manual' | 'transfer'
  billingEmail: string

  terosProviderConfigId?: string | null

  ownerId: string         // Teros admin userId
  memberIds: string[]     // userIds

  createdAt: Date
  updatedAt: Date
}

export interface BillingInvoice {
  /** MongoDB ObjectId */
  _id: string

  subscriptionId: string
  userId: string

  /**
   * Discriminates a recurring SUBSCRIPTION/period invoice (created by the
   * billing-reset-cron, one per billing period) from one-off invoices: a
   * BOOST-purchase (billing.purchase-boost) or a PRORATION charge for an
   * immediate self-serve plan upgrade (billing.change-plan), both keyed by their
   * derived purchaseId _id. Absent on legacy rows = 'subscription' (backfilled by
   * migration 20260623_001). The billing_inv_period_unique index is PARTIAL on
   * kind:'subscription' so multiple one-off invoices can share a period without
   * colliding with the period invoice nor with each other (TER-596 I1; TER-619).
   */
  kind?: 'subscription' | 'boost' | 'proration'

  // Periodo facturado
  periodStart: Date
  periodEnd: Date

  // Importe COTIZADO (line item, lo que se le prometió al usuario).
  amount: number
  currency: string
  /**
   * Importe REALMENTE cobrado por Stripe (whole units), reconciliado desde
   * `amount_paid` tras el cobro. En el happy-path con el guard de `chargeInvoice`
   * coincide con `amount`; solo diverge en un sobrecobro histórico (daño previo) o
   * un crédito — que es exactamente lo que reconciliación debe ver. Ausente hasta
   * que se cobra vía Stripe.
   */
  amountCharged?: number

  // Estado de pago.
  //   pending       — created by the reset-cron, not yet handed to Stripe.
  //   invoiced      — a Stripe Invoice was created/finalized for it.
  //   paid          — collected (Stripe charge succeeded, or marked paid manually).
  //   overdue       — a charge attempt failed; in the dunning retry/grace window.
  //   uncollectible — dunning grace exhausted; the sub was degraded to starter.
  //   held          — the charge guard refused it (amount would diverge from the
  //                   quote, e.g. a swept balance). NOT the user's fault: no dunning,
  //                   no account block; surfaced to ops until remediated.
  //   waived        — never charged (€0 BETA period, manual/transfer write-off).
  //   refunded      — Stripe refunded the full charge (charge.refunded webhook).
  status: 'pending' | 'invoiced' | 'paid' | 'waived' | 'overdue' | 'uncollectible' | 'held' | 'refunded'

  /** Amount Stripe refunded so far (whole units), from charge.refunded. */
  refundedAmount?: number
  refundedAt?: Date | null

  // Método de pago usado
  paymentMethod: 'stripe' | 'manual' | 'transfer' | 'other'

  // Referencias externas.
  // For Stripe-charged invoices: invoiceNumber holds Stripe's legal sequential
  // number (e.g. "TEROS-0001"), externalReference holds the Stripe invoice id
  // (in_…). These are the source of legal numbering + PDF (Stripe-issued).
  invoiceNumber: string | null
  externalReference: string | null
  /** Stripe-hosted invoice page (pay + view); null until charged via Stripe. */
  hostedInvoiceUrl?: string | null
  /** Stripe-hosted PDF of the finalized invoice; null until charged via Stripe. */
  invoicePdfUrl?: string | null

  // ── Dunning state (FASE 4) ────────────────────────────────────────────────
  /** Number of charge attempts made by the billing-charge-cron. */
  attemptCount?: number
  /** When the most recent charge attempt ran. */
  lastAttemptAt?: Date | null
  /**
   * Earliest time the charge-cron may attempt (retry) this invoice again.
   * Absent = chargeable now. Set on each failed attempt (backoff schedule).
   */
  nextAttemptAt?: Date | null
  /**
   * When the dunning grace window ends (set on first failure = createdAt +
   * graceDays, decision #13). After this, an unpaid invoice is marked
   * 'uncollectible' and its subscription is degraded to starter.
   */
  gracePeriodEndsAt?: Date | null
  /** Classified code of the last charge failure (e.g. CARD_DECLINED). */
  lastChargeError?: string | null

  // Notas libres
  notes: string

  // Metadata
  createdAt: Date
  updatedAt: Date
}

/**
 * Per-user mapping to a Stripe Customer (FASE 4, Model B — Teros stays the
 * source of truth, Stripe is the payment rail). One Stripe customer per Teros
 * user, reused across the user's subscription history. Holds the vaulted
 * default payment method and the tax location used for Stripe Tax
 * (IVA / B2B reverse-charge).
 */
export interface BillingCustomer {
  /** Primary key = userId (exactly one Stripe customer per user). */
  _id: string

  userId: string

  /** Stripe customer id (cus_…). */
  stripeCustomerId: string

  /** Vaulted default payment method id (pm_…); null until the user adds one. */
  defaultPaymentMethodId: string | null

  /** ISO-3166-1 alpha-2 country, drives Stripe Tax. Null = not collected yet. */
  country: string | null
  /** VAT / tax id for B2B reverse-charge (EU). Null = none / B2C. */
  taxId: string | null
  /** Stripe tax id type (e.g. 'eu_vat'); paired with taxId. */
  taxIdType: string | null

  createdAt: Date
  updatedAt: Date
}

/**
 * Append-only ledger of every hour-billing commit the agent-hours-tracker makes
 * into a subscription's agentHoursUsed. Written BEFORE the $inc so the audit
 * trail never misses a billed range, and keyed by (subscriptionId, hourBucket)
 * so a tracker re-run cannot duplicate an entry. Explains, line by line, how
 * agentHoursUsed reached its value — the source for admin.get-billing-audit.
 */
export interface BillingHourLedgerEntry {
  /** MongoDB string UUID */
  _id: string

  subscriptionId: string
  userId: string

  /**
   * The greatest hourBucket summed in this commit — also the tracker's new
   * cursor (lastBilledHourBucket). Unique per subscription: the structural
   * guard that makes a duplicate ledger entry impossible by construction.
   */
  hourBucket: Date

  /** Previous cursor; exclusive lower bound of the summed range. Null = from epoch. */
  fromHourBucket: Date | null

  /**
   * Hours added to agentHoursUsed in this commit (summed billed ms / 3.6e6 —
   * userWorkMs with userActiveMs fallback, decision #29).
   */
  hoursAdded: number

  /** agentHoursUsed AFTER this commit (expected value once the $inc lands). */
  cumulative: number

  /** Number of rollups summed in the (fromHourBucket, hourBucket] range. */
  rollupCount: number

  /**
   * Rollup _ids summed, capped at LEDGER_MAX_ROLLUP_IDS. When rollupCount
   * exceeds the cap (e.g. first tick after deploy summing months of TTL-retained
   * rollups) the array is truncated — re-query agent_usage_rollups_user_hourly
   * by (userId, fromHourBucket, hourBucket] for the full breakdown.
   */
  rollupIds: string[]

  /** Id of the tracker run that wrote this entry (groups one tick's entries). */
  trackerRunId: string

  createdAt: Date
}

/**
 * Cap on rollupIds[] stored per ledger entry. Steady-state ticks sum 1-2
 * buckets; this only bites on a backfill tick. rollupCount is always exact.
 */
export const LEDGER_MAX_ROLLUP_IDS = 500

/**
 * Append-only snapshot of a subscription's consumption at period close, taken
 * by the billing-reset-cron BEFORE it zeroes agentHoursUsed. Lets the team
 * explain a past period ("user consumed Y of Z hours in period P") even though
 * the live counter has been reset. Keyed by the same (subscriptionId,
 * periodStart, periodEnd) as the invoice, so a re-run never duplicates it.
 */
export interface BillingPeriodSnapshot {
  /** MongoDB string UUID */
  _id: string

  subscriptionId: string
  userId: string
  planId: string

  periodStart: Date
  periodEnd: Date

  /** Consumption at close, before the reset zeroed it. */
  agentHoursUsed: number
  /** Effective limit in force during the period (custom override or plan default). */
  agentHoursLimit: number
  overageHours: number

  /** The invoice created for this period, if the cron created/found one. */
  invoiceId: string | null

  createdAt: Date
}

/**
 * A user's request to keep using the Teros model after hitting (or approaching)
 * their agent-hours limit (decision #10). Two kinds:
 *   - 'upgrade': move to a higher plan (admin approval applies the plan change
 *     immediately, reusing the day+1 change flow — decision #6).
 *   - 'boost':   grant `requestedHours` extra hours on the CURRENT period only
 *     (admin approval creates a BillingHourBoost).
 *
 * At most one PENDING request per (userId, type) — enforced by the partial
 * unique index billing_access_req_one_pending so a blocked user cannot spam.
 */
export interface BillingAccessRequest {
  /** MongoDB string UUID */
  _id: string

  userId: string
  /** The active subscription at request time (the one being unblocked). */
  subscriptionId: string

  type: 'upgrade' | 'boost'

  /** For 'boost': extra hours requested (> 0). Null for 'upgrade'. */
  requestedHours: number | null
  /** For 'upgrade': the target plan _id. Null for 'boost'. */
  requestedPlanId: string | null
  /** Optional free-text justification from the user. */
  reason: string | null

  status: 'pending' | 'approved' | 'denied'

  /** Admin userId that resolved it; null while pending. */
  resolvedBy: string | null
  resolvedAt: Date | null
  /** Admin's free-text note on resolution; null while pending. */
  resolutionNote: string | null
  /** For an approved 'boost': the BillingHourBoost created. Null otherwise. */
  boostId: string | null

  createdAt: Date
  updatedAt: Date
}

/**
 * Extra agent-hours granted to a subscription for a SINGLE billing period
 * (decision #10, boost path). Summed into the effective limit by
 * getActiveBoostHours while `status:'active'` and `now` falls within
 * [periodStart, periodEnd). The billing-reset-cron expires a period's boosts on
 * renewal, so a boost never leaks into the next cycle. Append-only audit trail.
 *
 * A boost has exactly ONE of two origins, each with its own idempotency guard:
 *   - admin grant (request-access approval): `accessRequestId` is set, keyed
 *     uniquely by a PARTIAL unique index so approving the same request twice
 *     cannot mint a second boost. `_id` is a random UUID.
 *   - self-serve purchase (billing.purchase-boost): `accessRequestId` is null and
 *     `_id` IS the stable purchaseId (`boost-purchase:<userId>:<reqId>`). The
 *     primary key itself is the idempotency guard, so a re-submit with the same
 *     reqId cannot create (or pay for) a second boost.
 */
/**
 * Origin of a boost. Explicit discriminator (TER-686) so a direct admin grant
 * (accessRequestId: null, like a purchase) is not mislabelled as a purchase in
 * the audit. Optional/additive — legacy rows lack it and are inferred from
 * accessRequestId (non-null → 'access_request', null → 'purchase').
 */
export type BillingHourBoostSource = 'access_request' | 'purchase' | 'admin_grant'

export interface BillingHourBoost {
  /**
   * Admin grants: `admin-grant:<userId>:<idempotencyKey>` (direct) or a random
   * UUID (via an access request). Purchases: the stable purchaseId
   * `boost-purchase:<userId>:<reqId>` — the PK is the purchase idempotency key.
   */
  _id: string

  userId: string
  subscriptionId: string

  /** Extra hours added to the effective limit while active (> 0). */
  hours: number

  /** Period this boost applies to — copied from the sub at grant time. */
  periodStart: Date
  periodEnd: Date

  status: 'active' | 'expired' | 'revoked'

  /** Admin userId for a grant; the buyer's own userId for a purchase. */
  grantedBy: string
  /**
   * The access request this grant resolved (partial-unique — idempotent
   * approval). Null for self-serve purchases and direct admin grants (whose
   * `_id` is the idempotency key instead).
   */
  accessRequestId: string | null

  /** Origin discriminator (additive; see BillingHourBoostSource). */
  source?: BillingHourBoostSource
  /** Optional admin note/reason for a direct grant. */
  note?: string | null

  /** Set when an admin revokes the boost (audit trail). */
  revokedBy?: string
  revokedAt?: Date

  createdAt: Date
}

// ============================================================================
// COLLECTION HELPERS
// ============================================================================

export function getBillingPlansCollection(db: Db): Collection<BillingPlan> {
  return db.collection<BillingPlan>('billing_plans')
}

export function getBillingHourLedgerCollection(db: Db): Collection<BillingHourLedgerEntry> {
  return db.collection<BillingHourLedgerEntry>('billing_hour_ledger')
}

export function getBillingPeriodSnapshotsCollection(db: Db): Collection<BillingPeriodSnapshot> {
  return db.collection<BillingPeriodSnapshot>('billing_period_snapshots')
}

export function getBillingSubscriptionsCollection(db: Db): Collection<BillingSubscription> {
  return db.collection<BillingSubscription>('billing_subscriptions')
}

export function getBillingInvoicesCollection(db: Db): Collection<BillingInvoice> {
  return db.collection<BillingInvoice>('billing_invoices')
}

export function getTerosProviderConfigsCollection(db: Db): Collection<TerosProviderConfig> {
  return db.collection<TerosProviderConfig>('teros_provider_configs')
}

export function getBillingTeamsCollection(db: Db): Collection<BillingTeam> {
  return db.collection<BillingTeam>('billing_teams')
}

export function getBillingCustomersCollection(db: Db): Collection<BillingCustomer> {
  return db.collection<BillingCustomer>('billing_customers')
}

export function getBillingAccessRequestsCollection(db: Db): Collection<BillingAccessRequest> {
  return db.collection<BillingAccessRequest>('billing_access_requests')
}

export function getBillingHourBoostsCollection(db: Db): Collection<BillingHourBoost> {
  return db.collection<BillingHourBoost>('billing_hour_boosts')
}

/** Upper sanity bound on a single boost grant/purchase (hours). */
export const MAX_BOOST_HOURS = 10000

/** Fields the caller supplies to insertHourBoost (status is forced to 'active'). */
export type HourBoostInput = Omit<BillingHourBoost, 'status' | 'revokedBy' | 'revokedAt'>

/**
 * Insert a boost idempotently — the single write path shared by admin approvals,
 * self-serve purchases, and direct admin grants (TER-686 DRY). On a duplicate key
 * it re-reads the existing boost: by `accessRequestId` when set (the partial-unique
 * index, used by access-request approvals) or by `_id` (the PK idempotency key used
 * by purchases and direct grants). Returns the persisted boost + whether it was a
 * dedupe hit.
 */
export async function insertHourBoost(
  db: Db,
  input: HourBoostInput,
): Promise<{ boost: BillingHourBoost; boostId: string; deduped: boolean }> {
  const boost: BillingHourBoost = { ...input, status: 'active' }
  const col = getBillingHourBoostsCollection(db)
  try {
    await col.insertOne(boost)
    return { boost, boostId: boost._id, deduped: false }
  } catch (err) {
    if (!isMongoDuplicateKey(err)) throw err
    const existing =
      input.accessRequestId !== null
        ? await col.findOne({ accessRequestId: input.accessRequestId })
        : await col.findOne({ _id: input._id })
    return { boost: existing ?? boost, boostId: existing?._id ?? input._id, deduped: true }
  }
}

// ============================================================================
// INDEXES
// ============================================================================

/**
 * Re-exported from src/db/indexes.ts (GOV-4), where the registry uses it for
 * the entries marked `heal` (billing_inv_period_unique, billing_boost_request_unique).
 */
export { createIndexHealingConflict } from '../db/indexes'

/**
 * Billing indexes are declared in src/db/indexes.ts (GOV-4); boot applies the
 * whole registry with ensureAllIndexes after migrations. Kept for tests and scripts.
 */
export async function ensureBillingIndexes(db: Db): Promise<void> {
  await ensureIndexesFor(db, [
    COLLECTIONS.billingSubscriptions,
    COLLECTIONS.billingInvoices,
    COLLECTIONS.billingHourLedger,
    COLLECTIONS.billingPeriodSnapshots,
    COLLECTIONS.terosProviderConfigs,
    COLLECTIONS.billingTeams,
    COLLECTIONS.billingCustomers,
    COLLECTIONS.billingAccessRequests,
    COLLECTIONS.billingHourBoosts,
  ])
}

// ============================================================================
// SEED DATA (Fase 1)
// ============================================================================

/**
 * The free entry-tier plan id. It is the floor a user falls back to: with no
 * active subscription, after a cancellation matures, or when an admin clears a
 * plan. Centralised in ONE constant so the "entry plan" is never a string
 * scattered across the gate, the reset-cron and the admin handler — a planId
 * carries meaning, and a silent rename would break code at a distance
 * (see CLAUDE.md "Evitar bugs por cambio de significado").
 */
export const DEFAULT_PLAN_ID = 'plan_seed'

/**
 * planIds retired by the TER-596 catalogue reconciliation → their successor.
 * The reconciliation migration uses this to remap any subscription still
 * pointing at a dead id. `plan_pro` is NOT here: it is reused (its data is
 * updated in place to the web "Pro" tier — 80h/€179).
 */
export const RETIRED_PLAN_REMAP: Record<string, string> = {
  plan_basic: DEFAULT_PLAN_ID,
  plan_max: 'plan_ultra',
  plan_infinity: 'plan_enterprise',
}

/**
 * Automate executions per UTC day by plan (0 ⇒ unmetered). One table shared
 * by the seed catalogue and the migration that stamps existing plan docs, so
 * the numbers can never drift between the two. Rationale: a per-minute cron
 * on a free tier burns tokens and hurts platform stability without the user
 * noticing; the cap scales with the tier the same way agent-hours do.
 */
export const AUTOMATE_DAILY_EXECUTION_LIMITS: Record<string, number> = {
  plan_seed: 5,
  plan_starter: 20,
  plan_growth: 50,
  plan_pro: 100,
  plan_ultra: 200,
  plan_enterprise: 0,
}

/**
 * Canonical plan catalogue — the public tiers mirror the public pricing page
 * (teros.ai). Seed is the free entry tier (0€/2h), followed by Starter (€19/8h),
 * Growth (€89/40h), Pro (€159/80h) and Ultra (€349/200h).
 * Enterprise is unmetered (agentHoursLimit 0 + terosModel true → the gate treats
 * it as unlimited) and not self-serve (contactSales).
 *
 * The former hidden internal tier (plan_unlimited) was retired by migration
 * 20261009_001 (subscriptions moved to plan_pro, plan doc deleted), so it is
 * deliberately NOT seeded here. Hidden tiers (isPublic:false) remain supported
 * generically by the admin and self-serve paths.
 */
export const BILLING_PLANS_SEED: Omit<BillingPlan, 'createdAt' | 'updatedAt'>[] = [
  {
    // Free entry tier — the plan every user lands on by default (signup, after a
    // cancellation matures, admin clear). Named 'seed' not 'free' so the id stays
    // meaningful if the tier ever stops being free.
    _id: DEFAULT_PLAN_ID,
    name: 'seed',
    displayName: 'Seed',
    description: 'Try Teros with no commitment. 2 agent-hours/month.',
    price: 0,
    currency: 'EUR',
    agentHoursLimit: 2,
    automateDailyExecutionLimit: AUTOMATE_DAILY_EXECUTION_LIMITS.plan_seed,
    features: { byok: true, terosModel: true, unlimitedAgents: true, maxWorkspaces: -1, prioritySupport: false },
    highlights: ['2 agent-hours / month', 'Unlimited integrations, agents & workspaces', 'On-demand containers', 'Bring your own AI key', 'Email support'],
    isPublic: true,
  },
  {
    _id: 'plan_starter',
    name: 'starter',
    displayName: 'Starter',
    description: 'To start automating your work. 8 agent-hours/month.',
    price: 19,
    currency: 'EUR',
    agentHoursLimit: 8,
    automateDailyExecutionLimit: AUTOMATE_DAILY_EXECUTION_LIMITS.plan_starter,
    features: { byok: true, terosModel: true, unlimitedAgents: true, maxWorkspaces: -1, prioritySupport: false },
    highlights: ['Everything in Seed', '8 agent-hours / month', 'AI provider included', 'Email support'],
    isPublic: true,
  },
  {
    _id: 'plan_growth',
    name: 'growth',
    displayName: 'Growth',
    description: 'For professionals who need more agentic hours. 40 agent-hours/month.',
    price: 89,
    currency: 'EUR',
    agentHoursLimit: 40,
    automateDailyExecutionLimit: AUTOMATE_DAILY_EXECUTION_LIMITS.plan_growth,
    features: { byok: true, terosModel: true, unlimitedAgents: true, maxWorkspaces: -1, prioritySupport: true },
    highlights: ['Everything in Starter', '40 agent-hours / month', 'AI provider included', 'Always-on containers (24/7)', 'Webhooks & scheduled triggers', 'Priority support'],
    popular: true,
    isPublic: true,
  },
  {
    _id: 'plan_pro',
    name: 'pro',
    displayName: 'Pro',
    description: 'For teams working with multiple agents. 80 agent-hours/month.',
    price: 159,
    currency: 'EUR',
    agentHoursLimit: 80,
    automateDailyExecutionLimit: AUTOMATE_DAILY_EXECUTION_LIMITS.plan_pro,
    features: { byok: true, terosModel: true, unlimitedAgents: true, maxWorkspaces: -1, prioritySupport: true },
    highlights: ['Everything in Growth', '80 agent-hours / month', 'Multiple concurrent agents', 'Agent guardrails & audit logs', 'SSO and role-based access', 'Dedicated support with SLA'],
    isPublic: true,
  },
  {
    _id: 'plan_ultra',
    name: 'ultra',
    displayName: 'Ultra',
    description: '200 agent-hours/month on dedicated infrastructure.',
    price: 349,
    currency: 'EUR',
    agentHoursLimit: 200,
    automateDailyExecutionLimit: AUTOMATE_DAILY_EXECUTION_LIMITS.plan_ultra,
    features: { byok: true, terosModel: true, unlimitedAgents: true, maxWorkspaces: -1, prioritySupport: true },
    highlights: ['Everything in Pro', '200 agent-hours / month', 'Dedicated infrastructure', 'Custom contracts', 'Advanced security & compliance', 'White-glove onboarding'],
    isPublic: true,
  },
  {
    _id: 'plan_enterprise',
    name: 'enterprise',
    displayName: 'Enterprise',
    description: 'Unlimited agent time for teams & companies. Contact sales.',
    price: 0,            // Custom pricing — contact sales.
    currency: 'EUR',
    agentHoursLimit: 0,  // 0 + terosModel:true ⇒ unmetered (unlimited) in the gate.
    automateDailyExecutionLimit: AUTOMATE_DAILY_EXECUTION_LIMITS.plan_enterprise,
    features: { byok: true, terosModel: true, unlimitedAgents: true, maxWorkspaces: -1, prioritySupport: true },
    highlights: ['Everything in Ultra', 'Unlimited agent time', 'SOC-2 ready', 'On-premise or private cloud', 'Dedicated account manager'],
    contactSales: true,
    isPublic: true,
  },
]

// ============================================================================
// SEED FUNCTION
// ============================================================================

/**
 * Insert any canonical plan from BILLING_PLANS_SEED that is missing
 * ($setOnInsert — existing plan docs are never overwritten). Safe to run on
 * every startup (idempotent). Only seeded ids can be (re)created, so a plan
 * retired by a migration must also be dropped from the seed.
 */
export async function seedBillingPlans(db: Db): Promise<void> {
  const col = getBillingPlansCollection(db)
  const now = new Date()

  for (const plan of BILLING_PLANS_SEED) {
    await col.updateOne(
      { _id: plan._id },
      {
        $setOnInsert: {
          ...plan,
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true },
    )
  }

  console.log(`[Billing] Seeded ${BILLING_PLANS_SEED.length} billing plans`)
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Add `months` to a date, preserving the time-of-day and clamping the day to
 * the last valid day of the target month. All math is done in UTC so billing
 * periods never drift with the server timezone or DST.
 *
 * Replaces the naive `d.setMonth(d.getMonth() + 1)`, which overflows on
 * month-end anchors: Jan 31 + 1 month → "Feb 31" → rolls forward to Mar 3.
 * Here Jan 31 + 1 month → Feb 28 (or Feb 29 on a leap year).
 */
export function addMonthsClampDay(date: Date, months: number): Date {
  const day = date.getUTCDate()
  // Build the target month anchored on day 1 to avoid overflow while shifting.
  const shifted = new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth() + months,
      1,
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  )
  // Last day of the shifted month (day 0 of the next month).
  const lastDay = new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0),
  ).getUTCDate()
  shifted.setUTCDate(Math.min(day, lastDay))
  return shifted
}

/** Add whole days to a date in UTC (used for the day+1 billing anchor). */
export function addDaysUTC(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000)
}

/**
 * The user's single active subscription, or null. Centralizes the
 * {userId, status:'active'} read so the "active sub" semantics live in one
 * place — with subscription history (status:'ended'), a bare findOne({userId})
 * would return an arbitrary historical sub. Enforced by billing_sub_one_active.
 */
export function getActiveSubscription(
  db: Db,
  userId: string,
): Promise<BillingSubscription | null> {
  return getBillingSubscriptionsCollection(db).findOne({ userId, status: 'active' })
}

/**
 * Get the effective agent-hours limit for a subscription.
 * Uses the custom override if set, otherwise falls back to the plan default,
 * then adds any active per-period boost hours (decision #10).
 *
 * `boostHours` defaults to 0 so existing callers keep their behavior; callers
 * that enforce or display the real limit (the gate, the audit) pass the value
 * from getActiveBoostHours. The base limit (custom ?? plan) is the single
 * source of truth here — there must be no second inline `custom ?? plan`
 * computation that could drift from this one.
 */
export function getEffectiveLimit(
  sub: Pick<BillingSubscription, 'customAgentHoursLimit'>,
  plan: Pick<BillingPlan, 'agentHoursLimit'>,
  boostHours = 0,
): number {
  return (sub.customAgentHoursLimit ?? plan.agentHoursLimit) + boostHours
}

/**
 * Effective Automate executions-per-day cap: the subscription override when
 * set, else the plan value. 0 means unmetered (same convention as
 * agentHoursLimit). A plan without the field is unmetered — every catalogue
 * plan carries it (seed + migration 20261015_001), so that only happens for
 * an ad-hoc plan doc, and failing open there is the lesser evil.
 */
export function getEffectiveAutomateDailyLimit(
  sub: Pick<BillingSubscription, 'customAutomateDailyExecutionLimit'> | null,
  plan: Pick<BillingPlan, 'automateDailyExecutionLimit'>,
): number {
  const override = sub?.customAutomateDailyExecutionLimit
  if (typeof override === 'number' && override >= 0) return override
  return plan.automateDailyExecutionLimit ?? 0
}

/**
 * Sum of a subscription's currently-active boost hours: boosts with
 * `status:'active'` whose [periodStart, periodEnd) window contains `now`. The
 * window check is the authority (a boost granted for a past period never
 * applies even if the reset-cron has not yet flipped it to 'expired'), so the
 * effective limit is always correct without depending on an expiry sweep.
 */
export async function getActiveBoostHours(
  db: Db,
  subscriptionId: string,
  now: Date,
): Promise<number> {
  const boosts = await getBillingHourBoostsCollection(db)
    .find({
      subscriptionId,
      status: 'active',
      periodStart: { $lte: now },
      periodEnd: { $gt: now },
    })
    .toArray()
  return boosts.reduce((sum, b) => sum + b.hours, 0)
}

/**
 * Get the effective monthly price for a subscription.
 * Uses the custom override if set, otherwise falls back to the plan default.
 */
export function getEffectivePrice(
  sub: Pick<BillingSubscription, 'customPrice'>,
  plan: Pick<BillingPlan, 'price'>,
): number {
  return sub.customPrice ?? plan.price
}

/**
 * Effective per-seat price for a team (decision E): the manual sales override if
 * set, otherwise the plan's price. Single source of truth so the create/update
 * handlers never drift on how seatPrice is derived. No volume discount — FASE 7
 * was cancelled; the override is set by hand.
 */
export function getEffectiveSeatPrice(
  team: Pick<BillingTeam, 'customSeatPrice'>,
  plan: Pick<BillingPlan, 'price'>,
): number {
  return team.customSeatPrice ?? plan.price
}

/**
 * Prorated charge (EUR) for an immediate UPGRADE (decision A): the extra cost of
 * the more expensive plan for the days left in the period the user already paid
 * for at the old plan — (newPrice − oldPrice) × (remaining / periodLength). The
 * old plan already covers the period, so we charge only the difference, not the
 * full new price; the user keeps all the new plan's hours regardless.
 *
 * Only an upgrade is charged here (diff ≤ 0 → 0); a downgrade is deferred to
 * period end (decision D) and never prorated. Catalog-agnostic and safe:
 *   - €0 BETA / equal prices → 0 (no-op), dormant until prices land.
 *   - `now` past period end → 0; at/before period start → full difference.
 * Rounded to cents to match money math elsewhere.
 */
export function computeProrationUpgradeCharge(
  oldSub: Pick<BillingSubscription, 'customPrice' | 'currentPeriodStart' | 'currentPeriodEnd'>,
  oldPlan: Pick<BillingPlan, 'price'>,
  newPrice: number,
  now: Date,
): number {
  const diff = newPrice - getEffectivePrice(oldSub, oldPlan)
  if (diff <= 0) return 0
  const periodMs = oldSub.currentPeriodEnd.getTime() - oldSub.currentPeriodStart.getTime()
  if (periodMs <= 0) return 0
  const remainingMs = oldSub.currentPeriodEnd.getTime() - now.getTime()
  const fraction = Math.min(1, Math.max(0, remainingMs / periodMs))
  return Math.round(diff * fraction * 100) / 100
}

/**
 * Create a default subscription for a new user (Starter plan, free during beta).
 */
export async function createDefaultSubscription(
  db: Db,
  userId: string,
): Promise<BillingSubscription> {
  const col = getBillingSubscriptionsCollection(db)
  const now = new Date()
  const periodEnd = addMonthsClampDay(now, 1)

  const doc: BillingSubscription = {
    _id: crypto.randomUUID(),
    userId,
    planId: DEFAULT_PLAN_ID,
    customAgentHoursLimit: null,
    customPrice: 0,          // gratis durante BETA
    customPriceNote: null,
    agentHoursUsed: 0,
    overageHours: 0,
    currentPeriodStart: now,
    currentPeriodEnd: periodEnd,
    status: 'active',
    startDate: now,
    endDate: null,
    paymentMethod: 'manual',
    billingNotes: 'Migrated — BETA free',
    createdAt: now,
    updatedAt: now,
  }

  await col.insertOne(doc)
  return doc
}

// ============================================================================
// TEROS PROVIDER CONFIG SEED
// ============================================================================

/**
 * Seed a default Teros provider config on startup.
 * Uses the existing system Fireworks API key from secrets.
 * Guarantees exactly one config named "Default" with isDefault=true.
 * If no configs exist at all, creates cfg_default.
 * If configs exist but none is default, creates cfg_default.
 * If a default already exists, does nothing.
 */
function encryptWithSystemKey(plaintext: string): string {
  const encryptionSecret = secrets.requireSystem('encryption')
  const systemKey = Buffer.from(encryptionSecret.masterKey, 'hex')
  const encrypted = encrypt(plaintext, systemKey)
  return encrypted.data + ':' + encrypted.iv + ':' + encrypted.tag
}

export async function seedDefaultTerosProviderConfig(
  db: Db,
  fireworksApiKey: string,
): Promise<void> {
  const col = getTerosProviderConfigsCollection(db)

  // If a default already exists, nothing to do
  const existingDefault = await col.findOne({ isDefault: true })
  if (existingDefault) {
    console.log('[Billing] Default Teros provider config already exists, skipping seed')
    return
  }

  const now = new Date()
  const doc: TerosProviderConfig = {
    _id: 'cfg_default',
    name: 'Default',
    fireworksApiKey: encryptWithSystemKey(fireworksApiKey),
    isDefault: true,
    // TPROV-REQ-4 / TLANE-REQ-6: today's routes on both lanes until an admin edits the config.
    sizes: DEFAULT_TEROS_SIZES.sizes,
    failover: DEFAULT_TEROS_SIZES.failover,
    createdAt: now,
    updatedAt: now,
  }

  await col.insertOne(doc)
  console.log('[Billing] Seeded default Teros provider config (cfg_default)')
}
