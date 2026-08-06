/**
 * Lint-as-test (TER-617 / F3): the "teros = which upstream?" decision must live
 * in ONE place — `services/teros-upstream.ts` (resolveTerosUpstream). This pins
 * that no other backend call-site reads the Fireworks/Together system secret
 * directly, nor hardcodes their base URLs, so a future edit can't silently
 * re-introduce the triplication the resolver was created to kill.
 *
 * R8.1/M4: the secret-read regex matches ANY receiver (`.system(`, not just
 * `secrets.system(`) + back-tick quotes, so a different variable name can't
 * evade the choke-point. Allowlist is explicit; `server-bootstrap.ts` would be
 * added here if it ever seeds the admin teros provider config from the secret.
 */

import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const SRC = join(import.meta.dir, "..", "..", "src")
const RESOLVER = "services/teros-upstream.ts"

// Files allowed to read the upstream system secret. The resolver OWNS routing;
// server-bootstrap reads `system('fireworks')` ONCE at boot to seed the default
// admin teros provider config (seedDefaultTerosProviderConfig) — a setup flow,
// not per-turn routing, so it's a legitimate exception (R8.1).
const ALLOWLIST = new Set([RESOLVER, "bootstrap/server-bootstrap.ts"])

// `.system('fireworks')` / `secretsManager.system<T>("together")` / `x.system(`fireworks`)`
// — ANY receiver, optional generic, single/double/back-tick quote.
const SYSTEM_SECRET_READ = /\.system\s*(?:<[^>]*>)?\s*\(\s*['"`](?:fireworks|together)['"`]/

// The upstream base URLs (in CODE) must live only in the resolver. The core
// factory keeps a `?? 'https://api.fireworks.ai/...'` default — outside this
// backend walk — synced by hand (// KEEP IN SYNC).
const BASE_URL_LITERAL = /api\.(?:fireworks\.ai\/inference\/v1|together\.ai\/v1)/

function backendTsFiles(): string[] {
  return readdirSync(SRC, { recursive: true })
    .filter(
      (f): f is string =>
        typeof f === "string" &&
        f.endsWith(".ts") &&
        !f.endsWith(".test.ts") &&
        !f.endsWith(".d.ts"),
    )
    .map((f) => f.replaceAll("\\", "/"))
}

/** A line that is purely a comment — base URLs in JSDoc/comments are docs, not routing. */
function isCommentLine(line: string): boolean {
  const t = line.trim()
  return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*")
}

describe("teros fallback invariant (TER-617)", () => {
  it("reads the fireworks/together system secret ONLY in the upstream resolver (any receiver)", () => {
    const offenders = backendTsFiles().filter((rel) => {
      if (ALLOWLIST.has(rel)) return false
      // CODE reads only — a `secrets.system('fireworks')` mention in a comment
      // (e.g. a doc string) is not a real read.
      return readFileSync(join(SRC, rel), "utf8")
        .split("\n")
        .some((line) => !isCommentLine(line) && SYSTEM_SECRET_READ.test(line))
    })
    expect(offenders).toEqual([])
  })

  it("hardcodes the Fireworks/Together base URL ONLY in the resolver (code, not comments)", () => {
    const offenders = backendTsFiles().filter((rel) => {
      if (ALLOWLIST.has(rel)) return false
      return readFileSync(join(SRC, rel), "utf8")
        .split("\n")
        .some((line) => !isCommentLine(line) && BASE_URL_LITERAL.test(line))
    })
    expect(offenders).toEqual([])
  })

  it("the resolver IS the single source of truth (reads both system secrets)", () => {
    // Anti-vacuity: if the resolver stopped reading them, the test above would
    // pass trivially. Pin that the choke-point still owns both upstream secrets.
    const resolver = readFileSync(join(SRC, RESOLVER), "utf8")
    expect(resolver).toContain('secrets.system("fireworks")')
    expect(resolver).toContain('secrets.system("together")')
  })

  it("scans a non-trivial number of backend source files (the walk works)", () => {
    expect(backendTsFiles().length).toBeGreaterThan(100)
  })
})
