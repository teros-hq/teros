#!/usr/bin/env bun
/**
 * Check Protocol Parity with @agentapps/protocol
 *
 * The approval path's tool metadata is aligned with `@agentapps/protocol` by
 * hand: `McaToolAnnotationsSchema` (packages/shared/src/mca-protocol.ts) mirrors
 * that package's `ToolAnnotationsSchema`, and the field names in
 * `types/tool-details.ts` mirror its `ToolDefinitionSchema`. Teros does not
 * depend on the package — there is no import to keep the two honest, only a
 * comment claiming "the two cannot drift". This script is what makes that claim
 * checkable.
 *
 * It verifies three things, in order of how quietly each would break:
 *
 *   1. The two annotation schemas declare the same fields and parse a shared
 *      corpus identically — including tolerating an unknown key, which is the
 *      forward-compatibility property a future `.strict()` would destroy.
 *   2. A tool definition parsed by the REAL upstream `ToolDefinitionSchema`
 *      flows through `toolDetailFromDefinition` into the ranking and intent
 *      layers. That adapter exists precisely for the transport migration; this
 *      is the only thing that exercises it against genuine protocol output
 *      rather than a hand-written lookalike.
 *   3. The host honours the normative obligations the protocol documents for
 *      `intentTemplate` — the placeholder grammar and every decline condition.
 *      Those are MUSTs in the upstream docstring, so a host that quietly stops
 *      satisfying one is out of spec even though nothing here fails to compile.
 *
 * WHY THIS IS A SCRIPT AND NOT A TEST. It needs a sibling checkout that CI does
 * not have. A test would have to skip when the checkout is absent, and a
 * skipping test reads as coverage while verifying nothing — the same trap
 * `docs/standards/TESTING-STRATEGY.md` documents for the unexecuted Cucumber
 * lane. So this fails loudly instead: no sibling repo, no build, no result.
 *
 * Usage:
 *   bun scripts/check-protocol-parity.ts
 *   AGENTAPPS_PATH=/path/to/agentapps bun scripts/check-protocol-parity.ts
 *
 * Exits 0 when every check agrees, 1 otherwise.
 */

import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { rankParams } from "../packages/app/src/components/mca/primitives/param-relevance"
import {
  type IntentSource,
  renderIntentTemplate,
  resolveIntent,
} from "../packages/app/src/components/mca/primitives/permission-intent"
import { toolDetailFromDefinition } from "../packages/app/src/components/mca/tool-definition-adapter"
import { McaToolAnnotationsSchema } from "../packages/shared/src/mca-protocol"

// ─── locating the sibling checkout ──────────────────────────────────────────

const DEFAULT_PATH = resolve(import.meta.dir, "../../agentapps")
const agentappsPath = process.env.AGENTAPPS_PATH
  ? resolve(process.env.AGENTAPPS_PATH)
  : DEFAULT_PATH
const distEntry = resolve(agentappsPath, "packages/protocol/dist/index.js")

function bail(message: string): never {
  console.error(`\n✗ ${message}\n`)
  process.exit(1)
}

if (!existsSync(agentappsPath)) {
  bail(
    `No agentapps checkout at ${agentappsPath}.\n` +
      `  Clone it beside this repo, or set AGENTAPPS_PATH.\n` +
      `  This script cannot verify parity against a package that is not present, and\n` +
      `  deliberately does not skip — a skipped parity check is worse than none.`,
  )
}
if (!existsSync(distEntry)) {
  bail(
    `agentapps is present but @agentapps/protocol is not built (${distEntry} missing).\n` +
      `  Run:  cd ${agentappsPath} && pnpm install && pnpm build\n` +
      `  The built dist is read rather than the TS source so this checks the same\n` +
      `  artifact a consumer would install.`,
  )
}

const upstream = (await import(distEntry)) as {
  ToolAnnotationsSchema: { shape: Record<string, unknown>; safeParse: (v: unknown) => SafeParse }
  ToolDefinitionSchema: { safeParse: (v: unknown) => SafeParse }
}
const { ToolAnnotationsSchema, ToolDefinitionSchema } = upstream

