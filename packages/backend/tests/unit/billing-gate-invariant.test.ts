/**
 * Structural invariant (lint-as-test) for the billing choke point — FASE 3d.
 *
 * The entire enforcement design rests on ONE structural fact: every code path
 * that resolves an LLM provider for an agent goes through the PUBLIC
 * `ProviderService.resolveProviderForAgent`, which — after resolving — enforces
 * the agent-hours hard block when the resolved provider is `teros`:
 *
 *     const resolved = await this.resolveProviderForAgentInner(...)
 *     if (resolved?.provider?.providerType === 'teros' && resolved.provider.userId)
 *       await assertTerosHoursAvailable(this.db, resolved.provider.userId)
 *
 * Two ways this silently breaks (each a real revenue/abuse hole), both caught here:
 *   1. A refactor drops the `assertTerosHoursAvailable` call (or its `teros`
 *      guard) from the choke point → Teros consumption is never hour-gated.
 *   2. A NEW entry point calls the PRIVATE `resolveProviderForAgentInner`
 *      directly (the un-gated inner) instead of the public wrapper → it bypasses
 *      the hours gate. The inner exists ONLY to be wrapped; it must have exactly
 *      one caller (the wrapper) and live in exactly one file.
 *
 * This is the scheduler-incident class of bug (CLAUDE.md): a path that bypasses
 * the gate, latent, with green tests. A grep-based invariant makes it impossible
 * by construction — the build goes red the moment someone adds a bypass.
 *
 * PROVEN TO BITE (do not trust a green lint-as-test): during development each
 * assertion was inverted against the live tree and confirmed red —
 *   - deleting the `assertTerosHoursAvailable(` line from provider-service.ts,
 *   - adding a second file referencing `resolveProviderForAgentInner`,
 *   - dropping the `providerType === 'teros'` guard,
 * each turns the corresponding test red. Reverting → green.
 */

import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const SRC = join(import.meta.dir, "..", "..", "src")
const PROVIDER_SERVICE = join(SRC, "services", "provider-service.ts")

/** Recursively collect every .ts source file under src/ (excluding tests). */
function collectSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      out.push(...collectSourceFiles(full))
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(full)
    }
  }
  return out
}

describe("billing choke point — structural invariant (FASE 3d)", () => {
  const chokeSrc = readFileSync(PROVIDER_SERVICE, "utf8")

  it("the choke point gates the ACTOR's hours (not the owner's) for the teros provider (G6)", () => {
    // The public resolver must, after resolving, assert hours when the resolved
    // provider is teros. We require BOTH tokens to coexist in the file: the
    // teros discriminator and the hours-gate call. Removing either is the
    // enforcement hole.
    expect(chokeSrc).toContain("assertTerosHoursAvailable(")
    expect(chokeSrc).toMatch(/providerType\s*===\s*'teros'/)

    // And specifically (TER-650/G6): the hours gate follows the ACTOR
    // (`actorUserId`, the channel user whose hours are billed), falling back to
    // the owner — NOT the owner alone. Billing charges the actor, so the gate
    // must check the actor. Reverting to `assertTerosHoursAvailable(this.db,
    // ownerUserId)` turns this red.
    expect(chokeSrc).toMatch(
      /providerType\s*===\s*'teros'[\s\S]{0,160}assertTerosHoursAvailable\(\s*this\.db\s*,\s*actorUserId\s*\?\?\s*ownerUserId\s*\)/,
    )
  })

  it("the choke point enforces the payment-due block on the OWNER for EVERY provider (incl. BYOK)", () => {
    // The transversal payment block (decision B) must run at the choke point,
    // wired to the OWNER (who pays for the provider), and NOT be gated by the
    // teros discriminator — it cuts BYOK too. It must appear BEFORE the
    // providerType === 'teros' guard (i.e. outside it). Payment stays on the
    // owner even though hours follow the actor (TER-650/G6).
    expect(chokeSrc).toContain("assertAccountNotBlocked(")
    expect(chokeSrc).toMatch(
      /assertAccountNotBlocked\(\s*this\.db\s*,\s*ownerUserId\s*\)[\s\S]{0,300}providerType\s*===\s*'teros'/,
    )
  })

  it("the public resolver wraps the inner resolver (gate cannot be skipped by the wrapper)", () => {
    // resolveProviderForAgent (public) must call resolveProviderForAgentInner.
    // If the public method stopped delegating, the gate placement would be moot.
    expect(chokeSrc).toMatch(
      /async\s+resolveProviderForAgent\s*\([\s\S]*?this\.resolveProviderForAgentInner\(/,
    )
    // The inner resolver stays PRIVATE — exposing it invites un-gated callers.
    expect(chokeSrc).toMatch(/private\s+async\s+resolveProviderForAgentInner\s*\(/)
  })

  it("no entry point bypasses the gate by calling the inner resolver directly", () => {
    // resolveProviderForAgentInner is the UN-GATED inner. It must appear in
    // exactly one file (provider-service.ts) and be referenced exactly twice
    // there: its definition + the single call inside the public wrapper. Any
    // other reference is a bypass of the hours gate.
    const files = collectSourceFiles(SRC)
    const offenders: Array<{ file: string; count: number }> = []
    let chokeCount = 0

    for (const file of files) {
      const src = readFileSync(file, "utf8")
      const count = (src.match(/resolveProviderForAgentInner/g) ?? []).length
      if (count === 0) continue
      if (file === PROVIDER_SERVICE) {
        chokeCount = count
      } else {
        offenders.push({ file: file.replace(SRC, "src"), count })
      }
    }

    // Exactly the definition + the one wrapper call. (A new private helper that
    // legitimately needs the inner would bump this and force a deliberate review
    // of whether the gate still covers it.)
    expect(chokeCount).toBe(2)
    // Nobody outside the choke-point file may touch the un-gated inner.
    expect(offenders).toEqual([])
  })
})
