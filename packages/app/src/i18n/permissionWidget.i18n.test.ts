/**
 * PERMW-AC-5 — every string of the permission widget resolves through `t()`
 * with a key present in the three locales (PERMW-REQ-5).
 *
 * Reads the widget's source files, collects every literal `t("…")` key and
 * checks each one in en-US, es-ES and ko-KR. A key used with `{ count }` may be
 * stored with i18next plural suffixes; `<key>_other` counts as present.
 *
 *   cd packages/app && bun test src/i18n/permissionWidget.i18n.test.ts
 */
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import enUS from "./locales/en-US.json"
import esES from "./locales/es-ES.json"
import koKR from "./locales/ko-KR.json"

const SRC = join(import.meta.dir, "..")

/** The widget: the card chrome, the detail, the bar, the batch frame, the sheet and the window. */
const WIDGET_FILES = [
  "components/mca/primitives/ControlsBar.tsx",
  "components/mca/primitives/ConfirmDialog.tsx",
  "components/mca/primitives/GroupedPermissionPanel.tsx",
  "components/mca/primitives/PermissionDetail.tsx",
  "components/mca/primitives/AnnotatedParamsTable.tsx",
  "components/mca/primitives/CapabilityBadges.tsx",
  "components/mca/primitives/HeaderRow.tsx",
  "components/navbar/PermissionIndicator.tsx",
  "windows/PendingApprovalsWindow/PendingApprovalsWindowContent.tsx",
]

const LOCALES: Record<string, unknown> = { "en-US": enUS, "es-ES": esES, "ko-KR": koKR }

function lookup(bundle: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>(
    (node, part) => (node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined),
    bundle,
  )
}

function hasKey(bundle: unknown, key: string): boolean {
  const plain = lookup(bundle, key)
  if (typeof plain === "string" && plain.trim()) return true
  const other = lookup(bundle, `${key}_other`)
  return typeof other === "string" && other.trim().length > 0
}

function keysUsedIn(file: string): string[] {
  const source = readFileSync(join(SRC, file), "utf8")
  return [...source.matchAll(/\bt\(\s*["'`]([A-Za-z0-9_.]+)["'`]/g)].map((m) => m[1])
}

describe("[PERMW-AC-5] permission widget strings come from i18n", () => {
  const used = new Set(WIDGET_FILES.flatMap(keysUsedIn))

  it("[PERMW-AC-5] the widget files use t() keys", () => {
    for (const prefix of ["mca.permission.", "mca.permissionGroup.", "mca.permissionDetail."]) {
      expect([...used].some((key) => key.startsWith(prefix))).toBe(true)
    }
  })

  for (const [locale, bundle] of Object.entries(LOCALES)) {
    it(`[PERMW-AC-5] ${locale}: every widget key exists`, () => {
      const missing = [...used].filter((key) => !hasKey(bundle, key))
      expect(missing).toEqual([])
    })
  }

  it("[PERMW-AC-5] no widget string is left in MCA_STRINGS", () => {
    for (const file of WIDGET_FILES) {
      const source = readFileSync(join(SRC, file), "utf8")
      expect(source).not.toMatch(/MCA_STRINGS\.(permission|permissionGroup|permissionDetail)\b/)
    }
  })

  it("[PERMW-AC-5] the always pair reads as a rule in English", () => {
    expect(lookup(enUS, "mca.permission.allowAlways")).toBe("Always allow")
    expect(lookup(enUS, "mca.permission.denyAlways")).toBe("Always deny")
  })
})
