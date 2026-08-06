/**
 * Contract — catalog presentation fields (TER-524).
 *
 * The new fields (tagline, screenshots, changelog, verified, homepage) are
 * OPTIONAL and additive: existing manifests without them keep parsing, a
 * manifest carrying them parses when the values are valid, and the bounds
 * (tagline length, screenshot URLs) are enforced. Fixtures are derived from
 * REAL catalog manifests so the test exercises the actual schema, not a mock.
 */

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { MCAManifestRefinedSchema } from "./mca-manifest.js"

const MCAS_DIR = join(import.meta.dir, "../../../mcas")
function loadManifest(mcaId: string): Record<string, any> {
  return JSON.parse(readFileSync(join(MCAS_DIR, mcaId, "manifest.json"), "utf8"))
}

describe("catalog presentation fields (TER-524)", () => {
  it("retro-compat: a manifest without catalog fields still parses", () => {
    const base = loadManifest("mca.teros.bash")
    base.tagline = undefined
    base.screenshots = undefined
    base.changelog = undefined
    base.verified = undefined
    base.homepage = undefined
    expect(MCAManifestRefinedSchema.safeParse(base).success).toBe(true)
  })

  it("accepts valid tagline, screenshots, changelog, verified and homepage", () => {
    const m = {
      ...loadManifest("mca.teros.bash"),
      tagline: "Run shell commands in a sandboxed container.",
      screenshots: ["https://os.teros.ai/shots/bash-1.png"],
      changelog: [{ version: "1.0.0", date: "2026-01-01", notes: "Initial release." }],
      verified: true,
      homepage: "https://teros.ai",
    }
    expect(MCAManifestRefinedSchema.safeParse(m).success).toBe(true)
  })

  it("rejects a tagline longer than 120 characters", () => {
    const m = { ...loadManifest("mca.teros.bash"), tagline: "x".repeat(121) }
    expect(MCAManifestRefinedSchema.safeParse(m).success).toBe(false)
  })

  it("rejects screenshots that are not valid URLs", () => {
    const m = { ...loadManifest("mca.teros.bash"), screenshots: ["not-a-url"] }
    expect(MCAManifestRefinedSchema.safeParse(m).success).toBe(false)
  })

  it("the mca.teros.core seed carries tagline + changelog + verified", () => {
    const core = loadManifest("mca.teros.core")
    expect(typeof core.tagline).toBe("string")
    expect(core.verified).toBe(true)
    expect(Array.isArray(core.changelog)).toBe(true)
    expect(core.changelog[0]).toHaveProperty("version")
  })
})
