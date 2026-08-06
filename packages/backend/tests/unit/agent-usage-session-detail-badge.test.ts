/**
 * Unit tests for the Session Trace → Latitude signal badge decoration (F4 · C1,
 * the return path — read side of `admin-api.agent-usage-session-detail`).
 *
 * Mutation-verified. The strong assertion is the JOIN KEY: the handler MUST look
 * the badge up under `traceIdFor(rootSessionUsageId ?? sessionUsageId)` — the SAME
 * 32-hex id F3a stamped and Latitude echoes back as a sampleTraceId. A regression
 * that keyed on `sessionUsageId` (the child, not the delegation-tree root) would
 * miss the badge; the `.toEqual([traceIdFor(root)])` call assertion bites it.
 *
 * The lookup is best-effort/disposable: a miss, an unwired index, or a projection
 * hiccup all degrade to `latitudeSignal: null` — never to a failed trace read.
 */

import { describe, expect, it } from "bun:test"
import { createAgentUsageSessionDetailHandler } from "../../src/handlers/domains/admin-api/agent-usage"
import type { LatitudeSignalBadge } from "../../src/services/latitude-signal-index"
import { traceIdFor } from "../../src/services/otel-span-builder"
import type { AgentUsageSession } from "../../src/types/database"

const BADGE: LatitudeSignalBadge = {
  slug: "custom-tool-calls-return-generic-tool-error",
  name: "Custom tool calls return generic tool error",
  priority: "high",
  source: "signal.discovered",
  deepLinkUrl: "https://latitude.local/signals/abc",
  trigger: "signal.discovered",
}

function makeSession(overrides: Partial<AgentUsageSession> = {}): AgentUsageSession {
  return {
    sessionUsageId: "usess_child",
    parentSessionUsageId: null,
    rootSessionUsageId: "usess_root",
    triggerKind: "user_message",
    userId: "user_1",
    agentId: "agent_1",
    workspaceId: "work_1",
    channelId: "ch_1",
    provider: "teros",
    modelId: "kimi",
    startedAt: new Date(0),
    ...overrides,
  } as unknown as AgentUsageSession
}

const ctx = { userId: "admin_1" } as never

function fakeDb(session: AgentUsageSession | null) {
  // Cursor fake: the handler chains `.maxTimeMS(…)` before `.toArray()` on its
  // finds (admin reads are time-bounded), so the cursor must support both.
  const emptyCursor = () => {
    const cursor = {
      toArray: async () => [],
      maxTimeMS: () => cursor,
    }
    return cursor
  }
  const empty = { find: emptyCursor }
  const collections: Record<string, unknown> = {
    users: { findOne: async () => ({ role: "super" }) },
    agent_usage_sessions: {
      findOne: async () => session,
      find: emptyCursor,
    },
    tool_executions: empty,
    llm_usage: empty,
    channel_messages: empty,
    message_feedback: empty,
    // Display-name resolution (P6) — best-effort lookups, empty/miss is fine.
    agents: empty,
    workspaces: { findOne: async () => null },
    // Ledger-first audit write (TER-671/A6.3) — must succeed for the trace read.
    agent_usage_access_log: { insertOne: async () => ({ insertedId: "log_1" }) },
  }
  return { collection: (name: string) => collections[name] } as never
}

/** Returns the badge only when the lookup ids include `hitKey`; records calls. */
function fakeIndex(hitKey: string | null, opts: { throws?: boolean } = {}) {
  const calls: string[][] = []
  const index = {
    lookupByTraceIds: async (ids: string[]) => {
      calls.push(ids)
      if (opts.throws) throw new Error("mongo hiccup")
      return hitKey && ids.includes(hitKey) ? BADGE : null
    },
  }
  return { index: index as never, calls }
}

describe("agent-usage-session-detail → Latitude signal badge (F4·C1 read path)", () => {
  it("looks the badge up under traceIdFor(root), NOT the session id", async () => {
    const session = makeSession({ sessionUsageId: "usess_child", rootSessionUsageId: "usess_root" })
    const rootKey = traceIdFor("usess_root")
    const { index, calls } = fakeIndex(rootKey)
    const handler = createAgentUsageSessionDetailHandler(fakeDb(session), index)

    const result = (await handler(ctx, { sessionUsageId: "usess_child" })) as {
      latitudeSignal: LatitudeSignalBadge | null
    }

    // The exact join key — this is what bites the meaning-drift regression.
    expect(calls).toEqual([[rootKey]])
    expect(calls[0]).not.toEqual([traceIdFor("usess_child")])
    expect(result.latitudeSignal).toEqual(BADGE)
  })

  it("falls back to sessionUsageId when the session predates F3a (no root)", async () => {
    const session = makeSession({ sessionUsageId: "usess_solo", rootSessionUsageId: undefined })
    const soloKey = traceIdFor("usess_solo")
    const { index, calls } = fakeIndex(soloKey)
    const handler = createAgentUsageSessionDetailHandler(fakeDb(session), index)

    const result = (await handler(ctx, { sessionUsageId: "usess_solo" })) as {
      latitudeSignal: LatitudeSignalBadge | null
    }

    expect(calls).toEqual([[soloKey]])
    expect(result.latitudeSignal).toEqual(BADGE)
  })

  it("returns latitudeSignal:null on a miss, keeping the base trace intact", async () => {
    const session = makeSession()
    const { index } = fakeIndex(null) // never hits
    const handler = createAgentUsageSessionDetailHandler(fakeDb(session), index)

    const result = (await handler(ctx, { sessionUsageId: "usess_child" })) as {
      latitudeSignal: LatitudeSignalBadge | null
      session: AgentUsageSession
      events: unknown[]
      children: unknown[]
    }

    expect(result.latitudeSignal).toBeNull()
    expect(result.session.sessionUsageId).toBe("usess_child")
    expect(result.events).toEqual([])
    expect(result.children).toEqual([])
  })

  it("degrades to null (never throws) when the index is not wired", async () => {
    const session = makeSession()
    const handler = createAgentUsageSessionDetailHandler(fakeDb(session), null)

    const result = (await handler(ctx, { sessionUsageId: "usess_child" })) as {
      latitudeSignal: LatitudeSignalBadge | null
    }

    expect(result.latitudeSignal).toBeNull()
  })

  it("swallows a projection error → null badge, trace still returned", async () => {
    const session = makeSession()
    const { index } = fakeIndex(traceIdFor("usess_root"), { throws: true })
    const handler = createAgentUsageSessionDetailHandler(fakeDb(session), index)

    const result = (await handler(ctx, { sessionUsageId: "usess_child" })) as {
      latitudeSignal: LatitudeSignalBadge | null
      session: AgentUsageSession
    }

    expect(result.latitudeSignal).toBeNull()
    expect(result.session.sessionUsageId).toBe("usess_child")
  })

  it("still throws NOT_FOUND for a missing session (badge code doesn't mask it)", async () => {
    const { index } = fakeIndex(null)
    const handler = createAgentUsageSessionDetailHandler(fakeDb(null), index)

    await expect(handler(ctx, { sessionUsageId: "usess_ghost" })).rejects.toThrow(/not found/i)
  })
})