if (!ToolAnnotationsSchema || !ToolDefinitionSchema) {
  bail(
    "@agentapps/protocol built, but it does not export ToolAnnotationsSchema and " +
      "ToolDefinitionSchema. The package's public surface changed; update this script.",
  )
}

interface SafeParse {
  success: boolean
  data?: unknown
}

// ─── reporting ──────────────────────────────────────────────────────────────

let failures = 0

function check(ok: boolean, label: string, detail?: string): void {
  if (ok) {
    console.log(`  ✓ ${label}`)
    return
  }
  failures += 1
  console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ""}`)
}

/**
 * Key order differs between the two declarations (Teros groups `alwaysAsk` with
 * `irreversible`, upstream groups it with the approval block) and is immaterial
 * on the wire, so compare by sorted entries rather than by `JSON.stringify` of
 * the parsed object.
 */
function sameValues(a: unknown, b: unknown): boolean {
  const norm = (o: unknown) =>
    JSON.stringify(Object.entries((o ?? {}) as Record<string, unknown>).sort())
  return norm(a) === norm(b)
}

// ─── 1. annotation schema parity ────────────────────────────────────────────

console.log(`\nagentapps: ${agentappsPath}`)
console.log("\n1. Annotation schema parity")

const terosKeys = Object.keys(McaToolAnnotationsSchema.shape).sort()
const upstreamKeys = Object.keys(ToolAnnotationsSchema.shape).sort()
const terosOnly = terosKeys.filter((k) => !upstreamKeys.includes(k))
const upstreamOnly = upstreamKeys.filter((k) => !terosKeys.includes(k))

check(
  terosOnly.length === 0 && upstreamOnly.length === 0,
  `field sets match (${terosKeys.length} fields)`,
  terosOnly.length || upstreamOnly.length
    ? `only in teros: ${terosOnly.join(", ") || "—"} | only in agentapps: ${upstreamOnly.join(", ") || "—"}`
    : undefined,
)

/**
 * Each case must parse identically on both sides. The `unknown key` case is the
 * load-bearing one: both schemas must ACCEPT and strip it, because a newer app
 * may send annotations this version has never heard of. Upstream's
 * `app-manifest.ts` already uses `.strict()` in five places, so the precedent to
 * break this exists.
 */
const ANNOTATION_CORPUS: Array<[string, unknown]> = [
  [
    "every field populated",
    {
      version: "1.2.0",
      stability: "stable",
      deprecationMessage: "use send-message-v2",
      irreversible: true,
      alwaysAsk: true,
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
      summary: "Deletes a file",
      group: "Files",
      intentTemplate: "Delete the file at {path}",
    },
  ],
  ["empty object", {}],
  ["unknown key is tolerated and stripped", { futureThing: "tolerate-me" }],
  ["mistyped intentTemplate rejected", { intentTemplate: { text: "x" } }],
  ["mistyped alwaysAsk rejected", { alwaysAsk: "true" }],
  ["mistyped summary rejected", { summary: ["a"] }],
  ["unknown stability rejected", { stability: "wobbly" }],
  ["non-boolean irreversible rejected", { irreversible: 1 }],
]

for (const [label, input] of ANNOTATION_CORPUS) {
  const t = McaToolAnnotationsSchema.safeParse(input)
  const u = ToolAnnotationsSchema.safeParse(input)
  const agree = t.success === u.success && sameValues(t.data, u.data)
  check(agree, label, agree ? undefined : `teros=${t.success} agentapps=${u.success}`)
}

/**
 * The corpus above is hand-written and therefore always incomplete: it caught a
 * field being dropped, but caught a `group: string → number` retype only
 * incidentally, folded into the all-fields case. This sweep is the general form.
 *
 * For every declared field, offer each of three sentinel values and require both
 * schemas to reach the same verdict. A field retyped on one side accepts a
 * sentinel the other rejects, so the disagreement surfaces against the exact
 * field name rather than as a vague whole-object mismatch.
 */
const SENTINELS: Array<[string, unknown]> = [
  ["string", "probe"],
  ["number", 1],
  ["boolean", true],
]
const fieldSweep = terosKeys.filter((key) => upstreamKeys.includes(key))
const disagreed: string[] = []
for (const key of fieldSweep) {
  for (const [kind, value] of SENTINELS) {
    const t = McaToolAnnotationsSchema.safeParse({ [key]: value })
    const u = ToolAnnotationsSchema.safeParse({ [key]: value })
    if (t.success !== u.success)
      disagreed.push(`${key}:${kind} (teros=${t.success} agentapps=${u.success})`)
  }
}
check(
  disagreed.length === 0,
  `per-field type sweep agrees (${fieldSweep.length} fields × ${SENTINELS.length} sentinels)`,
  disagreed.join("; "),
)

// ─── 2. a real upstream ToolDefinition flows through the host ───────────────

console.log("\n2. Upstream ToolDefinition → host adapter → ranking and intent")

const definitionInput = {
  name: "delete-file",
  description: "Delete a file from the workspace",
  parameters: {
    type: "object" as const,
    properties: {
      path: { type: "string", description: "Absolute path of the file to delete" },
      recursive: { type: "boolean" },
    },
    required: ["path"],
  },
  annotations: {
    destructiveHint: true,
    irreversible: true,
    summary: "Removes a file from the workspace",
    intentTemplate: "Delete the file at {path}",
  },
}

const parsed = ToolDefinitionSchema.safeParse(definitionInput)
check(parsed.success, "upstream ToolDefinitionSchema accepts the fixture")

if (!parsed.success) {
  console.error("\n✗ Cannot continue section 2 — the fixture is not a valid ToolDefinition.\n")
  process.exit(1)
}

// The adapter is fed the schema's OUTPUT, not the literal above, so anything the
// upstream parse strips or coerces is what the host actually receives.
const definition = parsed.data as Parameters<typeof toolDetailFromDefinition>[1]
const detail = toolDetailFromDefinition("mydrive_delete-file", definition)

check(detail.name === "delete-file", "adapter carries the bare tool name")
check(detail.requestedName === "mydrive_delete-file", "adapter preserves the namespaced name")
check(
  detail.parameters.required?.[0] === "path",
  "adapter carries `parameters` (the protocol's field name)",
)
check(
  detail.annotations?.intentTemplate === "Delete the file at {path}",
  "annotations survive the adapter intact",
)

const ranked = rankParams({ path: "/srv/report.pdf", recursive: true }, detail.parameters)
check(ranked[0]?.key === "path", "schema-required param ranks first")
check(
  ranked[0]?.description === "Absolute path of the file to delete",
  "per-property description reaches the ranked row",
)

const intent = resolveIntent({
  toolName: "mydrive_delete-file",
  input: { path: "/srv/report.pdf" },
  detail: { description: detail.description, annotations: detail.annotations },
  fallbackText: "Wants to delete file",
})
check(
  intent.source === ("template" satisfies IntentSource) &&
    intent.text === "Delete the file at /srv/report.pdf",
  "intentTemplate from a real ToolDefinition wins and interpolates",
  `got source=${intent.source} text=${JSON.stringify(intent.text)}`,
)
check(
  detail.annotations?.destructiveHint === true && detail.annotations?.irreversible === true,
  "the two irreversibility signals survive to where the badge rule reads them",
)
// Not asserted here: the fail-closed rule itself (`isIrreversible`, which ORs the
// manifest flag with either annotation). It lives in `CapabilityBadges.tsx`, whose
// module imports tamagui and therefore the whole React Native tree — pulling that
// in to check a schema would make this script depend on the frontend's full
// dependency graph and stop it running in a lean checkout. The rule is covered by
// `tests/unit/components/mca/irreversibleChain.test.ts`; what matters here is only
// that the upstream annotations reach it unaltered, which the check above pins.

// ─── 3. the host honours the documented MUSTs ──────────────────────────────

console.log("\n3. Host satisfies the obligations the protocol documents")

/**
 * Upstream's `intentTemplate` docstring pins the grammar as `{` + one or more of
 * `[A-Za-z0-9_]` + `}`, states that any other brace sequence is literal, and
 * requires a host to DECLINE when a referenced parameter is absent or is not a
 * non-empty string, a finite number, or a boolean. `null` expected below means
 * "must decline".
 */
const TEMPLATE_CASES: Array<[string, string, Record<string, unknown> | undefined, string | null]> =
  [
    ["string interpolates", "Delete {path}", { path: "a.txt" }, "Delete a.txt"],
    ["number interpolates", "Fetch {count} rows", { count: 20 }, "Fetch 20 rows"],
    ["boolean interpolates", "Recursive: {deep}", { deep: true }, "Recursive: true"],
    ["no placeholders renders", "Lists your calendars", {}, "Lists your calendars"],
    ["absent param declines", "Delete {path}", {}, null],
    ["object param declines", "Send to {to}", { to: { email: "a@b.c" } }, null],
    ["array param declines", "Delete {paths}", { paths: ["a"] }, null],
    ["null param declines", "Delete {path}", { path: null }, null],
    ["blank string declines", "Delete {path}", { path: "   " }, null],
    ["NaN declines", "Fetch {count}", { count: Number.NaN }, null],
    ["Infinity declines", "Fetch {count}", { count: Number.POSITIVE_INFINITY }, null],
    [
      "hyphenated name is outside the grammar and declines",
      "Share {file-id}",
      { "file-id": "x" },
      null,
    ],
    [
      "dotted name is outside the grammar and declines",
      "Fetch {page.size}",
      { "page.size": 10 },
      null,
    ],
    ["unmatched brace declines", "Delete {path", { path: "a.txt" }, null],
    ["empty braces decline", "Set {} to 5", {}, null],
    [
      "brace inside an argument value still renders",
      "Delete {path}",
      { path: "a{b}c" },
      "Delete a{b}c",
    ],
  ]

for (const [label, template, input, expected] of TEMPLATE_CASES) {
  const got = renderIntentTemplate(template, input)
  check(got === expected, label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`)
}

