/**
 * Invariante registry-sync de mca.teros.datetime (TER-503, patrón TER-498).
 *
 * El LLM lee tools.json, NO la fuente TS (criterio 3). Este invariante nació
 * MORDIENDO: get-current (la tool más básica) faltaba en tools.json — el
 * agente no podía consultar la hora actual.
 */

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { TOOLS } from "../../mcp/src/handlers"

const ROOT = resolve(import.meta.dir, "../..")
const toolsJson = JSON.parse(readFileSync(`${ROOT}/tools.json`, "utf8"))

describe("registry-sync — tools.json ↔ TOOLS", () => {
  it("hay 8 tools definidas", () => {
    expect(TOOLS.length).toBe(8)
  })

  it("names 1:1 (get-current incluido — el drift que motivó el regen)", () => {
    const srcNames = TOOLS.map((t: { name: string }) => t.name).sort()
    // biome-ignore lint/suspicious/noExplicitAny: shape del tools.json
    const jsonNames = toolsJson.tools.map((t: any) => t.name).sort()
    expect(srcNames).toEqual(jsonNames)
    expect(srcNames).toContain("get-current")
  })

  it.each(TOOLS.map((t: { name: string }) => [t.name] as const))(
    "%s: description e inputSchema EXACTOS",
    (name) => {
      const src = TOOLS.find((t: { name: string }) => t.name === name)
      // biome-ignore lint/suspicious/noExplicitAny: shape del tools.json
      const json = toolsJson.tools.find((t: any) => t.name === name)
      expect(json, `${name} ausente de tools.json`).toBeDefined()
      expect(json.description).toBe(src?.description)
      expect(json.inputSchema).toEqual(src?.inputSchema)
    },
  )
})
