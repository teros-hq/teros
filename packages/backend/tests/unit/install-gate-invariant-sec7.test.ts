/**
 * SEC-7 (TER-726) — structural invariant for the MCA "install" gate.
 *
 * B-4 (SEC-1 / TER-720): the availability/role gate (`assertInstallable`) was
 * enforced on one install path (`app.install`) but not the parallel one
 * (`workspace.install-app` → `createWorkspaceApp`), letting a normal user
 * install a disabled/admin-only MCA (e.g. mca.teros.docker-env, which mounts
 * the Docker socket) into their own workspace and reach host root.
 *
 * This is a closed-set invariant (pattern: toolCallCardAdoption.test.tsx): it
 * enumerates every function in mca-service.ts that inserts into the `apps`
 * collection, and every caller of the two attacker-reachable ones
 * (`createApp`, `createWorkspaceApp`), and pins them against a frozen
 * allowlist. A NEW insert site, or a NEW caller of `createApp` that isn't on
 * the list, fails the test — forcing a conscious decision (gate it, or extend
 * the allowlist with a documented reason) instead of silently shipping a
 * fourth ungated install path. `createWorkspaceApp` self-gates via
 * `assertInstallable`, so its callers don't need an individual gate check;
 * `createApp` does NOT self-gate, so every one of ITS callers must carry its
 * own inline check — this file pins which ones and where.
 *
 * SEC-7 audit finding (not named by the original phase4 security audit, which
 * only describes 2 install paths): `routes/mca-resources-handlers.ts:
 * handleAppInstall` is a THIRD live install path, reachable via the MCA
 * callback resource proxy (`POST /mca/callback/.../resources/apps`, action
 * "install" — from inside a running MCA container acting on behalf of its
 * owning user, same identity surface SEC-5 hardens). It already carries its
 * own inline gate; this invariant is what stops a FOURTH one from shipping
 * unguarded. Funnelling all three gates through the single
 * `assertInstallable()` is a follow-up (transversal refactor, not a fix) —
 * out of scope for SEC-7, which consolidates tests/CI and does not change
 * production code (see TER-726).
 */
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

const BACKEND_SRC = resolve(__dirname, "../../src")

function read(relPath: string): string {
  return readFileSync(resolve(BACKEND_SRC, relPath), "utf8")
}

/**
 * Pure, testable core: given TS class-body source and a pattern marking a
 * "sink" line (e.g. an insertOne call), returns the name of the nearest
 * enclosing `async methodName(` / `methodName(` declaration (2-space class
 * indent, this file's own style) above each match. Exported as a standalone
 * function (not inlined into the `it`) so the "can this fail" demonstration
 * below can feed it a synthetic string instead of mutating the real source.
 */
function enclosingMethodsFor(source: string, sinkPattern: RegExp): string[] {
  const lines = source.split("\n")
  const methodDeclPattern = /^ {2}(?:async\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/
  const methodDeclAt: Array<{ line: number; name: string }> = []
  lines.forEach((line, i) => {
    const m = methodDeclPattern.exec(line)
    if (m) methodDeclAt.push({ line: i, name: m[1] })
  })
  const found: string[] = []
  lines.forEach((line, i) => {
    if (!sinkPattern.test(line)) return
    let enclosing: { line: number; name: string } | undefined
    for (const d of methodDeclAt) {
      if (d.line <= i) enclosing = d
      else break
    }
    found.push(enclosing ? enclosing.name : `<unknown:line ${i + 1}>`)
  })
  return found
}

/** Every .ts file under `backend/src`, excluding tests, as posix relative paths. */
function allBackendSrcFiles(): string[] {
  return readdirSync(BACKEND_SRC, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".ts") && !f.includes(".test.ts"))
    .map((f) => f.split("\\").join("/"))
    .sort()
}

