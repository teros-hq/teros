import { createRequire } from "node:module"
import { describe, expect, it } from "vitest"

const require = createRequire(import.meta.url)

describe("metro.config lucide per-icon resolution", () => {
  it("[LOADP-AC-6] web resolves a per-icon Lucide import to the ESM file, everything else falls through", () => {
    const config = require("../../metro.config.js")
    const fallback = (_ctx: unknown, name: string) => ({ filePath: `fallback:${name}`, type: "sourceFile" })
    const ctx = { resolveRequest: fallback }

    const web = config.resolver.resolveRequest(ctx, "@tamagui/lucide-icons/icons/Columns", "web")
    expect(web.filePath).toMatch(/@tamagui\/lucide-icons\/dist\/esm\/icons\/Columns\.mjs$/)
    expect(require("node:fs").existsSync(web.filePath)).toBe(true)

    // Not web: the default resolver decides.
    expect(config.resolver.resolveRequest(ctx, "@tamagui/lucide-icons/icons/Columns", "ios").filePath).toBe(
      "fallback:@tamagui/lucide-icons/icons/Columns",
    )
    // Not a per-icon request: untouched.
    expect(config.resolver.resolveRequest(ctx, "@tamagui/lucide-icons", "web").filePath).toBe(
      "fallback:@tamagui/lucide-icons",
    )
  })
})
