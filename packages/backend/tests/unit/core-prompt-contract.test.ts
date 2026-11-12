/**
 * Core prompt contract gate (F4 · C3 — deterministic half).
 *
 * Runs in the unit CI job → BLOCKS the build. Two things are verified:
 *   1. Every real core prompt (`base-*-core.md`) honours its contract.
 *   2. The checker itself BITES — a prompt missing a required anchor, or
 *      carrying a forbidden one, produces the exact violation. Without (2), (1)
 *      could pass vacuously if the checker were broken.
 *
 * Mutation-verified: drop an anchor from `SHARED_MUST_CONTAIN` → real-prompt
 * test goes red; weaken `checkPromptContract` to always return [] → the bite
 * tests go red.
 */

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  CORE_PROMPT_CONTRACTS,
  checkPromptContract,
  type PromptContract,
} from "../../src/prompts/core-prompt-contracts"

const PROMPTS_DIR = join(import.meta.dir, "../../src/prompts")

function readPrompt(file: string): string {
  return readFileSync(join(PROMPTS_DIR, file), "utf8")
}

describe("core prompt contract gate (F4·C3)", () => {
  it("registers a contract for every backend core prompt", () => {
    // If a new base-*-core.md ships without a contract, this reminds us to add one.
    expect(CORE_PROMPT_CONTRACTS.map((c) => c.file).sort()).toEqual([
      "base-agent-core.md",
      "base-super-agent-core.md",
    ])
  })

  for (const contract of CORE_PROMPT_CONTRACTS) {
    it(`${contract.file} honours its contract (no missing/forbidden anchors)`, () => {
      const text = readPrompt(contract.file)
      expect(text.length).toBeGreaterThan(0)
      const violations = checkPromptContract(contract, text)
      // Surface WHICH invariant broke, not just a count.
      expect(violations).toEqual([])
    })
  }

  it("catches a DROPPED required anchor (the gate can fail)", () => {
    const contract: PromptContract = {
      file: "fixture.md",
      coreType: "agent",
      mustContain: [
        { label: "identity", why: "must be a Teros agent", needle: "You are a Teros agent" },
      ],
      mustNotContain: [],
    }
    const violations = checkPromptContract(contract, "You are a helpful assistant.")
    expect(violations).toEqual([
      { file: "fixture.md", kind: "missing", label: "identity", why: "must be a Teros agent" },
    ])
  })

  it("catches a LEAKED forbidden anchor (billing must not reach the model)", () => {
    const contract: PromptContract = {
      file: "fixture.md",
      coreType: "agent",
      mustContain: [],
      mustNotContain: [
        { label: "billing", why: "billing must not leak", needle: "billing", ci: true },
      ],
    }
    // Case-insensitive: "Billing" must still be caught.
    const violations = checkPromptContract(contract, "Your Billing status is fine.")
    expect(violations).toEqual([
      { file: "fixture.md", kind: "forbidden", label: "billing", why: "billing must not leak" },
    ])
  })

  it("passes a prompt that satisfies mustContain and avoids mustNotContain", () => {
    const contract: PromptContract = {
      file: "fixture.md",
      coreType: "agent",
      mustContain: [{ label: "identity", why: "…", needle: "You are a Teros agent" }],
      mustNotContain: [{ label: "billing", why: "…", needle: "billing", ci: true }],
    }
    expect(checkPromptContract(contract, "You are a Teros agent. Be helpful.")).toEqual([])
  })
})

/**
 * The Terminal + Claude Code section rides EVERY agent's prompt, installed or
 * not, so it must stay a short pointer: the playbook lives in the guide topic.
 */
describe("core prompts — Terminal + Claude Code section", () => {
  const HEADING = "## Terminal and Claude Code"
  const MAX_CHARS = 1400

  function section(file: string): string {
    const text = readPrompt(file)
    const start = text.indexOf(HEADING)
    expect(start, `${file} has no "${HEADING}" section`).toBeGreaterThanOrEqual(0)
    const next = text.indexOf("\n## ", start + HEADING.length)
    return text.slice(start, next === -1 ? undefined : next)
  }

  for (const contract of CORE_PROMPT_CONTRACTS) {
    it(`${contract.file}: the section stays short (≤ ${MAX_CHARS} chars)`, () => {
      expect(section(contract.file).length).toBeLessThanOrEqual(MAX_CHARS)
    })

    it(`${contract.file}: the remembered preference is checked before proposing, and the answer is saved`, () => {
      const s = section(contract.file)
      const check = s.indexOf("check the user's remembered preference")
      const propose = s.indexOf("Propose it at most once per conversation")
      const save = s.indexOf("save it to memory")
      expect(check).toBeGreaterThanOrEqual(0)
      expect(propose).toBeGreaterThan(check)
      expect(save).toBeGreaterThan(propose)
      expect(s).toContain("`user_preferences`")
    })
  }

  it("both cores carry the same section", () => {
    expect(section("base-agent-core.md")).toBe(section("base-super-agent-core.md"))
  })
})
