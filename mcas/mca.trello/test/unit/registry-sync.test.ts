/**
 * Invariante registry-sync de mca.trello (TER-507, patrón TER-498).
 * Valida el regen de TER-474 + el port del SDK: names 1:1 (incl.
 * -health-check inline) + description/inputSchema EXACTOS.
 */

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const ROOT = resolve(import.meta.dir, "../..")
const indexSource = readFileSync(`${ROOT}/src/index.ts`, "utf8")
const toolsJson = JSON.parse(readFileSync(`${ROOT}/tools.json`, "utf8"))

const registered = [...indexSource.matchAll(/server\.tool\('([^']+)',\s*([A-Za-z0-9_]+)\)/g)].map(
  (m) => ({ name: m[1], symbol: m[2] }),
)

const jsonByName = new Map<string, { description: string; inputSchema: unknown }>(
  // biome-ignore lint/suspicious/noExplicitAny: shape del tools.json
  toolsJson.tools.map((t: any) => [t.name, t]),
)

const tools = await import("../../src/tools")

describe("registry-sync — tools.json ↔ src", () => {
  it("hay 19 tools con symbol + -health-check inline (20 total)", () => {
    expect(registered.length).toBe(19)
    const allNames = [...indexSource.matchAll(/server\.tool\('([^']+)'/g)].map((m) => m[1])
    expect(allNames.length).toBe(20)
  })

  it("names 1:1 entre server.tool() y tools.json", () => {
    const srcNames = [...indexSource.matchAll(/server\.tool\('([^']+)'/g)].map((m) => m[1]).sort()
    // biome-ignore lint/suspicious/noExplicitAny: shape del tools.json
    const jsonNames = toolsJson.tools.map((t: any) => t.name).sort()
    expect(srcNames).toEqual(jsonNames)
  })

  it.each(registered.map((r) => [r.name, r.symbol] as const))(
    "%s: description y parameters EXACTOS",
    (name, symbol) => {
      // biome-ignore lint/suspicious/noExplicitAny: acceso dinámico
      const config = (tools as any)[symbol]
      expect(config, `${symbol} no se exporta desde src/tools`).toBeDefined()
      const json = jsonByName.get(name)
      expect(json, `${name} ausente de tools.json`).toBeDefined()
      expect(json?.description).toBe(config.description)
      expect(json?.inputSchema).toEqual(config.parameters)
    },
  )
})
