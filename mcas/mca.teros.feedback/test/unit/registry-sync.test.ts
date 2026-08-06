/**
 * Registry-sync invariant for mca.teros.feedback (TER-536).
 *
 * Validates 1:1 correspondence between server.tool() registrations in
 * source and tool entries in tools.json. Catches phantom tools (defined
 * in JSON but disabled in code) and missing tools (registered but invisible
 * to LLM).
 *
 * Ported from PR #207 (TER-395/mca-tests-batch).
 */

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

process.env.MCA_BACKEND_URL = "http://localhost:3000"
process.env.SECRET_MCA_FEEDBACK_API_TOKEN = "fbtok_test"

const ROOT = resolve(import.meta.dir, "../..")
const indexSource = readFileSync(`${ROOT}/src/index.ts`, "utf8")
const toolsJson = JSON.parse(readFileSync(`${ROOT}/tools.json`, "utf8"))

const registered = [...indexSource.matchAll(/server\.tool\('([^']+)',\s*([A-Za-z0-9_]+)\)/g)].map(
  (m) => ({ name: m[1], symbol: m[2] }),
)

const jsonByName = new Map<string, { description: string; inputSchema: unknown }>(
  // biome-ignore lint/suspicious/noExplicitAny: tools.json shape
  toolsJson.tools.map((t: any) => [t.name, t]),
)

const mod = await import("../../src/tools")

describe("registry-sync — tools.json ↔ src", () => {
  it("2 tools registered", () => {
    expect(registered.length).toBe(2)
  })

  it("names 1:1 between server.tool() and tools.json", () => {
    const srcNames = registered.map((r) => r.name).sort()
    // biome-ignore lint/suspicious/noExplicitAny: tools.json shape
    const jsonNames = toolsJson.tools.map((t: any) => t.name).sort()
    expect(srcNames).toEqual(jsonNames)
  })

  it.each(registered.map((r) => [r.name, r.symbol] as const))(
    "%s: description and parameters match",
    (name, symbol) => {
      // biome-ignore lint/suspicious/noExplicitAny: dynamic module access
      const config = (mod as any)[symbol]
      expect(config, `${symbol} not exported from src/tools`).toBeDefined()
      const json = jsonByName.get(name)
      expect(json, `${name} missing from tools.json`).toBeDefined()
      expect(json?.description).toBe(config.description)
      expect(json?.inputSchema).toEqual(config.parameters)
    },
  )
})
