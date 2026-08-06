/**
 * Billing state helpers for the @billing E2E specs (TER-596). Mirror the
 * `/tmp/teros-billing-smoke/bill` driver but as TS over the suite's shared Mongo
 * client (helpers/db.ts → getMongoDb), so a spec can put a user's subscription in
 * a known state, then assert the RAW Mongo result after exercising the real
 * backend through the live client.
 *
 * Runs only under `yarn smoke:billing` (MONGODB_DATABASE=teros_billing). Every
 * mutating spec resets the shared playwright1/2 accounts + team_demo back to the
 * documented baseline (Kimi=plan_pro 40/80h, team_demo=plan_pro no override, 0
 * members) in afterAll, so Antonio's manual smoke finds a clean slate.
 */
import { randomUUID } from "node:crypto"
import { getMongoDb } from "./db"

/** playwright2 — the Kimi-agent user; the one that sees chat blocks + boosts. */
export const KIMI_USER = "user_044ffd9ad48ecf2a"
/** playwright1 — admin + owner of team_demo. */
export const ADMIN_USER = "user_81ccc3b3f7500f15"
export const TEAM_ID = "team_demo"

const DAY = 24 * 60 * 60 * 1000

export interface BillingSub {
  _id: string
  userId: string
  planId: string
  agentHoursUsed: number
  status: string
  currentPeriodStart: Date
  currentPeriodEnd: Date
  cancelAtPeriodEnd?: boolean
  scheduledPlanChange?: { planId: string; scheduledAt: Date } | null
  teamId?: string | null
  warned80At?: Date | null
}

interface ResetOpts {
  used?: number
  teamId?: string | null
}

/**
 * Hard-reset a user's billing to ONE active subscription on `planId` (deletes any
 * prior subs/invoices/boosts/requests so `getActiveSubscription` is unambiguous).
 * `lastBilledHourBucket=now` so the tracker never re-bills past rollups. Mirrors
 * the driver's resetPlan, plus an optional `teamId` to drive team-mode flows.
 */
export async function resetUserPlan(
  userId: string,
  planId: string,
  opts: ResetOpts = {},
): Promise<BillingSub> {
  const db = await getMongoDb()
  const now = new Date()
  await db.collection("billing_subscriptions").deleteMany({ userId })
  await db.collection("billing_invoices").deleteMany({ userId })
  await db.collection("billing_hour_boosts").deleteMany({ userId })
  await db.collection("billing_access_requests").deleteMany({ userId })
  const sub: BillingSub & Record<string, unknown> = {
    _id: randomUUID(),
    userId,
    planId,
    customAgentHoursLimit: null,
    customPrice: null,
    customPriceNote: null,
    agentHoursUsed: opts.used ?? 0,
    overageHours: 0,
    lastBilledHourBucket: now,
    currentPeriodStart: new Date(now.getTime() - 15 * DAY),
    currentPeriodEnd: new Date(now.getTime() + 15 * DAY),
    status: "active",
    startDate: new Date(now.getTime() - 15 * DAY),
    endDate: null,
    teamId: opts.teamId ?? null,
    cancelAtPeriodEnd: false,
    scheduledPlanChange: null,
    warned80At: null,
    resetting: false,
    resettingAt: null,
    paymentMethod: "manual",
    createdAt: now,
    updatedAt: now,
  }
  await db.collection("billing_subscriptions").insertOne(sub)
  return sub
}

/** Documented baseline for playwright2: plan_pro, mid-period, 40/80h, no team. */
export async function resetKimiBaseline(): Promise<BillingSub> {
  return resetUserPlan(KIMI_USER, "plan_pro", { used: 40 })
}

/** Set agentHoursUsed on a user's active sub (and re-arm the 80% warning). */
export async function setUsed(userId: string, hours: number): Promise<void> {
  const db = await getMongoDb()
  const sub = await getActiveSub(userId)
  if (!sub) throw new Error(`setUsed: no active sub for ${userId}`)
  await db
    .collection("billing_subscriptions")
    .updateOne(
      { _id: sub._id },
      { $set: { agentHoursUsed: hours, warned80At: null, updatedAt: new Date() } },
    )
}

/** Move a user's active sub into (or out of) a team — drives team-mode boost UI. */
export async function setSubTeam(userId: string, teamId: string | null): Promise<void> {
  const db = await getMongoDb()
  const sub = await getActiveSub(userId)
  if (!sub) throw new Error(`setSubTeam: no active sub for ${userId}`)
  await db
    .collection("billing_subscriptions")
    .updateOne({ _id: sub._id }, { $set: { teamId, updatedAt: new Date() } })
}

export async function getActiveSub(userId: string): Promise<BillingSub | null> {
  const db = await getMongoDb()
  return db
    .collection("billing_subscriptions")
    .findOne({ userId, status: "active" }) as Promise<BillingSub | null>
}

export async function getSubById(id: string): Promise<BillingSub | null> {
  const db = await getMongoDb()
  return db.collection("billing_subscriptions").findOne({ _id: id }) as Promise<BillingSub | null>
}

