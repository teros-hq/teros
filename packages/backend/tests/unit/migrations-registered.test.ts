/**
 * Every migration file on disk must be registered in runner.ts (GOV-11).
 *
 * 20260923_002_secondary_indexes sat on disk unregistered for weeks (INF-1):
 * its indexes never existed in any environment and nothing noticed. This test
 * fails the moment a migration file is added without its MIGRATIONS entry.
 */

import { describe, expect, it } from "bun:test"
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { MIGRATIONS } from "../../src/migrations/runner"

const MIGRATIONS_DIR = join(import.meta.dir, "../../src/migrations")

const onDisk = readdirSync(MIGRATIONS_DIR)
  .filter((f) => /^\d{8}_\d{3}_.+\.ts$/.test(f) && !f.endsWith(".test.ts"))
  .map((f) => f.replace(/\.ts$/, ""))
  .sort()

describe("migrations registry", () => {
  it("registers every migration file on disk", () => {
    const registered = new Set(MIGRATIONS.map((m) => m.name))
    expect(onDisk.filter((name) => !registered.has(name))).toEqual([])
  })

  it("has no registered migration without a file", () => {
    const files = new Set(onDisk)
    expect(MIGRATIONS.map((m) => m.name).filter((name) => !files.has(name))).toEqual([])
  })

  it("registers migrations in chronological order, without duplicates", () => {
    const names = MIGRATIONS.map((m) => m.name)
    expect(names).toEqual([...new Set(names)].sort())
  })
})
