/**
 * Invariante registry-sync de mca.teros.playwright (TER-506, patrón TER-498).
 * Las tools se definen INLINE en index.ts (importarlo ejecuta start()) — sync
 * textual: names 1:1 + description literal de cada bloque.
 */

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const ROOT = resolve(import.meta.dir, "../..")
const indexSource = readFileSync(`${ROOT}/src/index.ts`, "utf8")
const toolsJson = JSON.parse(readFileSync(`${ROOT}/tools.json`, "utf8"))

const srcNames = [...indexSource.matchAll(/server\.tool\('([^']+)'/g)].map((m) => m[1])

const srcDescriptions = new Map(
  [...indexSource.matchAll(
    /server\.tool\('([^']+)',\s*\{\s*description:[\s\n]*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g,
  )].map((m) => [m[1], m[2].slice(1, -1)]),
)

describe("registry-sync — tools.json ↔ src (inline)", () => {
  it("hay 25 tools (24 browser-* + -health-check)", () => {
    expect(srcNames.length).toBe(25)
  })

  it("names 1:1", () => {
    // biome-ignore lint/suspicious/noExplicitAny: shape del tools.json
    const jsonNames = toolsJson.tools.map((t: any) => t.name).sort()
    expect([...srcNames].sort()).toEqual(jsonNames)
  })

  it("la regex de bloques inline toca las 25 (anti-NO-OP)", () => {
    expect(srcDescriptions.size).toBe(25)
  })

  it.each(srcNames.map((n) => [n] as const))("%s: description EXACTA", (name) => {
    // biome-ignore lint/suspicious/noExplicitAny: shape del tools.json
    const json = toolsJson.tools.find((t: any) => t.name === name)
    expect(json, `${name} ausente de tools.json`).toBeDefined()
    expect(json.description).toBe(srcDescriptions.get(name))
  })
})
