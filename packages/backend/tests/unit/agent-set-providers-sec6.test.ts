/**
 * Unit tests — agent.set-providers / agent.set-preferred-provider ownership gate
 * (SEC-6/M7, TER-725).
 *
 * The audit flagged two related gaps:
 *
 *   1. Bypassable ownership idiom: `if (agent.ownerId && agent.ownerId !== ctx.userId)`
 *      short-circuits to "allowed" whenever `agent.ownerId` is falsy. A seeded
 *      global/template agent with no `ownerId` (e.g. `agent:iria` in
 *      scripts/seed-agents.ts) is invisible to `agent.list` (which filters
 *      `{ ownerId: ctx.userId }`) but still reachable directly by id — any
 *      authenticated caller who knows/guesses the id could mutate it.
 *   2. No runtime validation on `agentId`: `WsRouter` dispatches `data: unknown`
 *      straight to the handler, and `rawData as SetProvidersData` is a
 *      compile-time-only cast. A payload like `{"agentId":{"$gt":""}}` reaches
 *      `db.collection('agents').findOne({ agentId })` as a raw filter object.
 *
 * No real MongoDB — Db is mocked. Both denied-case classes assert the write
 * (`updateOne`) was never invoked, not just that an error was thrown.
 */

import { describe, expect, it, mock } from "bun:test"
import type { WsHandlerContext } from "@teros/shared"
import { createSetPreferredProviderHandler } from "../../src/handlers/domains/agent/set-preferred-provider"
import { createSetProvidersHandler } from "../../src/handlers/domains/agent/set-providers"

const USER_ALICE = "user_alice"
const USER_BOB = "user_bob"

const AGENT_OWNED_BY_ALICE = "agent_owned_by_alice"
const AGENT_OWNED_BY_BOB = "agent_owned_by_bob"
// Mirrors scripts/seed-agents.ts `agent:iria` — a global/template agent seeded
// with no `ownerId`. Invisible to agent.list (filters `{ ownerId: ctx.userId }`)
// but still a valid `findOne({ agentId })` target for anyone who has the id.
const AGENT_OWNERLESS = "agent_ownerless_template"

function ctx(userId: string): WsHandlerContext {
  return { userId, connectionId: "c", sessionId: "s" } as WsHandlerContext
}

function makeDb() {
  const agentsById: Record<string, any> = {
    [AGENT_OWNED_BY_ALICE]: {
      agentId: AGENT_OWNED_BY_ALICE,
      ownerId: USER_ALICE,
      availableProviders: ["anthropic"],
    },
    [AGENT_OWNED_BY_BOB]: {
      agentId: AGENT_OWNED_BY_BOB,
      ownerId: USER_BOB,
      availableProviders: [],
    },
    [AGENT_OWNERLESS]: {
      agentId: AGENT_OWNERLESS,
      availableProviders: [],
    },
  }

  const findOne = mock(async (filter: any) => agentsById[filter?.agentId] ?? null)
  const updateOne = mock(async () => ({ acknowledged: true, matchedCount: 1, modifiedCount: 1 }))

  const agents = { findOne, updateOne }
  return {
    db: {
      collection: mock((name: string) =>
        name === "agents" ? agents : { findOne: mock(async () => null) },
      ),
    } as any,
    agents,
  }
}

// ===========================================================================
// agent.set-providers
// ===========================================================================

describe("agent.set-providers ownership gate (SEC-6/M7)", () => {
  it("allows the owner to update their own agent", async () => {
    const { db, agents } = makeDb()
    const handler = createSetProvidersHandler(db)

    const result = await handler(ctx(USER_ALICE), {
      agentId: AGENT_OWNED_BY_ALICE,
      availableProviders: ["anthropic", "openai"],
    })

    expect(result).toEqual({
      agentId: AGENT_OWNED_BY_ALICE,
      availableProviders: ["anthropic", "openai"],
    })
    expect(agents.updateOne).toHaveBeenCalledTimes(1)
  })

  it("rejects a caller who does not own the agent", async () => {
    const { db, agents } = makeDb()
    const handler = createSetProvidersHandler(db)

    await expect(
      handler(ctx(USER_ALICE), { agentId: AGENT_OWNED_BY_BOB, availableProviders: ["anthropic"] }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" })

    expect(agents.updateOne).not.toHaveBeenCalled()
  })

  it("rejects a caller targeting an ownerless (system/template) agent — the bypass this closes", async () => {
    const { db, agents } = makeDb()
    const handler = createSetProvidersHandler(db)

    await expect(
      handler(ctx(USER_ALICE), { agentId: AGENT_OWNERLESS, availableProviders: ["anthropic"] }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" })

    expect(agents.updateOne).not.toHaveBeenCalled()
  })

  it("rejects a non-string agentId (NoSQL operator injection payload) before touching the DB", async () => {
    const { db, agents } = makeDb()
    const handler = createSetProvidersHandler(db)

    await expect(
      handler(ctx(USER_ALICE), { agentId: { $gt: "" }, availableProviders: [] }),
    ).rejects.toMatchObject({ code: "MISSING_AGENT_ID" })

    expect(agents.findOne).not.toHaveBeenCalled()
    expect(agents.updateOne).not.toHaveBeenCalled()
  })

  it("rejects a non-array availableProviders", async () => {
    const { db, agents } = makeDb()
    const handler = createSetProvidersHandler(db)

    await expect(
      handler(ctx(USER_ALICE), { agentId: AGENT_OWNED_BY_ALICE, availableProviders: "anthropic" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" })

    expect(agents.updateOne).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// agent.set-preferred-provider
// ===========================================================================

describe("agent.set-preferred-provider ownership gate (SEC-6/M7)", () => {
  it("allows the owner to set a preferred provider already in availableProviders", async () => {
    const { db, agents } = makeDb()
    const handler = createSetPreferredProviderHandler(db)

    const result = await handler(ctx(USER_ALICE), {
      agentId: AGENT_OWNED_BY_ALICE,
      providerId: "anthropic",
    })

    expect(result).toEqual({ agentId: AGENT_OWNED_BY_ALICE, preferredProviderId: "anthropic" })
    expect(agents.updateOne).toHaveBeenCalledTimes(1)
  })

  it("rejects a caller who does not own the agent", async () => {
    const { db, agents } = makeDb()
    const handler = createSetPreferredProviderHandler(db)

    await expect(
      handler(ctx(USER_ALICE), { agentId: AGENT_OWNED_BY_BOB, providerId: null }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" })

    expect(agents.updateOne).not.toHaveBeenCalled()
  })

  it("rejects a caller targeting an ownerless (system/template) agent — the bypass this closes", async () => {
    const { db, agents } = makeDb()
    const handler = createSetPreferredProviderHandler(db)

    await expect(
      handler(ctx(USER_ALICE), { agentId: AGENT_OWNERLESS, providerId: null }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" })

    expect(agents.updateOne).not.toHaveBeenCalled()
  })

  it("rejects a non-string agentId (NoSQL operator injection payload) before touching the DB", async () => {
    const { db, agents } = makeDb()
    const handler = createSetPreferredProviderHandler(db)

    await expect(
      handler(ctx(USER_ALICE), { agentId: { $gt: "" }, providerId: null }),
    ).rejects.toMatchObject({ code: "MISSING_AGENT_ID" })

    expect(agents.findOne).not.toHaveBeenCalled()
    expect(agents.updateOne).not.toHaveBeenCalled()
  })
})
