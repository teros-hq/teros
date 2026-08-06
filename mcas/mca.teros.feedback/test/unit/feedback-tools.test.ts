/**
 * Regression test for mca.teros.feedback (TER-536).
 *
 * Bug: handlers read context.userId / userDisplayName / userAvatarUrl /
 * agentId at TOP-LEVEL of ToolContext, but identity lives in
 * context.execution (McaExecutionContext) → reportedBy was undefined →
 * backend returned 400 on every submit. Both tools 100% broken.
 *
 * Ported from PR #207 (TER-395/mca-tests-batch).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"

process.env.MCA_BACKEND_URL = "http://localhost:3000"
process.env.SECRET_MCA_FEEDBACK_API_TOKEN = "fbtok_test"

const { reportBug, reportSuggestion, submitFeedback } = await import("../../src/tools")

const realFetch = globalThis.fetch
let requests: Array<{ url: string; init: RequestInit }> = []
let nextResponse: () => Response = () =>
  new Response(JSON.stringify({ success: true, feedbackId: "fb_abc" }), { status: 201 })

beforeAll(() => {
  // biome-ignore lint/suspicious/noExplicitAny: compatible with global fetch
  globalThis.fetch = (async (url: any, init: any) => {
    requests.push({ url: String(url), init })
    return nextResponse()
  }) as typeof fetch
})

afterEach(() => {
  requests = []
  nextResponse = () =>
    new Response(JSON.stringify({ success: true, feedbackId: "fb_abc" }), { status: 201 })
})

afterAll(() => {
  globalThis.fetch = realFetch
})

const EXECUTION = {
  userId: "user_42",
  appId: "app_1",
  agentId: "agent_iria",
  userDisplayName: "Antonio",
  userAvatarUrl: "https://cdn/avatar.png",
}

// biome-ignore lint/suspicious/noExplicitAny: context fake
const ctx: any = { execution: EXECUTION }

describe("submitFeedback — HTTP boundary", () => {
  it("rewrites localhost to host.docker.internal + sends token header", async () => {
    await submitFeedback({ type: "bug", title: "t", description: "d", reportedBy: "user_42" })
    expect(requests.length).toBe(1)
    expect(requests[0].url).toBe("http://host.docker.internal:3000/api/feedback/submit")
    expect(requests[0].init.method).toBe("POST")
    expect(requests[0].init.headers).toEqual({
      "Content-Type": "application/json",
      "X-Feedback-Token": "fbtok_test",
    })
  })

  it("!ok response → throws data.error", async () => {
    nextResponse = () =>
      new Response(
        JSON.stringify({ success: false, error: "Missing required fields" }),
        { status: 400 },
      )
    await expect(
      submitFeedback({ type: "bug", title: "t", description: "d", reportedBy: "u" }),
    ).rejects.toThrow("Missing required fields")
  })

  it("!ok non-JSON → throws 'Invalid JSON response'", async () => {
    nextResponse = () => new Response("gateway timeout", { status: 504 })
    await expect(
      submitFeedback({ type: "bug", title: "t", description: "d", reportedBy: "u" }),
    ).rejects.toThrow("Invalid JSON response")
  })
})

describe("report-bug — REGRESSION: identity from context.execution", () => {
  it("body uses context.execution.userId (was undefined before fix)", async () => {
    await reportBug.handler(
      { title: "Crash", description: "Steps: …", severity: "high" },
      ctx,
    )
    const body = JSON.parse(requests[0].init.body as string)
    expect(body.reportedBy).toBe("user_42")
    expect(body.reportedByName).toBe("Antonio")
    expect(body.reportedByAvatarUrl).toBe("https://cdn/avatar.png")
    expect(body.agentId).toBe("agent_iria")
  })

  it("minimal execution (no displayName/avatar) → keys omitted from JSON", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: minimal context
    const minimal: any = { execution: { userId: "user_7", appId: "app_1" } }
    await reportBug.handler({ title: "t", description: "d" }, minimal)
    const body = JSON.parse(requests[0].init.body as string)
    expect(body.reportedBy).toBe("user_7")
    expect(body.reportedByName).toBeUndefined()
  })
})

describe("report-suggestion — REGRESSION: identity from context.execution", () => {
  it("body uses context.execution.userId for suggestions too", async () => {
    await reportSuggestion.handler(
      { title: "Dark mode", description: "Please" },
      ctx,
    )
    const body = JSON.parse(requests[0].init.body as string)
    expect(body.reportedBy).toBe("user_42")
    expect(body.type).toBe("suggestion")
  })

  it("backend error propagates", async () => {
    nextResponse = () => new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })
    await expect(reportSuggestion.handler({ title: "t", description: "d" }, ctx)).rejects.toThrow(
      "Unauthorized",
    )
  })
})
