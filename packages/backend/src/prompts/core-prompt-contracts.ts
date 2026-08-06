/**
 * Core prompt contracts (F4 · C3 — the deterministic half of the prompt-
 * regression gate).
 *
 * A "contract" is the set of behavioural invariants a core's system prompt MUST
 * (and must NOT) carry. It is versioned in the repo and checked by
 * `core-prompt-contract.test.ts`, which runs in the unit CI job and BLOCKS the
 * build: editing `base-*-core.md` in a way that drops a required instruction (or
 * leaks a forbidden one) fails per-PR, deterministically, with zero LLM calls.
 *
 * This is the sibling of `@teros/core`'s `prompts/billing-invariant.test.ts`
 * (which forbids billing tokens leaking into the model context) generalised to
 * required-content and scoped to the two backend core prompts.
 *
 * WHY anchors, not whole sentences: an invariant is pinned by a SHORT, stable,
 * distinctive phrase — enough that a regression which DROPS the instruction
 * removes the anchor, but loose enough that a legitimate reword keeps it. If a
 * deliberate prompt change must move an anchor, update the contract in the SAME
 * commit — that visibility is the point (make the regression impossible by
 * accident). It does NOT catch subtle behavioural drift that still satisfies the
 * contract — that is what the behavioural eval runner (the other half of C3) is
 * for.
 */

/** One invariant: a short anchor the prompt must (or must not) contain. */
export interface PromptInvariant {
  /** Human label for the failure message. */
  label: string
  /** Why the invariant matters (shown on violation). */
  why: string
  /** Literal substring anchor. Kept short + distinctive on purpose. */
  needle: string
  /** Case-insensitive match (default false). */
  ci?: boolean
}

/** The contract for one core's system-prompt source file. */
export interface PromptContract {
  /** Source filename under `src/prompts/`, the human edit point. */
  file: string
  /** Logical core type this prompt backs. */
  coreType: "agent" | "super-agent"
  /** Anchors that MUST be present. */
  mustContain: PromptInvariant[]
  /** Anchors that MUST NOT be present. */
  mustNotContain: PromptInvariant[]
}

/**
 * Invariants shared by EVERY core prompt (identity + the tools-first / platform-
 * guide-first / don't-route-around-broken-integrations contract). A regression
 * in any of these changes agent behaviour materially.
 */
const SHARED_MUST_CONTAIN: PromptInvariant[] = [
  {
    label: "teros-agent-identity",
    why: "the prompt must establish the agent as a Teros agent",
    needle: "You are a Teros agent",
  },
  {
    label: "tools-before-memory",
    why: "the agent must reach for tools before its (stale) memory",
    needle: "before your own memory",
  },
  {
    label: "tools-are-source-of-truth",
    why: "tools, not training data, are authoritative for Teros/workspace state",
    needle: "source of truth",
  },
  {
    label: "mca-concept",
    why: "the agent acts through MCAs (Model Context Apps), not arbitrary means",
    needle: "Model Context Apps",
  },
  {
    label: "platform-guide-first",
    why: "how-to questions must consult the platform guide, never memory",
    needle: "platform guide FIRST",
  },
  {
    label: "no-howto-from-memory",
    why: "answering platform how-to from memory produces confident wrong steps",
    needle: "Never answer platform how-to from memory",
  },
  {
    label: "no-route-around-broken-integration",
    why: "the agent must not bypass a broken integration with shell/scripts/direct API (safety + trust)",
    needle: "Never route around a broken",
  },
  {
    label: "verify-once-no-loop",
    why: "a non-erroring tool call is not proof of success; verify once, don't loop",
    needle: "Verify once; don't loop",
  },
]

/**
 * Forbidden anchors for EVERY core prompt. Billing/usage must never reach the
 * model context (mirrors `@teros/core` decisión #12): exposing remaining hours
 * would alter behaviour. Kept as short distinctive tokens.
 */
const SHARED_MUST_NOT_CONTAIN: PromptInvariant[] = [
  {
    label: "billing",
    why: "billing/usage info must not reach the model prompt",
    needle: "billing",
    ci: true,
  },
  {
    label: "hours-remaining",
    why: "remaining agent-hours must not reach the model prompt (would alter behaviour)",
    needle: "hoursRemaining",
    ci: true,
  },
  {
    label: "agent-hours-used",
    why: "usage counters must not reach the model prompt",
    needle: "agentHoursUsed",
  },
]

export const CORE_PROMPT_CONTRACTS: PromptContract[] = [
  {
    file: "base-agent-core.md",
    coreType: "agent",
    mustContain: [
      ...SHARED_MUST_CONTAIN,
      {
        label: "workspace-scoped",
        why: "the workspace agent works inside a workspace (its sovereign context)",
        needle: "working inside a workspace",
      },
    ],
    mustNotContain: SHARED_MUST_NOT_CONTAIN,
  },
  {
    file: "base-super-agent-core.md",
    coreType: "super-agent",
    mustContain: [
      ...SHARED_MUST_CONTAIN,
      {
        label: "personal-assistant",
        why: "the super-agent is the user's cross-workspace personal assistant",
        needle: "personal assistant",
      },
      {
        label: "extend-via-catalog",
        why: "the super-agent extends its capabilities by installing catalog apps, not inventing tools",
        needle: "list-catalog",
      },
    ],
    mustNotContain: SHARED_MUST_NOT_CONTAIN,
  },
]

/** A single contract breach. */
export interface ContractViolation {
  file: string
  kind: "missing" | "forbidden"
  label: string
  why: string
}

/**
 * Pure checker: return every violation of `contract` against `promptText`. Empty
 * array = the prompt honours its contract. Deterministic, no I/O.
 */
export function checkPromptContract(
  contract: PromptContract,
  promptText: string,
): ContractViolation[] {
  const violations: ContractViolation[] = []
  const has = (inv: PromptInvariant): boolean => {
    const hay = inv.ci ? promptText.toLowerCase() : promptText
    const needle = inv.ci ? inv.needle.toLowerCase() : inv.needle
    return hay.includes(needle)
  }
  for (const inv of contract.mustContain) {
    if (!has(inv)) {
      violations.push({ file: contract.file, kind: "missing", label: inv.label, why: inv.why })
    }
  }
  for (const inv of contract.mustNotContain) {
    if (has(inv)) {
      violations.push({ file: contract.file, kind: "forbidden", label: inv.label, why: inv.why })
    }
  }
  return violations
}