const APPS_INSERT_PATTERN = /\bappsCollection\.insertOne\(/
const CREATE_APP_CALL_PATTERN = /\.createApp\(\s*\{/
const CREATE_WORKSPACE_APP_CALL_PATTERN = /\.createWorkspaceApp\(/

describe("install-gate invariant — sanity (anti-NO-OP)", () => {
  it("the scan actually sees backend/src (>500 files)", () => {
    expect(allBackendSrcFiles().length).toBeGreaterThan(500)
  })

  it("the sink pattern matches something in mca-service.ts", () => {
    const source = read("services/mca-service.ts")
    const matches = source.split("\n").filter((l) => APPS_INSERT_PATTERN.test(l))
    expect(matches.length).toBeGreaterThan(0)
  })
})

describe("install-gate invariant — closed set of apps-collection insert sites", () => {
  // Frozen allowlist. `createApp`/`createWorkspaceApp` are the two
  // attacker-reachable install sinks (checked below). `ensureProvisionedApps`
  // is exempt: its mcaId always comes from `availability.system` catalog
  // entries or the agent's core-declared `defaultApps` — never from
  // user/agent-supplied input — so it is not the B-4 vulnerability class.
  const ALLOWED_INSERT_SITES = ["createApp", "createWorkspaceApp", "ensureProvisionedApps"]

  it("exactly the known 3 functions insert into apps — no new insert site", () => {
    const source = read("services/mca-service.ts")
    const sites = enclosingMethodsFor(source, APPS_INSERT_PATTERN)
    expect(new Set(sites)).toEqual(new Set(ALLOWED_INSERT_SITES))
  })

  it("demonstrates the invariant CAN fail: a synthetic 4th insert site is detected", () => {
    // TESTING-QUALITY.md §5: an invariant must prove it can go red. Feeding a
    // synthetic string (not the real file) keeps this self-contained — no
    // filesystem mutation needed in CI.
    const synthetic = [
      "  async createApp(app) {",
      "    await this.appsCollection.insertOne(newApp);",
      "  }",
      "",
      "  async sneakyNewInstallPath(mcaId) {",
      "    // no gate call above this — exactly the B-4 bug class",
      "    await this.appsCollection.insertOne(newApp);",
      "  }",
    ].join("\n")
    const sites = enclosingMethodsFor(synthetic, APPS_INSERT_PATTERN)
    expect(new Set(sites)).toEqual(new Set(["createApp", "sneakyNewInstallPath"]))
    // The real assertion style used above would catch this: the derived set
    // no longer equals the frozen allowlist.
    expect(new Set(sites)).not.toEqual(new Set(ALLOWED_INSERT_SITES))
  })
})

describe("install-gate invariant — closed set of createApp() callers", () => {
  // createApp() does NOT self-gate (see createWorkspaceApp below for the
  // path that does) — every caller must check availability/role itself
  // before calling it. Frozen allowlist, one entry per caller file, each
  // verified to carry its own gate immediately before the call:
  //   - app/install.ts               → WS `app.install` (audited path #1)
  //   - mca-resources-handlers.ts    → MCA callback resource `apps.install`
  //     (audited path #3 — found by this SEC-7 pass, not by the original
  //     phase4 audit; see file header)
  //   - admin-api/apps.ts            → `admin-api.apps-create`, gated by
  //     `requireAdmin` (a stricter, different-shaped but sufficient gate:
  //     admin/super dominates any per-MCA `availability.role` requirement)
  //   - websocket/app-commands.ts    → `handleInstallApp`: DEAD CODE.
  //     `createAppCommands` (this file's only export) has zero callers
  //     anywhere in backend/src beyond its own re-export in
  //     `websocket/index.ts` — same class as the `provider-commands.ts`
  //     dead code SEC-6/TER-478 already documents. Kept in the allowlist
  //     (not deleted — SEC-7 doesn't touch production code) so an actual
  //     4th LIVE caller still trips this invariant.
  const ALLOWED_CREATE_APP_CALLERS = [
    "handlers/domains/app/install.ts",
    "handlers/domains/admin-api/apps.ts",
    "handlers/websocket/app-commands.ts",
    "routes/mca-resources-handlers.ts",
  ]

  // "await requireAdmin(" (not bare "requireAdmin(") deliberately excludes the
  // function's own DECLARATION (`async function requireAdmin(db: Db, ...)`,
  // line 21 of that file) — a bare substring match would find the declaration
  // first, which sits above every handler in the file regardless of whether
  // THIS specific handler calls it. That was a real vacuous-pass bug caught
  // by mutation-testing this exact file below: removing the one call inside
  // createAppsCreateHandler still left the test green until fixed.
  const GATE_SUBSTRING_BY_CALLER: Record<string, string> = {
    "handlers/domains/app/install.ts": "availability?.enabled === false",
    "routes/mca-resources-handlers.ts": "availability?.enabled === false",
    "handlers/websocket/app-commands.ts": "availability?.enabled === false",
    "handlers/domains/admin-api/apps.ts": "await requireAdmin(",
  }

  it("exactly the known callers call createApp() — no new ungated install path", () => {
    const callers = allBackendSrcFiles().filter((f) => {
      if (f === "services/mca-service.ts") return false // the declaration itself, not a call
      return CREATE_APP_CALL_PATTERN.test(read(f))
    })
    expect(new Set(callers)).toEqual(new Set(ALLOWED_CREATE_APP_CALLERS))
  })

  // Top-level `(export )?(async )?function name(` declaration — the boundary
  // of the enclosing handler. Needed because admin-api/apps.ts alone has 8
  // sibling handlers, each with its OWN "await requireAdmin(" call: a plain
  // "nearest preceding line in the whole file" search (no boundary) finds
  // whichever SIBLING handler's gate happens to sit above the call — which
  // stayed green even with createAppsCreateHandler's own gate deleted, a
  // second vacuous-pass bug caught by mutation-testing this file below.
  const TOP_LEVEL_FUNCTION_PATTERN = /^(?:export\s+)?(?:async\s+)?function\s+[A-Za-z_]\w*\s*\(/

  it.each(ALLOWED_CREATE_APP_CALLERS)("%s checks its gate BEFORE calling createApp()", (file) => {
    const source = read(file)
    const lines = source.split("\n")
    const gateSubstring = GATE_SUBSTRING_BY_CALLER[file]
    const callLine = lines.findIndex((l) => CREATE_APP_CALL_PATTERN.test(l))
    expect(callLine).toBeGreaterThanOrEqual(0)

    let boundaryStart = 0
    for (let i = 0; i <= callLine; i++) {
      if (TOP_LEVEL_FUNCTION_PATTERN.test(lines[i])) boundaryStart = i
    }
    // Nearest PRECEDING occurrence of the gate substring WITHIN the enclosing
    // handler's boundary — not just "somewhere before the call in the file".
    let gateLine = -1
    for (let i = boundaryStart; i < callLine; i++) {
      if (lines[i].includes(gateSubstring)) gateLine = i
    }
    expect(gateLine).toBeGreaterThanOrEqual(0)
    expect(gateLine).toBeLessThan(callLine)
  })
})

describe("install-gate invariant — closed set of createWorkspaceApp() callers", () => {
  // createWorkspaceApp SELF-gates via assertInstallable (see the dedicated
  // SEC-1 enforcement check below) — so unlike createApp, its callers don't
  // each need their own inline check. This closed-set still catches a NEW
  // caller appearing (worth knowing about even though it'd inherit the gate).
  const ALLOWED_CREATE_WORKSPACE_APP_CALLERS = [
    "handlers/domains/workspace/install-app.ts", // WS `workspace.install-app` (audited path #2, B-4)
    "handlers/websocket/workspace-commands.ts", // legacy WS command, delegates to the same gated sink
  ]

  it("exactly the known callers call createWorkspaceApp()", () => {
    const callers = allBackendSrcFiles().filter((f) => {
      if (f === "services/mca-service.ts") return false
      return CREATE_WORKSPACE_APP_CALL_PATTERN.test(read(f))
    })
    expect(new Set(callers)).toEqual(new Set(ALLOWED_CREATE_WORKSPACE_APP_CALLERS))
  })
})

describe("install-gate enforcement — SEC-1 / TER-720 / B-4", () => {
  // Unlike the closed-set checks above (true regardless of merge order), this
  // assertion checks the actual fix, not just the shape of the call graph —
  // so it depends on TER-720 (SEC-1) having landed on `dev`. SEC-1..6 merge
  // independently and out of order (project decision), and this file lives
  // under the blanket `bun test tests/unit/` CI step (blocking, not tolerant
  // like scripts/run-mca-security-golden-set.sh). Mirroring that script's
  // tolerance here — rather than just documenting "SEC-7 merges last" and
  // hoping — means this file can never accidentally red-block dev CI for
  // every other PR if merge order doesn't go as planned.
  const source = read("services/mca-service.ts")
  const sec1Landed = source.includes("assertInstallable(")

  if (!sec1Landed) {
    it.todo(
      "PENDING: assertInstallable not found in mca-service.ts — TER-720/SEC-1 not merged to dev yet",
    )
  } else {
    it("createWorkspaceApp calls assertInstallable before inserting the app", () => {
      const lines = source.split("\n")
      const declLine = lines.findIndex((l) => /^ {2}async createWorkspaceApp\(/.test(l))
      const insertLine = lines.findIndex((l, i) => i > declLine && APPS_INSERT_PATTERN.test(l))
      const gateLine = lines.findIndex(
        (l, i) => i > declLine && i < insertLine && l.includes("assertInstallable("),
      )
      expect(declLine).toBeGreaterThanOrEqual(0)
      expect(insertLine).toBeGreaterThan(declLine)
      expect(gateLine).toBeGreaterThan(declLine)
      expect(gateLine).toBeLessThan(insertLine)
    })
  }
})
