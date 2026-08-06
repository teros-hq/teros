/**
 * TER-650/G6 — the agent-hours gate keys on the ACTOR (channel.userId), not on the
 * agent owner; the PAYMENT gate follows the owner. For a shared-workspace agent, actor
 * and owner diverge and the rollup bills the ACTOR, so hours must be checked against
 * the actor (provider-service.ts:817-818).
 *
 * `billing-gate-invariant.test.ts` is a source lint (it guarantees that
 * `resolveProviderForAgent` CALLS the gate). This test closes the BEHAVIORAL gap: it
 * runs `resolveProviderForAgent` with actor ≠ owner and checks WHO gets blocked.
 *
 * Strategy: `resolveProviderForAgentInner` is stubbed (provider resolution is orthogonal
 * to G6) to return a `teros` provider owned by the owner; the in-memory db carries the
 * real subs/plans/invoices read by `assertTerosHoursAvailable` / `assertAccountNotBlocked`.
 *
 * MUST BITE — mutation: changing `assertTerosHoursAvailable(actorUserId ?? ownerUserId)`
 * to `ownerUserId` (the bug #354 fixes) makes:
 *   - case 1 "actor exhausted, owner has hours" stop throwing → red,
 *   - case 2 "owner exhausted, actor has hours" start throwing → red.
 */
import { describe, expect, it } from "bun:test"
import { HoursExhaustedError, PaymentDueError } from "../../src/services/billing-gate"
import { ProviderService } from "../../src/services/provider-service"
import { InMemoryDb } from "./_stripe-test-helpers"

const OWNER = "user_owneraaaaaaaa"
const ACTOR = "user_actorbbbbbbbb"
const PERIOD_END = new Date("2999-01-01T00:00:00.000Z")
const LIMIT = 80 // plan_pro agentHoursLimit

interface SeedOpts {
  ownerUsed: number
  actorUsed: number
  ownerBlocked?: boolean
}

async function seedDb(opts: SeedOpts): Promise<InMemoryDb> {
  const db = new InMemoryDb()
  await db.collection("billing_plans").insertOne({
    _id: "plan_pro",
    name: "pro",
    displayName: "Pro",
    agentHoursLimit: LIMIT,
    features: { terosModel: true, byok: true, maxWorkspaces: -1, prioritySupport: false },
  })
  const sub = (userId: string, used: number) => ({
    _id: `sub_${userId}`,
    userId,
    planId: "plan_pro",
    status: "active",
    agentHoursUsed: used,
    customAgentHoursLimit: null,
    currentPeriodEnd: PERIOD_END,
  })
  await db.collection("billing_subscriptions").insertOne(sub(OWNER, opts.ownerUsed))
  await db.collection("billing_subscriptions").insertOne(sub(ACTOR, opts.actorUsed))
  if (opts.ownerBlocked) {
    await db.collection("billing_invoices").insertOne({
      _id: "inv_block",
      userId: OWNER,
      status: "uncollectible",
      amount: 89,
      currency: "EUR",
    })
  }
  return db
}

/** ProviderService with the provider-resolution stubbed to a teros provider owned by OWNER. */
function serviceResolvingTeros(db: InMemoryDb): ProviderService {
  const svc = new ProviderService(db as never)
  // The G6 decision is downstream of resolution; stub the (orthogonal) resolver so
  // the only logic under test is the gate block (assertAccountNotBlocked + hours gate).
  ;(
    svc as unknown as { resolveProviderForAgentInner: () => Promise<unknown> }
  ).resolveProviderForAgentInner = async () => ({
    provider: { userId: OWNER, providerType: "teros" },
  })
  return svc
}

describe("resolveProviderForAgent — hours gate keys on the actor (TER-650/G6)", () => {
  it("actor WITHOUT hours + owner WITH hours → HOURS_EXHAUSTED (keys on the actor)", async () => {
    const svc = serviceResolvingTeros(await seedDb({ ownerUsed: 0, actorUsed: LIMIT }))
    await expect(svc.resolveProviderForAgent("agent_x", undefined, ACTOR)).rejects.toBeInstanceOf(
      HoursExhaustedError,
    )
  })

  it("owner WITHOUT hours + actor WITH hours → resolves (does NOT block on the owner)", async () => {
    const svc = serviceResolvingTeros(await seedDb({ ownerUsed: LIMIT, actorUsed: 0 }))
    const resolved = (await svc.resolveProviderForAgent("agent_x", undefined, ACTOR)) as {
      provider: { userId: string }
    } | null
    expect(resolved?.provider?.userId).toBe(OWNER)
  })

  it("no actor (owner direct run) → falls back to the owner: exhausted owner throws", async () => {
    const svc = serviceResolvingTeros(await seedDb({ ownerUsed: LIMIT, actorUsed: 0 }))
    await expect(
      svc.resolveProviderForAgent("agent_x", undefined, undefined),
    ).rejects.toBeInstanceOf(HoursExhaustedError)
  })

  it("PAYMENT gate follows the owner: owner's unpaid invoice blocks even if the actor can pay", async () => {
    const svc = serviceResolvingTeros(
      await seedDb({ ownerUsed: 0, actorUsed: 0, ownerBlocked: true }),
    )
    await expect(svc.resolveProviderForAgent("agent_x", undefined, ACTOR)).rejects.toBeInstanceOf(
      PaymentDueError,
    )
  })
})