// Plain text, never markup: an argument must not be able to alter how the
// sentence READS. Bidi overrides and zero-width characters are the vector.
const BIDI_CASES: Array<[string, string]> = [
  ["bidi override stripped", "safe.txt‮gpj.exe"],
  ["LRO stripped", "a‭b"],
  ["zero-width space stripped", "safe​.txt"],
  ["RLM stripped", "a‏b"],
  ["BEL stripped", "ab"],
  ["BOM stripped", "a﻿b"],
]
for (const [label, value] of BIDI_CASES) {
  const got = renderIntentTemplate("Delete {p}", { p: value })
  const clean = got !== null && !/[\p{Cc}\p{Cf}]/u.test(got)
  check(clean, label, `output still carries a control/format char: ${JSON.stringify(got)}`)
}

// Hosts MAY bound the rendered length — Teros does, and the author's own text
// must survive a long argument rather than being clipped away.
const longArg = "x".repeat(500)
const clipped = renderIntentTemplate("Delete {path} from production", { path: longArg })
check(
  clipped?.endsWith("from production") === true,
  "a long argument is clipped but the template's own words survive",
  `got ${JSON.stringify(clipped?.slice(0, 60))}…`,
)

// ─── 4. the host's wire response is a valid upstream ToolDefinition ────────

console.log("\n4. Host wire shape validates as an upstream ToolDefinition")

// `requestedName` is a host-side routing field with no upstream counterpart;
// everything else the handler emits must satisfy ToolDefinitionSchema.
const { requestedName: _routing, ...wire } = detail
const wireCheck = ToolDefinitionSchema.safeParse(wire)
check(
  wireCheck.success,
  "app.get-tool-details output (minus requestedName) parses upstream",
  wireCheck.success ? undefined : JSON.stringify(wireCheck),
)

// ─── verdict ───────────────────────────────────────────────────────────────

if (failures > 0) {
  console.error(`\n✗ ${failures} parity check${failures === 1 ? "" : "s"} failed.\n`)
  process.exit(1)
}
console.log("\n✓ All parity checks agree.\n")
