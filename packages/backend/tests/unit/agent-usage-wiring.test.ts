/**
 * Wiring regression test for the agent-usage instrumentation.
 *
 * The PR #106 rebase against origin/dev (cca9174b) demonstrated that the
 * usage subsystem is trivial to neutralize by an upstream refactor: a
 * `--ours` adoption of ChannelWorker silently dropped the lifecycle calls
 * (session.start / session.end / sessionUsageId propagation / tool wrapper),
 * leaving build green + unit tests green + endpoints registered, but the
 * `agent_usage_sessions` and `tool_executions` projections empty in
 * production.
 *
 * Build-green is NOT enough — every type in the chain is `?: optional`
 * (intentionally, so the core stays agnostic), so removing the call sites
 * doesn't break compilation. This test asserts the call sites EXIST by
 * grepping the source files for the canonical invocations.
 *
 * If this test fails: the wiring is broken. Restoring the invocations to their
 * canonical form is mandatory before merging.
 */

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const SRC = resolve(__dirname, "../../src")

function read(rel: string): string {
  return readFileSync(resolve(SRC, rel), "utf8")
}

describe("agent-usage wiring (regression detector against neutralization by upstream refactors)", () => {
  it("processAgentResponse opens a usage session before cm.prompt(...)", () => {
    const src = read("handlers/message-handler.ts")
    expect(src).toMatch(/agentUsageSessionService\.start\s*\(/)
  })

  it("processAgentResponse closes the usage session in a finally block", () => {
    const src = read("handlers/message-handler.ts")
    expect(src).toMatch(/agentUsageSessionService\.end\s*\(/)
  })

  it("processAgentResponse wraps the turn in usageContext.run(...)", () => {
    const src = read("handlers/message-handler.ts")
    expect(src).toMatch(/usageContext\.run\s*\(/)
  })

  it("processAgentResponse resolves parentSessionUsageId from the async context", () => {
    const src = read("handlers/message-handler.ts")
    expect(src).toMatch(/usageContext\.getStore\s*\(\s*\)\??\.sessionUsageId/)
  })

  it("getToolExecutor wires toolExecutionService into the executor", () => {
    const src = read("handlers/message-handler.ts")
    expect(src).toMatch(/setToolExecutionService\s*\(/)
  })

  it("McaToolExecutor.executeTool accepts sessionUsageId in its options", () => {
    const src = read("services/mca-tool-executor.ts")
    expect(src).toMatch(/sessionUsageId\??:\s*string/)
    expect(src).toMatch(/stepIndex\??:\s*number/)
    expect(src).toMatch(/toolCallIndex\??:\s*number/)
  })

  it("McaToolExecutor wraps the MCA invocation with runInstrumented(...)", () => {
    const src = read("services/mca-tool-executor.ts")
    const matches = src.match(/this\.runInstrumented\s*\(/g) ?? []
    // Both call paths (bypassPermissions + permission-checked) must be wrapped.
    expect(matches.length).toBeGreaterThanOrEqual(2)
  })

  it("websocket-handler forwards agentUsageHealthDeps to registerAdminApiDomain", () => {
    const src = read("handlers/websocket-handler.ts")
    // Find the registerAdminApiDomain call and verify it carries the field.
    const callMatch = src.match(/registerAdminApiDomain\s*\(\s*this\.wsRouter\s*,\s*\{[\s\S]*?\}\s*\)/)
    expect(callMatch).not.toBeNull()
    expect(callMatch![0]).toMatch(/agentUsageHealthDeps/)
  })

  it("TurnDriver passes sessionUsageId + stepIndex + toolCallIndex to executeTool", () => {
    const src = readFileSync(
      resolve(__dirname, "../../../core/src/conversation/TurnDriver.ts"),
      "utf8",
    )
    expect(src).toMatch(/sessionUsageId:\s*input\.sessionUsageId/)
    expect(src).toMatch(/stepIndex:\s*step/)
    expect(src).toMatch(/toolCallIndex/)
  })

  it("TurnDriver propagates sessionUsageId to publishMessageComplete", () => {
    const src = readFileSync(
      resolve(__dirname, "../../../core/src/conversation/TurnDriver.ts"),
      "utf8",
    )
    // Look for the publishMessageComplete invocation block (multiline args)
    // and require it contains `input.sessionUsageId` as one of the args.
    // NOTE: `[\s\S]*?` (not `[^;]*?`) so a `;` inside an inline comment within
    // the call args (TER-615 added one) doesn't truncate the match early.
    const callBlockMatch = src.match(
      /publishMessageComplete\([\s\S]*?\);/,
    )
    expect(callBlockMatch).not.toBeNull()
    expect(callBlockMatch![0]).toContain("input.sessionUsageId")
  })

  it("PromptInput declares sessionUsageId as an optional field", () => {
    const src = readFileSync(
      resolve(__dirname, "../../../core/src/conversation/ConversationManager.ts"),
      "utf8",
    )
    expect(src).toMatch(/sessionUsageId\??:\s*string/)
  })
})
