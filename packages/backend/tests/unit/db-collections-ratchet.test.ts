/**
 * Ratchet — raw collection access only shrinks (GOV-1).
 *
 * Collection names come from src/db/collections.ts and access migrates domain
 * by domain into src/db. Until that is done, this test keeps things from
 * getting worse: every collection named by a literal must be registered in
 * COLLECTIONS, and the number of raw `.collection(` calls outside src/db and
 * src/migrations may not grow. When a migration lowers the count, lower
 * RAW_CALLS_BASELINE to the new number in the same commit.
 */

import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { isKnownCollection, workspaceFilter } from "../../src/db"

const SRC = resolve(__dirname, "../../src")
const RAW_CALLS_BASELINE = 717 // +1: mca-connection-manager resolves the MCA stream viewer directly (MCA streams, 804553c16, 2026-11-04); prior +4: agent mailbox lifecycle (tn_PcquTN30AawbK8uE, 2026-11-01) — grantAccess hook + connection-manager secret resolution + provision-mailbox endpoint, all on COLLECTIONS-registered collections; prior pre-existing drift (712 vs 669) unrelated to this task; prior +6: feedback-triage lifecycle views + out-of-band intake read/write todo nodes and feedback docs directly (4a7e9254a, 2026-10-28); prior +1: costs_access_logs audit logger (task_6de67c22b163387a, 2026-10-27); prior +4: evaluator consent-gate reads users/agent_usage_sessions directly (5191e74de, 2026-10-26)

const CALL = /\.collection(?:<[^>]*>)?\(/g
const LITERAL = /\.collection(?:<[^>]*>)?\(\s*['"]([A-Za-z_]+)['"]/g

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : []
  })
}

const files = sourceFiles(SRC).map((path) => ({ rel: relative(SRC, path), text: readFileSync(path, "utf-8") }))

describe("db collections ratchet (GOV-1)", () => {
  it("every collection named by a literal is registered in COLLECTIONS", () => {
    const unknown = new Set<string>()
    // Migrations are history: a migration that encrypts or drops a collection
    // names it as it existed then (app_user_auth left COLLECTIONS with apps
    // v2.2, e8cbd5017), so they are not held to today's registry — same
    // carve-out the raw-call count below already makes.
    for (const { rel, text } of files) {
      if (rel.startsWith("migrations/")) continue
      for (const m of text.matchAll(LITERAL)) {
        if (!isKnownCollection(m[1])) unknown.add(`${m[1]} (${rel})`)
      }
    }
    expect([...unknown]).toEqual([])
  })

  it(`raw .collection( calls outside src/db and src/migrations stay at or below ${RAW_CALLS_BASELINE}`, () => {
    const count = files
      .filter(({ rel }) => !rel.startsWith("db/") && !rel.startsWith("migrations/"))
      .reduce((n, { text }) => n + (text.match(CALL)?.length ?? 0), 0)
    expect(count).toBeLessThanOrEqual(RAW_CALLS_BASELINE)
  })
})

describe("workspaceFilter", () => {
  it("adds workspaceId to the filter", () => {
    expect(workspaceFilter<{ workspaceId: string; status: string }>("work_a", { status: "active" })).toEqual({
      status: "active",
      workspaceId: "work_a",
    })
  })

  it("throws without a workspaceId", () => {
    expect(() => workspaceFilter("")).toThrow("workspaceId is required")
    expect(() => workspaceFilter(undefined as unknown as string)).toThrow("workspaceId is required")
  })
})