export async function getAllSubs(userId: string): Promise<BillingSub[]> {
  const db = await getMongoDb()
  return db.collection("billing_subscriptions").find({ userId }).toArray() as Promise<BillingSub[]>
}

export async function getInvoices(userId: string): Promise<Record<string, unknown>[]> {
  const db = await getMongoDb()
  return db.collection("billing_invoices").find({ userId }).toArray()
}

export async function getBoosts(userId: string): Promise<Record<string, unknown>[]> {
  const db = await getMongoDb()
  return db.collection("billing_hour_boosts").find({ userId }).toArray()
}

export async function getAccessRequests(userId: string): Promise<Record<string, unknown>[]> {
  const db = await getMongoDb()
  return db.collection("billing_access_requests").find({ userId }).toArray()
}

export async function getTeam(teamId: string = TEAM_ID): Promise<Record<string, unknown> | null> {
  const db = await getMongoDb()
  return db.collection("billing_teams").findOne({ _id: teamId })
}

/** A plan row from the catalogue (billing_plans). */
export async function getPlan(planId: string): Promise<Record<string, unknown> | null> {
  const db = await getMongoDb()
  return db.collection("billing_plans").findOne({ _id: planId })
}

/**
 * Restore team_demo to the documented baseline: plan_pro, seatPrice 89, no
 * override, zero members; and clear teamId from any sub that pointed at it.
 */
export async function resetTeamBaseline(teamId: string = TEAM_ID): Promise<void> {
  const db = await getMongoDb()
  await db
    .collection("billing_subscriptions")
    .updateMany({ teamId }, { $set: { teamId: null, updatedAt: new Date() } })
  await db.collection("billing_teams").updateOne(
    { _id: teamId },
    {
      $set: {
        planId: "plan_pro",
        seatPrice: 89,
        customSeatPrice: null,
        memberIds: [],
        seatCount: 0,
        maxSeats: 5,
        status: "active",
        updatedAt: new Date(),
      },
    },
  )
}

/** Seed one invoice for a user (so get-invoices has a deterministic row to surface). */
export async function insertInvoice(
  userId: string,
  fields: Partial<Record<string, unknown>> = {},
): Promise<string> {
  const db = await getMongoDb()
  const now = new Date()
  const _id = `inv_smoke_${randomUUID().slice(0, 8)}`
  await db.collection("billing_invoices").insertOne({
    _id,
    subscriptionId: "sub_smoke",
    userId,
    periodStart: new Date(now.getTime() - 30 * DAY),
    periodEnd: now,
    amount: 89,
    currency: "EUR",
    status: "paid",
    kind: "subscription",
    paymentMethod: "stripe",
    invoiceNumber: "TEROS-SMOKE-0001",
    externalReference: "in_smoke",
    hostedInvoiceUrl: "https://invoice.stripe.test/smoke",
    invoicePdfUrl: "https://invoice.stripe.test/smoke.pdf",
    attemptCount: 1,
    createdAt: now,
    updatedAt: now,
    ...fields,
  })
  return _id
}

/** Hard-delete a throwaway team doc + clear teamId from any sub (CRUD spec cleanup). */
export async function deleteTeam(teamId: string): Promise<void> {
  const db = await getMongoDb()
  await db.collection("billing_teams").deleteOne({ _id: teamId })
  await db
    .collection("billing_subscriptions")
    .updateMany({ teamId }, { $set: { teamId: null, updatedAt: new Date() } })
}

/** Remove every billing row for a user (used to reset a throwaway onboarding user). */
export async function deleteUserBilling(userId: string): Promise<void> {
  const db = await getMongoDb()
  await db.collection("billing_subscriptions").deleteMany({ userId })
  await db.collection("billing_invoices").deleteMany({ userId })
  await db.collection("billing_hour_boosts").deleteMany({ userId })
  await db.collection("billing_access_requests").deleteMany({ userId })
}

// ── Onboarding throwaway user (I2 DOM spec) ─────────────────────────────────────
// A DEDICATED user that the onboarding wizard spec drives end-to-end. Kept apart
// from playwright1/2 so the wizard (which sets onboardingCompletedAt + changes the
// plan) never disturbs the shared baseline Antonio's manual smoke relies on.
export const ONB_USER = "user_0b0b0b0b0b0b0b0b"
export const ONB_EMAIL = "playwright-onb@test.com"
export const ONB_PASSWORD = "test1234"
const ONB_WS = "work_0b0b0b0b0b0b0b0b"
const ONB_VOL = "vol_user_0b0b0b0b0b0b0b0b"
const ONB_AGENT = "agent_0b0b0b0b0b0b0b0b"
const ONB_CORE = "core:pw-test"
// bcrypt(test1234, rounds=12) — hardcoded so the test runner needs no native bcrypt.
const ONB_PW_HASH = "$2b$12$EdCzr9xiEVnXFsFIMTu.sOejn9sKJpVcQPR0Ztfm4omVXp5eUbMey"

