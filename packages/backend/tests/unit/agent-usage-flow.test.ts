/**
 * Functional flow test for the agent-usage instrumentation.
 *
 * Validates the contract between AgentUsageSessionService,
 * ToolExecutionService, the UsageEventBuffer, and the AsyncLocalStorage-based
 * `usageContext`. Complements `agent-usage-wiring.test.ts` (which only checks
 * that the call sites EXIST in source) by verifying that the events emitted
 * to the buffer carry the correct shape — the part the applier consumes to
 * populate the projections.
 *
 * Strategy: stub the buffer with a recording double that captures every event
 * synchronously. The buffer's real implementation is exercised in
 * `usage-event-buffer.test.ts`; here we focus on the SERVICE layer producing
 * the right payloads in the right order.
 */

import { beforeEach, describe, expect, it } from "bun:test"
import {
  AgentUsageSessionService,
  classifyError,
} from "../../src/services/agent-usage-session-service"
import { ToolExecutionService } from "../../src/services/tool-execution-service"
import { usageContext } from "../../src/services/agent-usage-context"
import type { AgentUsageEvent } from "../../src/types/database"

class RecordingBuffer {
  events: AgentUsageEvent[] = []
  emit(event: AgentUsageEvent): void {
    this.events.push(event)
  }
  byType<T extends AgentUsageEvent["type"]>(t: T): Extract<AgentUsageEvent, { type: T }>[] {
    return this.events.filter((e) => e.type === t) as any
  }
}

let buffer: RecordingBuffer
let sessions: AgentUsageSessionService
let tools: ToolExecutionService

const SESSION_INPUT = {
  parentSessionUsageId: null as string | null,
  triggerKind: "user_message" as const,
  userId: "user_a",
  agentId: "agent_x",
  workspaceId: "ws_1",
  channelId: "ch_1",
  provider: "anthropic" as any,
  modelId: "claude-sonnet-4-6",
}

beforeEach(() => {
  buffer = new RecordingBuffer()
  // Cast: the services only use `.emit()`; the recording double honors that.
  sessions = new AgentUsageSessionService(buffer as any)
  tools = new ToolExecutionService(buffer as any)
})

describe("AgentUsageSessionService", () => {
  it("T1: start + end (completed) emits session.started and session.ended with the same id", () => {
    const handle = sessions.start({ ...SESSION_INPUT })
    sessions.end({ handle, status: "completed" })

    const started = buffer.byType("session.started")
    const ended = buffer.byType("session.ended")
    expect(started.length).toBe(1)
    expect(ended.length).toBe(1)
    expect(started[0].sessionUsageId).toBe(handle.sessionUsageId)
    expect(ended[0].sessionUsageId).toBe(handle.sessionUsageId)
    expect(ended[0].payload.status).toBe("completed")
    expect(ended[0].payload.parentSessionUsageId).toBeNull()
    expect((ended[0].payload as any).durationMs).toBeGreaterThanOrEqual(0)
  })

  it("T3: end with errored + raw errorMessage sanitises PII before emission", () => {
    const handle = sessions.start({ ...SESSION_INPUT })
    sessions.end({
      handle,
      status: "errored",
      errorKind: "llm_error",
      errorMessage: "Failed for user alice@example.com with token sk_live_ABC123",
    })

    const ended = buffer.byType("session.ended")
    expect(ended.length).toBe(1)
    const msg = (ended[0].payload as any).errorMessage as string
    // The sanitiser redacts emails (current rule set, owned by
    // `agent-usage-pii-sanitizer.ts`). We assert that surface only.
    expect(msg).not.toContain("alice@example.com")
    expect(msg.toLowerCase()).toContain("[redacted_email]")
  })

  it("T4: end with aborted preserves status", () => {
    const handle = sessions.start({ ...SESSION_INPUT })
    sessions.end({ handle, status: "aborted", errorKind: "aborted_by_user" })
    const ended = buffer.byType("session.ended")
    expect(ended[0].payload.status).toBe("aborted")
    expect((ended[0].payload as any).errorKind).toBe("aborted_by_user")
  })

  it("classifyError taxonomy: aborted / network / validation / tool / llm / unknown", () => {
    expect(classifyError({ name: "AbortError" })).toBe("aborted_by_user")
    expect(classifyError({ message: "Interrupted by new message" })).toBe("aborted_by_user")
    expect(classifyError({ name: "FetchError" })).toBe("network_error")
    expect(classifyError({ type: "ValidationError" })).toBe("validation_error")
    expect(classifyError({ type: "ToolExecutionError" })).toBe("tool_error")
    expect(classifyError({ type: "LLMError" })).toBe("llm_error")
    expect(classifyError({ message: "request timeout" })).toBe("reconciled_timeout")
    expect(classifyError(null)).toBe("unknown")
    expect(classifyError("string error")).toBe("unknown")
  })
})

