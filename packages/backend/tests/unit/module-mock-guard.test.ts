/**
 * Guard — no unit test may mock.module an auth module.
 *
 * bun applies mock.module to the whole test run, not just the file that calls
 * it: mca-actions-evaluator.test.ts replaced auth/auth-helpers with a no-op
 * requireSystemAdmin, and every admin-gate test that happened to run after it
 * (mca-health, test-mca-tool, update-core, ...) saw non-admins let through.
 * auth-service-password-reset.test.ts did the same to auth/api-tokens. Stub the
 * Db the helper reads instead (seed a users row, an api_tokens collection).
 */

import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const UNIT = __dirname
const AUTH_MOCK = /mock\.module\(\s*['"][^'"]*\/src\/auth\/[^'"]*['"]/

describe("module mock guard", () => {
  it("no unit test mock.module's src/auth/* (it leaks into every later file)", () => {
    const offenders = readdirSync(UNIT)
      .filter((name) => name.endsWith(".test.ts"))
      .filter((name) =>
        readFileSync(join(UNIT, name), "utf-8")
          .split("\n")
          .some((line) => !line.trim().startsWith("//") && AUTH_MOCK.test(line)),
      )
    expect(offenders).toEqual([])
  })
})