/**
 * Seed (idempotent) the throwaway onboarding user in PRE-onboarding state:
 * accessGranted + termsAcceptedAt set, onboardingCompletedAt UNSET, a Starter
 * subscription as the default, and a default agent + private workspace so the
 * wizard's init load resolves. Call in beforeEach: it both creates the user once
 * and resets it to pre-onboarding every run (unsets onboardingCompletedAt + wipes
 * billing back to Starter), so the redirect gate fires again.
 */
export async function seedOnboardingUser(): Promise<{
  email: string
  password: string
  userId: string
}> {
  const db = await getMongoDb()
  const now = new Date()

  await db.collection("volumes").updateOne(
    { volumeId: ONB_VOL },
    {
      $set: {
        volumeId: ONB_VOL,
        name: "Onb Personal",
        type: "user",
        ownerId: ONB_USER,
        members: [],
        quotaBytes: 0,
        updatedAt: now.toISOString(),
      },
      $setOnInsert: { createdAt: now.toISOString() },
    },
    { upsert: true },
  )
  await db.collection("workspaces").updateOne(
    { workspaceId: ONB_WS },
    {
      $set: {
        workspaceId: ONB_WS,
        name: "Private",
        type: "private",
        ownerId: ONB_USER,
        volumeId: ONB_VOL,
        members: [],
        settings: {},
        status: "active",
        updatedAt: now.toISOString(),
      },
      $setOnInsert: { createdAt: now.toISOString() },
    },
    { upsert: true },
  )
  // User in PRE-onboarding state. $unset onboardingCompletedAt so a re-run (where a
  // prior wizard set it) goes back through the redirect gate.
  await db.collection("users").updateOne(
    { userId: ONB_USER },
    {
      $set: {
        userId: ONB_USER,
        profile: { email: ONB_EMAIL, displayName: "Play Onb", avatarUrl: null },
        privateWorkspaceId: ONB_WS,
        accessGranted: true,
        emailVerified: true,
        termsAcceptedAt: now,
        status: "active",
        role: "user",
        updatedAt: now,
      },
      $unset: { onboardingCompletedAt: "" },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  )
  await db.collection("user_identities").updateOne(
    { userId: ONB_USER, type: "password" },
    {
      $set: {
        userId: ONB_USER,
        type: "password",
        providerUserId: ONB_EMAIL,
        email: ONB_EMAIL,
        data: { passwordHash: ONB_PW_HASH, failedAttempts: 0, lastPasswordChangeAt: now },
        status: "active",
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  )
  await db.collection("agents").updateOne(
    { agentId: ONB_AGENT },
    {
      $set: {
        agentId: ONB_AGENT,
        coreId: ONB_CORE,
        ownerId: ONB_USER,
        workspaceId: null,
        name: "OnbBot",
        fullName: "Onboarding Bot",
        role: "test assistant",
        intro: "Onboarding smoke agent.",
        avatarUrl: "iria.png",
        availableProviders: [],
        selectedProviderId: null,
        selectedModelId: null,
        updatedAt: now.toISOString(),
      },
      $setOnInsert: { createdAt: now.toISOString() },
    },
    { upsert: true },
  )
  // Default Starter subscription (so PlanStep shows Starter as current).
  await resetUserPlan(ONB_USER, "plan_starter")
  return { email: ONB_EMAIL, password: ONB_PASSWORD, userId: ONB_USER }
}

/** Read a user document (to assert onboardingCompletedAt was persisted). */
export async function getUser(userId: string): Promise<Record<string, unknown> | null> {
  const db = await getMongoDb()
  return db.collection("users").findOne({ userId })
}

/** Read the Stripe customer mapping (defaultPaymentMethodId / stripeCustomerId). */
export async function getBillingCustomer(userId: string): Promise<Record<string, unknown> | null> {
  const db = await getMongoDb()
  return db.collection("billing_customers").findOne({ userId })
}

/**
 * Set (or clear, with null) the default payment method on a user's Stripe customer
 * mapping. The purchase-boost gate reads `getCustomer({_id:userId}).defaultPaymentMethodId`,
 * so clearing it forces the NO_PAYMENT_METHOD path. Restore the captured original
 * afterwards to keep the documented baseline (pm_1TlTGl… chargeable) pristine.
 */
export async function setDefaultPaymentMethod(userId: string, pmId: string | null): Promise<void> {
  const db = await getMongoDb()
  await db
    .collection("billing_customers")
    .updateOne({ _id: userId }, { $set: { defaultPaymentMethodId: pmId, updatedAt: new Date() } })
}

/**
 * Mark a user's active sub for end-of-period cancellation. There is no self-serve
 * cancel UI yet (TER-601 deferred), so this seeds the backend state the
 * `cancel-scheduled` pill renders from — the only way to exercise that pill in DOM.
 */
export async function setCancelAtPeriodEnd(userId: string, value: boolean): Promise<void> {
  const db = await getMongoDb()
  const sub = await getActiveSub(userId)
  if (!sub) throw new Error(`setCancelAtPeriodEnd: no active sub for ${userId}`)
  await db
    .collection("billing_subscriptions")
    .updateOne({ _id: sub._id }, { $set: { cancelAtPeriodEnd: value, updatedAt: new Date() } })
}
