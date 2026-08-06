/**
 * Tests for the session-trace assembler (F2 / TER-643).
 *
 * The assembler's whole job is JOINING + ORDERING, so those are exactly what
 * the tests pin: each LLM call must carry the text of ITS message (joined by
 * messageId == messages.info.id, the join the schema actually uses — not _id),
 * its own 👍/👎, and the events must come out in chronological order with a
 * stable tiebreaker. A wrong join key or a broken comparator is the failure
 * mode this guards.
 */

import { describe, expect, it } from "bun:test"
import {
  assembleSessionTrace,
  type SessionTrace,
  type TraceChannelMessage,
  type TraceEvent,
} from "../../src/services/session-trace-assembler"
import type {
  AgentUsageSession,
  LLMUsage,
  MessageFeedback,
  ToolExecution,
} from "../../src/types/database"

const session = (over: Partial<AgentUsageSession> = {}): AgentUsageSession =>
  ({ sessionUsageId: "su_1", agentId: "ag_1", status: "completed", ...over }) as AgentUsageSession

const llm = (usageId: string, messageId: string, step: number, atMs: number): LLMUsage =>
  ({
    usageId,
    messageId,
    step,
    timestamp: new Date(atMs),
    provider: "teros",
    modelId: "kimi",
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    costTotal: 0,
  }) as LLMUsage

const tool = (id: string, stepIndex: number, toolCallIndex: number, atMs: number): ToolExecution =>
  ({
    toolExecutionId: id,
    sessionUsageId: "su_1",
    stepIndex,
    toolCallIndex,
    toolName: "bash",
    status: "success",
    durationMs: 100,
    startedAt: new Date(atMs),
  }) as ToolExecution

// timestamp is an ISO STRING in the live channel_messages data (not a Date) —
// the fixture mirrors that so a `.getTime()`-on-a-string regression is caught.
const TS = "2026-06-30T10:00:00.000Z"
const cmsg = (messageId: string, text: string): TraceChannelMessage => ({
  messageId,
  role: "assistant",
  content: { type: "text", text },
  timestamp: TS,
})

const fb = (messageId: string, rating: "up" | "down"): MessageFeedback =>
  ({ messageId, rating }) as MessageFeedback

function trace(over: Partial<Parameters<typeof assembleSessionTrace>[0]> = {}): SessionTrace {
  return assembleSessionTrace({
    session: session(),
    toolExecutions: [],
    llmUsages: [],
    channelMessages: [],
    feedback: [],
    descendants: [],
    ...over,
  })
}

type LlmEvent = Extract<TraceEvent, { kind: "llm" }>
const llmEvents = (t: SessionTrace): LlmEvent[] =>
  t.events.filter((e): e is LlmEvent => e.kind === "llm")

describe("assembleSessionTrace — joins (F2)", () => {
  it("joins each LLM call to ITS message text by messageId == messages.info.id", () => {
    const t = trace({
      llmUsages: [llm("u1", "msg_a", 0, 100), llm("u2", "msg_b", 1, 200)],
      channelMessages: [cmsg("msg_a", "first"), cmsg("msg_b", "second")],
    })
    const calls = llmEvents(t)
    expect(calls).toHaveLength(2)
    // The text must follow the messageId, not the position.
    expect(calls[0]!.llm.message!.text).toBe("first")
    expect(calls[1]!.llm.message!.text).toBe("second")
    // The ISO-string timestamp is coerced to epoch ms (regression: it was a
    // string, and `.getTime()` threw on it in the live data).
    expect(calls[0]!.llm.message!.createdAt).toBe(Date.parse(TS))
  })

  it("message is null when no channel_message matches the messageId", () => {
    const t = trace({ llmUsages: [llm("u1", "missing", 0, 100)], channelMessages: [] })
    expect(llmEvents(t)[0]!.llm.message).toBeNull()
  })

  it("non-text content yields text:null + the real contentType (image/file/tool…)", () => {
    const t = trace({
      llmUsages: [llm("u1", "msg_img", 0, 100)],
      channelMessages: [
        { messageId: "msg_img", role: "assistant", content: { type: "image" }, timestamp: new Date(1) },
      ],
    })
    const m = llmEvents(t)[0]!.llm.message!
    expect(m.text).toBeNull()
    expect(m.contentType).toBe("image")
  })

  it("attaches 👍/👎 by messageId; null when there is none", () => {
    const t = trace({
      llmUsages: [llm("u1", "msg_a", 0, 100), llm("u2", "msg_b", 1, 200)],
      channelMessages: [cmsg("msg_a", "a"), cmsg("msg_b", "b")],
      feedback: [fb("msg_a", "up")],
    })
    const calls = llmEvents(t)
    expect(calls[0]!.llm.feedback!.rating).toBe("up")
    expect(calls[1]!.llm.feedback).toBeNull()
  })
})

