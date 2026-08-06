/**
 * Invariante registry-sync de mca.teros.holded (TER-502, patrón TER-498).
 * El LLM lee tools.json, NO la fuente TS (criterio 3; incidentes TER-222/312).
 * Los -health-check registrados inline (sin symbol) entran por el lado
 * solo-name del names-1:1.
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

const mod = await import("../../src/tools")

describe("registry-sync — tools.json ↔ src", () => {
  it("hay 4 tools con symbol", () => {
    expect(registered.length).toBe(4)
  })

  it("names 1:1 entre server.tool() y tools.json (incl. inline)", () => {
    const srcNames = [...indexSource.matchAll(/server\.tool\('([^']+)'/g)].map((m) => m[1]).sort()
    // biome-ignore lint/suspicious/noExplicitAny: shape del tools.json
    const jsonNames = toolsJson.tools.map((t: any) => t.name).sort()
    expect(srcNames).toEqual(jsonNames)
  })

  it.each(registered.map((r) => [r.name, r.symbol] as const))(
    "%s: description y parameters EXACTOS",
    (name, symbol) => {
      // biome-ignore lint/suspicious/noExplicitAny: acceso dinámico al módulo
      const config = (mod as any)[symbol]
      expect(config, `${symbol} no se exporta desde src/tools`).toBeDefined()
      const json = jsonByName.get(name)
      expect(json, `${name} ausente de tools.json`).toBeDefined()
      expect(json?.description).toBe(config.description)
      expect(json?.inputSchema).toEqual(config.parameters)
    },
  )
})
