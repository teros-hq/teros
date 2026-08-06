/**
 * Architectural invariants for the monitoring admin-api (A7.6 / TER-673).
 *
 * These are lint-as-tests: cheap source-level assertions that fail the build for
 * a whole CLASS of regressions a green unit suite would let through — the exact
 * kind that shipped the usage-chunk bug and the auto-denied-tools widget bug.
 * Pattern proven by `agent-usage-wiring.test.ts`.
 */

import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

const BACKEND = resolve(__dirname, "../../src")
const APP = resolve(__dirname, "../../../app/src")
const CORE_LLM = resolve(__dirname, "../../../core/src/llm")

function read(abs: string): string {
  return readFileSync(abs, "utf8")
}

const HANDLER_SRC = read(resolve(BACKEND, "handlers/domains/admin-api/agent-usage.ts"))
const REGISTER_SRC = read(resolve(BACKEND, "handlers/domains/admin-api/index.ts"))
const ADMIN_API_SRC = read(resolve(APP, "services/AdminApi.ts"))
const QUERY_HELPER_SRC = read(resolve(BACKEND, "services/agent-usage-query-helper.ts"))

describe("(a) every agent-usage handler guards before any other await", () => {
  // Split the source at each handler factory; the FIRST await inside each must be
  // the auth guard — a business-collection read before it is a cross-tenant leak.
  const blocks = HANDLER_SRC.split(/export function createAgentUsage\w+Handler/).slice(1)

  it("finds all ten handler factories", () => {
    // TER-700 added createAgentUsageUpstreamErrorsHandler (the upstream-errors feed).
    expect(blocks.length).toBe(10)
  })

  // Valid first-await auth guards: `requireSystemAdmin` (admin) or `getSystemRole`
  // (session-detail needs the role to super-gate the conversation text — TER-671).
  const AUTH_GUARDS = new Set(["requireSystemAdmin", "getSystemRole"])
  for (let i = 0; i < blocks.length; i++) {
    it(`handler #${i + 1} calls an auth guard as its first await`, () => {
      const firstAwait = blocks[i].match(/await\s+(\w+)/)
      expect(AUTH_GUARDS.has(firstAwait?.[1] ?? "")).toBe(true)
    })
  }
})

describe("(b) every admin-api.agent-usage action the frontend calls is registered backend-side", () => {
  const actionRe = /admin-api\.agent-usage-[a-z-]+/g
  const frontend = new Set([...ADMIN_API_SRC.matchAll(actionRe)].map((m) => m[0]))
  // Only the strings passed to router.register(...) count as registered.
  const registerRe = /router\.register\(\s*["'](admin-api\.agent-usage-[a-z-]+)["']/g
  const backend = new Set([...REGISTER_SRC.matchAll(registerRe)].map((m) => m[1]))

  it("the frontend calls at least the ten known actions", () => {
    expect(frontend.size).toBeGreaterThanOrEqual(10)
  })

  it("frontend action set === backend registered set", () => {
    // A rename/new action on one side without the other → silent empty dashboard.
    expect([...frontend].sort()).toEqual([...backend].sort())
  })
})

describe("(c) no adapter usage-chunk mock is unfaithful (usage in a chunk WITH choices)", () => {
  // The real OpenAI stream delivers `usage` in a final chunk with `choices: []`.
  // A mock that puts usage in a chunk carrying a populated `choices: [{…}]` blinds
  // the exact combine the usage-chunk bug relied on (A7.2). Known debt below is
  // tracked with the A2.1 double-count fix (TER-664); any NEW occurrence fails.
  const KNOWN_UNFAITHFUL = new Set(["OpenAICompatibleLLMAdapter.test.ts"])
  const unfaithful =
    /choices:\s*\[\s*\{[\s\S]*?\}\s*\]\s*,\s*usage:|usage:\s*\{[\s\S]*?\}\s*,\s*choices:\s*\[\s*\{/

  const adapterTests = readdirSync(CORE_LLM).filter((f) => f.endsWith(".test.ts"))

  it("finds adapter test files", () => {
    expect(adapterTests.length).toBeGreaterThan(0)
  })

  for (const f of adapterTests) {
    it(`${f} uses a faithful usage-chunk mock`, () => {
      if (KNOWN_UNFAITHFUL.has(f)) return // documented debt (TER-664)
      const src = read(resolve(CORE_LLM, f))
      expect(unfaithful.test(src)).toBe(false)
    })
  }
})

describe("(d) rollup-builder group-key references ⊆ the rollup groupKey dims", () => {
  // The rollup doc's groupKey is 4-dim; a builder that $matches `groupKey.X` for
  // an X not in it (e.g. triggerKind) silently returns nothing (A3.6). Keep the
  // filterable rollup dims a subset of what the rollup actually groups by.
  const GROUP_KEY_DIMS = new Set(["userId", "agentId", "provider", "workspaceId"])
  const referenced = new Set(
    [
      ...QUERY_HELPER_SRC.matchAll(/groupKey\.(\w+)/g),
      ...HANDLER_SRC.matchAll(/groupKey\.(\w+)/g),
    ].map((m) => m[1]),
  )

  it("references at least one group-key dim", () => {
    expect(referenced.size).toBeGreaterThan(0)
  })

  it("every referenced group-key dim exists in the rollup groupKey", () => {
    for (const dim of referenced) {
      expect(GROUP_KEY_DIMS.has(dim)).toBe(true)
    }
  })
})
