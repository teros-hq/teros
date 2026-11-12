/**
 * Contract for tool-call header copy under `mca.tools.<mca>.<tool>`
 * (description standard — docs/mcas/05-RENDERER.md §2, primitives/tool-description.ts).
 *
 * Every tool group, in every locale:
 *   - has the four phase strings: pending, running, completed, failed;
 *   - when any phase interpolates a name, ships the four `<phase>Generic`
 *     variants, and those carry no placeholder (they are what the header shows
 *     when a name is unknown or id-shaped);
 *   - uses the same placeholders as en-US for each string;
 *   - has no trailing ellipsis (the status dot already says "in progress").
 *
 * Plus: every key a migrated renderer asks for through its description hook exists.
 */

import { describe, expect, it } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"

const ROOT = join(import.meta.dir, "../../..")
const LOCALES = ["en-US", "es-ES", "ko-KR"] as const
const PHASES = ["pending", "running", "completed", "failed"] as const

type ToolStrings = Record<string, string>
type ToolsTree = Record<string, Record<string, ToolStrings>>

function loadTools(locale: string): ToolsTree {
  const json = JSON.parse(
    readFileSync(join(ROOT, `packages/app/src/i18n/locales/${locale}.json`), "utf8"),
  ) as { mca?: { tools?: ToolsTree } }
  return json.mca?.tools ?? {}
}

function placeholders(s: string): string[] {
  return [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort()
}

const trees = Object.fromEntries(LOCALES.map((l) => [l, loadTools(l)])) as Record<
  (typeof LOCALES)[number],
  ToolsTree
>

describe("mca.tools description copy", () => {
  for (const locale of LOCALES) {
    for (const [mca, tools] of Object.entries(trees[locale])) {
      for (const [tool, strings] of Object.entries(tools)) {
        const id = `${locale} ${mca}.${tool}`

        it(`${id} has the four phases`, () => {
          for (const phase of PHASES) expect(typeof strings[phase]).toBe("string")
        })

        it(`${id} ships placeholder-free generics when it interpolates names`, () => {
          const interpolates = PHASES.some((p) => placeholders(strings[p] ?? "").length > 0)
          if (!interpolates) return
          for (const phase of PHASES) {
            const generic = strings[`${phase}Generic`]
            expect(typeof generic).toBe("string")
            expect(placeholders(generic)).toEqual([])
          }
        })

        it(`${id} matches en-US placeholders and has no trailing ellipsis`, () => {
          const en = trees["en-US"][mca]?.[tool] ?? {}
          for (const [key, value] of Object.entries(strings)) {
            expect(placeholders(value)).toEqual(placeholders(en[key] ?? ""))
            expect(value.endsWith("…") || value.endsWith("...")).toBe(false)
          }
        })
      }
    }
  }
})

// Literal tool keys each renderer passes to its description hook — including ternaries.
const RENDERER_KEYS = [
  { file: "TerosCoreRenderer.tsx", hook: "useCoreDescription", mca: "terosCore" },
  { file: "BoardRenderer.tsx", hook: "useBoardDescription", mca: "board" },
  { file: "scheduler/RemindersRenderer.tsx", hook: "useSchedulerDescription", mca: "scheduler" },
  { file: "scheduler/RecurringTasksRenderer.tsx", hook: "useSchedulerDescription", mca: "scheduler" },
] as const

for (const { file, hook, mca } of RENDERER_KEYS) {
  describe(`${file} description keys`, () => {
    const src = readFileSync(join(ROOT, "packages/app/src/components/mca/renderers", file), "utf8")
    const used = new Set<string>()
    for (const call of src.matchAll(new RegExp(`${hook}\\(([\\s\\S]*?)status`, "g"))) {
      // Skip literals that are compared against (`verb === 'created' ? …`), not keys.
      for (const lit of call[1].matchAll(/(?<!=== )'([a-zA-Z]+)'/g)) used.add(lit[1])
    }
    // Keys chosen indirectly (e.g. a fallback switch returning { key: '…' }).
    for (const lit of src.matchAll(/return \{\s*key: '([a-zA-Z]+)'/g)) used.add(lit[1])

    it("finds the calls", () => {
      expect(used.size).toBeGreaterThan(5)
    })

    it(`every key exists in en-US mca.tools.${mca}`, () => {
      const tools = trees["en-US"][mca] ?? {}
      const missing = [...used].filter((k) => !(k in tools))
      expect(missing).toEqual([])
    })
  })
}
