/**
 * Regression test for memory-calculate-importance (TER-536).
 *
 * Bug: handler declared parameter as `_context` but body referenced
 * `context` → ReferenceError on every invocation. The tool was 100%
 * broken — calculateImportance is pure but ensureQdrantInitialized(context)
 * crashed before it could run.
 *
 * Ported from PR #207 (TER-395/mca-tests-batch).
 */

import { describe, expect, it, mock } from "bun:test"

let ensureQdrantCalls: unknown[] = []

mock.module("../../src/qdrant-init", () => ({
  ensureQdrantInitialized: async (ctx: unknown) => {
    ensureQdrantCalls.push(ctx)
  },
}))

const { memoryCalculateImportance } = await import(
  "../../src/tools/memory-calculate-importance"
)

// biome-ignore lint/suspicious/noExplicitAny: context fake
const ctx: any = {
  execution: { userId: "user_1", appId: "app_1" },
  getSystemSecrets: async () => ({}),
}

describe("memory-calculate-importance — regression", () => {
  it("handler runs without ReferenceError (was: _context vs context)", async () => {
    ensureQdrantCalls = []
    const result = await memoryCalculateImportance.handler(
      { userMessage: "hola", assistantResponse: "mundo" },
      ctx,
    )
    expect(result).toHaveProperty("success", true)
    expect(result).toHaveProperty("importance")
    expect(result).toHaveProperty("breakdown")
  })

  it("ensureQdrantInitialized receives the context object", async () => {
    ensureQdrantCalls = []
    await memoryCalculateImportance.handler(
      { userMessage: "a", assistantResponse: "b" },
      ctx,
    )
    expect(ensureQdrantCalls.length).toBe(1)
    expect(ensureQdrantCalls[0]).toBe(ctx)
  })

  it("importance score reflects file/command counts", async () => {
    const result = await memoryCalculateImportance.handler(
      {
        userMessage: "hola",
        assistantResponse: "mundo",
        filesModified: ["a.ts"],
        commandsRun: ["ls"],
      },
      ctx,
    )
    expect((result as any).breakdown).toEqual({
      messageLength: 4,
      responseLength: 5,
      filesModified: 1,
      commandsRun: 1,
    })
  })
})
