/**
 * Unit tests — agent.set-model ownership gate (SEC-6/M7, TER-725; MOD-8).
 *
 * agent.set-providers / agent.set-preferred-provider were replaced by
 * agent.set-model on 2026-10-21 (availableProviders removed). Their SEC-6 test
 * kept importing the deleted handlers, so the whole file errored out and the
 * gate lost its coverage. These are the same cases against the new handler:
 *
 *   1. Ownership is strict equality: an ownerless (system/template) agent such
 *      as `agent:iria` in scripts/seed-agents.ts is not "allowed by default".
 *   2. `agentId` is validated at runtime: `rawData` is `unknown`, and an
 *      operator object (`{"$gt":""}`) must never reach `findOne({ agentId })`.
 *   3. The pin may only name the caller's own providers (MOD-8).
 *
 * No real MongoDB — Db is mocked. Denied cases assert the write (`updateOne`)
 * was never invoked, not just that an error was thrown.
 */

import { describe, expect, it, mock } from "bun:test"
import type { WsHandlerContext } from "@teros/shared"
import { createSetModelHandler } from "../../src/handlers/domains/agent/set-model"

const USER_ALICE = "user_alice"
const USER_BOB = "user_bob"

const AGENT_OWNED_BY_ALICE = "agent_owned_by_alice"
const AGENT_OWNED_BY_BOB = "agent_owned_by_bob"
// Mirrors scripts/seed-agents.ts `agent:iria` — a global/template agent seeded
// with no `ownerId`, still a valid `findOne({ agentId })` target by id.
const AGENT_OWNERLESS = "agent_ownerless_template"

function ctx(userId: string): WsHandlerContext {
  return { userId, connectionId: "c", sessionId: "s" } as WsHandlerContext
}

function makeDb() {
  const agentsById: Record<string, any> = {
    [AGENT_OWNED_BY_ALICE]: { agentId: AGENT_OWNED_BY_ALICE, ownerId: USER_ALICE },
    [AGENT_OWNED_BY_BOB]: { agentId: AGENT_OWNED_BY_BOB, ownerId: USER_BOB },
    [AGENT_OWNERLESS]: { agentId: AGENT_OWNERLESS },
  }

  const findOne = mock(async (filter: any) => agentsById[filter?.agentId] ?? null)
  const updateOne = mock(async () => ({ acknowledged: true, matchedCount: 1, modifiedCount: 1 }))
  const agents = { findOne, updateOne }

  // user_providers: Alice owns "anthropic" (serving claude-x); Bob owns "bob_key"
  const providers = [
    { providerId: "anthropic", userId: USER_ALICE, models: [{ modelId: "claude-x" }] },
    { providerId: "bob_key", userId: USER_BOB, models: [{ modelId: "claude-x" }] },
  ]
  const userProviders = {
    find: mock((filter: any) => ({
      toArray: async () =>
        providers.filter((p) => filter.providerId.$in.includes(p.providerId) && p.userId === filter.userId),
    })),
    findOne: mock(async (filter: any) => providers.find((p) => p.providerId === filter.providerId) ?? null),
  }
  return {
    db: {
      collection: mock((name: string) =>
        name === "agents"
          ? agents
          : name === "user_providers"
            ? userProviders
            : { findOne: mock(async () => null) },
      ),
    } as any,
    agents,
  }
}

describe("agent.set-model ownership gate (SEC-6/M7)", () => {
  it("lets the owner pin their own provider and model", async () => {
    const { db, agents } = makeDb()
    const handler = createSetModelHandler(db)

    const result = await handler(ctx(USER_ALICE), {
      agentId: AGENT_OWNED_BY_ALICE,
      providerId: "anthropic",
      modelId: "claude-x",
    })

    expect(result).toEqual({
      agentId: AGENT_OWNED_BY_ALICE,
      selectedProviderId: "anthropic",
      selectedModelId: "claude-x",
    })
    expect(agents.updateOne).toHaveBeenCalledTimes(1)
  })

  it("rejects pinning someone else's provider (MOD-8)", async () => {
    const { db, agents } = makeDb()
    const handler = createSetModelHandler(db)

    await expect(
      handler(ctx(USER_ALICE), { agentId: AGENT_OWNED_BY_ALICE, providerId: "bob_key" }),
    ).rejects.toMatchObject({ code: "PROVIDER_NOT_FOUND" })

    expect(agents.updateOne).not.toHaveBeenCalled()
  })

  it("rejects a caller who does not own the agent", async () => {
    const { db, agents } = makeDb()
    const handler = createSetModelHandler(db)

    await expect(
      handler(ctx(USER_ALICE), { agentId: AGENT_OWNED_BY_BOB, providerId: null }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" })

    expect(agents.updateOne).not.toHaveBeenCalled()
  })

  it("rejects a caller targeting an ownerless (system/template) agent", async () => {
    const { db, agents } = makeDb()
    const handler = createSetModelHandler(db)

    await expect(
      handler(ctx(USER_ALICE), { agentId: AGENT_OWNERLESS, providerId: null }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" })

    expect(agents.updateOne).not.toHaveBeenCalled()
  })

  it("rejects a non-string agentId (NoSQL operator injection payload) before touching the DB", async () => {
    const { db, agents } = makeDb()
    const handler = createSetModelHandler(db)

    await expect(
      handler(ctx(USER_ALICE), { agentId: { $gt: "" }, providerId: null }),
    ).rejects.toMatchObject({ code: "MISSING_AGENT_ID" })

    expect(agents.findOne).not.toHaveBeenCalled()
    expect(agents.updateOne).not.toHaveBeenCalled()
  })
})
