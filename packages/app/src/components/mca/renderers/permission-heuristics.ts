/**
 * Per-call heuristics registry for tools whose manifest annotation
 * cannot decide statically — "polymorphic tools" in the sense that the
 * same `(mcaId, toolName)` can dispatch radically different actions
 * depending on its input.
 *
 * Canonical example: `mca.teros.bash:bash`. The tool accepts any shell
 * command, so the manifest cannot honestly mark it `irreversible: true`
 * — `bash ls /tmp` is trivially reversible. The renderer evaluates the
 * specific command (or other shape of input) at render time and
 * decides whether the irreversibility indicator should appear.
 *
 * Same shape applies to:
 *   • `mca.teros.admin.bash:bash` — same input contract as user bash.
 *   • `mca.teros.docker-env:env-exec` — runs commands inside a container.
 *   • `mca.teros.playwright:browser-run-code` / `browser-evaluate` —
 *     executes arbitrary JS in the browser context.
 *   • `mca.browserbase:evaluate` — equivalent JS-in-browser tool.
 *
 * Tools NOT in the registry fall back to the manifest's static
 * `annotations.irreversible`. So a `mca.linear:delete-issue` (always
 * irreversible) keeps using the manifest flag without needing a decider
 * here — the registry is opt-in.
 *
 * The registry has a second axis: `risk`. The Risk Indicator (Renderer
 * UX Guide v2.1 §8.5) is a binary marker for elevated risk beyond
 * reversibility — world-writable permissions, supply-chain code,
 * privilege escalation, cluster-wide blast radius. Same per-call
 * heuristic pattern as irreversibility, separate decision matrix.
 *
 * Safety: heuristics that throw fall through to `false` (fail-safe).
 * An error in a heuristic must never elevate the UI to a state the
 * user didn't authorize — but it can fail to elevate, which is
 * recoverable (the agent can retry, or the user can read the
 * description and decide).
 */

import {
  isBashElevatedRisk,
  isBashCommandIrreversible,
} from './bash-permission-description';
import {
  isPlaywrightElevatedRisk,
  isPlaywrightCodeIrreversible,
  type PlaywrightCodeInput,
} from './playwright-permission-description';

export type IrreversibilityDecider = (input: unknown) => boolean;
export type RiskDecider = (input: unknown) => boolean;

/**
 * Map of `${mcaId}:${toolName}` to a function that inspects the input
 * and returns `true` if the call should be flagged as irreversible.
 * New entries are added when a polymorphic tool is identified.
 */
const irreversibilityHeuristics: Record<string, IrreversibilityDecider> = {
  'mca.teros.bash:bash': (input) => {
    const command = (input as { command?: string } | null | undefined)?.command;
    return isBashCommandIrreversible(command);
  },
  'mca.teros.admin.bash:bash': (input) => {
    const command = (input as { command?: string } | null | undefined)?.command;
    return isBashCommandIrreversible(command);
  },
  // Docker-env shell exec runs the same shell idioms as bash. If
  // container-specific patterns ever emerge (host-volume operations,
  // nested docker exec, etc.), introduce a dedicated helper at THAT
  // point — not preemptively.
  'mca.teros.docker-env:env-exec': (input) => {
    const command = (input as { command?: string } | null | undefined)?.command;
    return isBashCommandIrreversible(command);
  },
  // Playwright / Browserbase — JS evaluated in the page context. The
  // destructive surface is browser storage, not shell idioms.
  'mca.teros.playwright:browser-run-code': (input) =>
    isPlaywrightCodeIrreversible(input as PlaywrightCodeInput | undefined),
  'mca.teros.playwright:browser-evaluate': (input) =>
    isPlaywrightCodeIrreversible(input as PlaywrightCodeInput | undefined),
  'mca.browserbase:evaluate': (input) =>
    isPlaywrightCodeIrreversible(input as PlaywrightCodeInput | undefined),
};

/**
 * Per-call irreversibility decision. Returns `false` for any tool not
 * registered here — callers should combine this with the static
 * `annotations.irreversible` flag from the backend prop:
 *
 *   const irreversible =
 *     props.irreversible ||
 *     isToolCallIrreversible(props.mcaId, shortName, props.input);
 *
 * Or, for polymorphic tools whose manifest is intentionally `false`,
 * use only the heuristic:
 *
 *   const irreversible = isToolCallIrreversible(mcaId, shortName, input);
 *
 * Bash and Admin Bash use the second form because their manifest no
 * longer marks the tool as irreversible (the global flag was wrong —
 * see commit `b5d0adad`).
 */
export function isToolCallIrreversible(
  mcaId: string,
  toolName: string,
  input: unknown,
): boolean {
  const decider = irreversibilityHeuristics[`${mcaId}:${toolName}`];
  if (!decider) return false;
  try {
    return decider(input);
  } catch {
    return false;
  }
}

/**
 * Test-only escape hatch — returns the list of registered keys so a
 * unit test can assert the registry covers what the audit expects.
 * Not exported to renderers; do not rely on it in production code.
 */
export function _registeredIrreversibilityKeys(): readonly string[] {
  return Object.keys(irreversibilityHeuristics);
}

/**
 * Per-call risk heuristics. Same shape as `irreversibilityHeuristics`,
 * but for the Risk Indicator (Renderer UX Guide v2.1 §8.5) — a SEPARATE
 * binary marker for elevated security/blast risk beyond reversibility.
 * Both can fire simultaneously when applicable (e.g. `dd if=/dev/...`).
 */
const riskHeuristics: Record<string, RiskDecider> = {
  'mca.teros.bash:bash': (input) => {
    const command = (input as { command?: string } | null | undefined)?.command;
    return isBashElevatedRisk(command);
  },
  'mca.teros.admin.bash:bash': (input) => {
    const command = (input as { command?: string } | null | undefined)?.command;
    return isBashElevatedRisk(command);
  },
  'mca.teros.docker-env:env-exec': (input) => {
    const command = (input as { command?: string } | null | undefined)?.command;
    return isBashElevatedRisk(command);
  },
  'mca.teros.playwright:browser-run-code': (input) =>
    isPlaywrightElevatedRisk(input as PlaywrightCodeInput | undefined),
  'mca.teros.playwright:browser-evaluate': (input) =>
    isPlaywrightElevatedRisk(input as PlaywrightCodeInput | undefined),
  'mca.browserbase:evaluate': (input) =>
    isPlaywrightElevatedRisk(input as PlaywrightCodeInput | undefined),
};

/**
 * Per-call risk decision (guide v2.1 §8.5 — binary, no gradations).
 * Returns `false` for any tool not registered here. Combine with the
 * irreversibility check in the renderer's header props.
 */
export function isToolCallElevatedRisk(
  mcaId: string,
  toolName: string,
  input: unknown,
): boolean {
  const decider = riskHeuristics[`${mcaId}:${toolName}`];
  if (!decider) return false;
  try {
    return decider(input);
  } catch {
    return false;
  }
}

/** Test-only — see `_registeredIrreversibilityKeys`. */
export function _registeredRiskKeys(): readonly string[] {
  return Object.keys(riskHeuristics);
}