describe("ToolExecutionService", () => {
  it("T2: tool.start + tool.end carries the parent sessionUsageId as FK", () => {
    const sessionHandle = sessions.start({ ...SESSION_INPUT })
    const toolHandle = tools.start({
      sessionUsageId: sessionHandle.sessionUsageId,
      channelId: SESSION_INPUT.channelId,
      userId: SESSION_INPUT.userId,
      agentId: SESSION_INPUT.agentId,
      workspaceId: SESSION_INPUT.workspaceId,
      stepIndex: 0,
      toolCallIndex: 0,
      toolName: "browse-fetch",
      mcaId: "mca.browser",
      input: { url: "https://example.com" },
    })
    tools.end({
      sessionUsageId: sessionHandle.sessionUsageId,
      handle: toolHandle,
      status: "success",
      output: "Some content",
    })
    sessions.end({ handle: sessionHandle, status: "completed" })

    const started = buffer.byType("tool.started")
    const ended = buffer.byType("tool.ended")
    expect(started.length).toBe(1)
    expect(ended.length).toBe(1)
    expect(started[0].sessionUsageId).toBe(sessionHandle.sessionUsageId)
    expect(ended[0].sessionUsageId).toBe(sessionHandle.sessionUsageId)
    expect(started[0].toolExecutionId).toBe(toolHandle.toolExecutionId)
    expect(ended[0].toolExecutionId).toBe(toolHandle.toolExecutionId)
    expect(started[0].payload.toolName).toBe("browse-fetch")
    expect(started[0].payload.mcaId).toBe("mca.browser")
    expect(started[0].payload.stepIndex).toBe(0)
    expect(started[0].payload.toolCallIndex).toBe(0)
    expect((started[0].payload as any).inputSizeBytes).toBeGreaterThan(0)
    expect((ended[0].payload as any).outputSizeBytes).toBeGreaterThan(0)
  })
})

describe("usageContext (AsyncLocalStorage)", () => {
  it("T5: nested processAgentResponse recovers parentSessionUsageId from the parent scope", async () => {
    const parentHandle = sessions.start({ ...SESSION_INPUT })

    let resolvedParentInChild: string | null | undefined
    await usageContext.run(
      { sessionUsageId: parentHandle.sessionUsageId },
      async () => {
        // Simulate the child processAgentResponse reading the context.
        resolvedParentInChild = usageContext.getStore()?.sessionUsageId ?? null
        // Start a child session with that parent.
        sessions.start({
          ...SESSION_INPUT,
          parentSessionUsageId: resolvedParentInChild ?? null,
          triggerKind: "delegation",
        })
      },
    )

    expect(resolvedParentInChild).toBe(parentHandle.sessionUsageId)
    const started = buffer.byType("session.started")
    expect(started.length).toBe(2)
    const child = started.find((e) => e.payload.triggerKind === "delegation")
    expect(child).toBeDefined()
    expect(child!.payload.parentSessionUsageId).toBe(parentHandle.sessionUsageId)
  })

  it("getStore() outside run() returns undefined (no leak between unrelated turns)", () => {
    expect(usageContext.getStore()).toBeUndefined()
  })
})