describe("assembleSessionTrace — ordering (F2)", () => {
  it("interleaves llm + tool events in chronological order", () => {
    const t = trace({
      llmUsages: [llm("u1", "m1", 0, 100), llm("u2", "m2", 2, 300)],
      toolExecutions: [tool("t1", 1, 0, 200)],
      channelMessages: [],
    })
    expect(t.events.map((e) => e.kind)).toEqual(["llm", "tool", "llm"])
  })

  it("is robust to unsorted input (sorts by timestamp regardless of array order)", () => {
    const t = trace({
      llmUsages: [llm("late", "m2", 1, 999), llm("early", "m1", 0, 1)],
      channelMessages: [],
    })
    expect(llmEvents(t).map((e) => e.llm.usageId)).toEqual(["early", "late"])
  })

  it("tiebreak: an LLM call sorts before its step's tools at the same instant", () => {
    const t = trace({
      llmUsages: [llm("u1", "m1", 0, 500)],
      toolExecutions: [tool("t1", 0, 0, 500)],
      channelMessages: [],
    })
    expect(t.events.map((e) => e.kind)).toEqual(["llm", "tool"])
  })
})

describe("assembleSessionTrace — subagent tree (F2)", () => {
  it("returns direct descendants sorted by startedAt", () => {
    const t = trace({
      descendants: [
        session({ sessionUsageId: "child_late", startedAt: new Date(900) }),
        session({ sessionUsageId: "child_early", startedAt: new Date(100) }),
      ],
    })
    expect(t.children.map((c) => c.sessionUsageId)).toEqual(["child_early", "child_late"])
  })

  it("an empty turn yields no events and no children (clean empty state)", () => {
    const t = trace()
    expect(t.events).toEqual([])
    expect(t.children).toEqual([])
    expect(t.session.sessionUsageId).toBe("su_1")
  })
})

describe("assembleSessionTrace — resolved names (P6, 2026-07-07 audit)", () => {
  it("resolves the session agent, user and workspace names, and each child's agent BY ITS OWN id", () => {
    const t = trace({
      session: session({ agentId: "ag_1" }),
      descendants: [session({ sessionUsageId: "child_1", agentId: "ag_2", startedAt: new Date(100) })],
      names: {
        agentNameById: new Map([
          ["ag_1", "Iria"],
          ["ag_2", "Alice"],
        ]),
        userName: "Antonio",
        workspaceName: "Teros HQ",
      },
    })
    expect(t.agentName).toBe("Iria")
    expect(t.userName).toBe("Antonio")
    expect(t.workspaceName).toBe("Teros HQ")
    // The child resolves by ITS agentId — not the parent's (join-key bug guard).
    expect(t.children[0]!.agentName).toBe("Alice")
  })

  it("leaves names undefined when unresolved (honest fallback to raw ids in the UI)", () => {
    const t = trace({ names: { agentNameById: new Map(), userName: undefined, workspaceName: undefined } })
    expect(t.agentName).toBeUndefined()
    expect(t.userName).toBeUndefined()
    expect(t.workspaceName).toBeUndefined()
  })

  it("omitting names entirely keeps the legacy shape working", () => {
    const t = trace()
    expect(t.agentName).toBeUndefined()
  })
})

describe("assembleSessionTrace — PII text gate (TER-671 / A6.3)", () => {
  it("keeps the conversation text when redactText is false/omitted (super)", () => {
    const t = trace({
      llmUsages: [llm("u1", "msg_a", 0, 100)],
      channelMessages: [cmsg("msg_a", "secret partner text")],
    })
    expect(llmEvents(t)[0]!.llm.message!.text).toBe("secret partner text")
  })

  it("nulls the text but keeps the message structure when redactText is true (non-super admin)", () => {
    const t = trace({
      redactText: true,
      llmUsages: [llm("u1", "msg_a", 0, 100)],
      channelMessages: [cmsg("msg_a", "secret partner text")],
    })
    const m = llmEvents(t)[0]!.llm.message!
    // Mutation guard: dropping the redactText branch leaks the plaintext → red.
    expect(m.text).toBeNull()
    // Structure the admin still needs stays visible.
    expect(m.role).toBe("assistant")
    expect(m.contentType).toBe("text")
    expect(m.createdAt).toBe(Date.parse(TS))
    // Token/timing structure is untouched by redaction.
    expect(llmEvents(t)[0]!.llm.totalTokens).toBe(15)
  })
})
