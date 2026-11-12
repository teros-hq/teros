/**
 * Invariante registry-sync de mca.teros.datetime (TER-503, patrón TER-498).
 *
 * El LLM lee tools.json, NO la fuente TS (criterio 3). Este invariante nació
 * MORDIENDO: get-current (la tool más básica) faltaba en tools.json — el
 * agente no podía consultar la hora actual.
 *
 * v0.9.1: la fuente de verdad es TOOL_REGISTRY (src/tools/index.ts), donde
 * cada tool es un ToolConfig del SDK ({description, parameters, annotations}).
 * El fix de este cambio añade un invariante más: las 8 tools son funciones
 * PURAS, así que tools.json debe declarar readOnlyHint: true en todas —
 * un false siembra 'ask' indebidamente en el frontend.
 */

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { TOOL_REGISTRY } from "../../src/tools"

const ROOT = resolve(import.meta.dir, "../..")
const toolsJson = JSON.parse(readFileSync(`${ROOT}/tools.json`, "utf8"))

describe("registry-sync — tools.json ↔ TOOL_REGISTRY", () => {
  it("hay 8 tools definidas", () => {
    expect(TOOL_REGISTRY.length).toBe(8)
  })

  it("names 1:1 (get-current incluido — el drift que motivó el primer regen)", () => {
    const srcNames = TOOL_REGISTRY.map((t) => t.name).sort()
    // biome-ignore lint/suspicious/noExplicitAny: shape del tools.json
    const jsonNames = toolsJson.tools.map((t: any) => t.name).sort()
    expect(srcNames).toEqual(jsonNames)
    expect(srcNames).toContain("get-current")
  })

  it.each(TOOL_REGISTRY.map((t) => [t.name] as const))(
    "%s: description e inputSchema EXACTOS",
    (name) => {
      const src = TOOL_REGISTRY.find((t) => t.name === name)
      // biome-ignore lint/suspicious/noExplicitAny: shape del tools.json
      const json = toolsJson.tools.find((t: any) => t.name === name)
      expect(json, `${name} ausente de tools.json`).toBeDefined()
      expect(json.description).toBe(src?.tool.description)
      expect(json.inputSchema).toEqual(src?.tool.parameters)
    },
  )

  // Nació del bug del fix v0.9.1: las 6 tools puras (format, parse,
  // convert-timezone, add, subtract, diff) estaban marcadas readOnlyHint:
  // false en tools.json y sembraban 'ask' indebidamente en el frontend.
  it("las 8 tools (funciones puras) declaran readOnlyHint: true en tools.json", () => {
    for (const t of toolsJson.tools) {
      expect(
        t.annotations?.readOnlyHint,
        `${t.name}: readOnlyHint debe ser true (tool pura, no muta nada)`,
      ).toBe(true)
    }
  })

  it("la fuente declara readOnlyHint: true en las 8 (drift fuente ↔ tools.json)", () => {
    for (const { name, tool } of TOOL_REGISTRY) {
      expect(
        tool.annotations?.readOnlyHint,
        `${name}: la fuente debe declarar readOnlyHint: true`,
      ).toBe(true)
    }
  })
})
