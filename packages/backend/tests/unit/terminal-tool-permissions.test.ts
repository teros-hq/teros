import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { McaToolAnnotations } from "@teros/shared"
import { installSeedPermission } from "../../src/types/permissions"

const { tools } = JSON.parse(
  readFileSync(join(import.meta.dir, "../../../../mcas/mca.teros.terminal/tools.json"), "utf8"),
) as { tools: Array<{ name: string; annotations?: McaToolAnnotations }> }

describe("mca.teros.terminal tools added after Terminal apps were installed", () => {
  it("[TW-AC-22] the tool that asked for a Claude sign-in is gone, and the two control tools carry their new names", () => {
    const names = tools.map((t) => t.name)
    expect(names).not.toContain("terminal-request-sign-in")
    expect(names).not.toContain("terminal-request-wheel")
    expect(names).not.toContain("terminal-release-wheel")
  })

  it.each(["terminal-request-control", "terminal-release-control"])(
    "[TW-AC-24] %s is seeded 'allow' by the MCA-update seed as a safe write (it is not read-only), not left on 'ask'",
    (name) => {
      const tool = tools.find((t) => t.name === name)
      expect(tool).toBeDefined()
      expect(tool?.annotations?.readOnlyHint).not.toBe(true)
      expect(tool?.annotations?.safeWriteHint).toBe(true)
      expect(installSeedPermission({ name, annotations: tool?.annotations })).toBe("allow")
    },
  )
})
