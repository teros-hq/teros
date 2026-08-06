/**
 * Outcome grading for the behavioural prompt-regression eval (F4 · C3).
 *
 * A golden is graded by its OUTCOME (final message + which tools it decided to
 * call + whether it errored), NOT by the exact tool-call sequence — agents find
 * valid unanticipated paths, so sequence-matching is too rigid (TER-475, the
 * Anthropic eval method). Code-based graders where the outcome is verifiable;
 * an optional LLM-judge for the qualitative case.
 *
 * Pure + deterministic except the `judge` grader, which delegates to an injected
 * `JudgeFn` (a real model in the CLI, a fake in tests). No LLM call lives here.
 */

/** What one agent turn produced — the surface a grader inspects. */
export interface TurnOutcome {
  /** Concatenated assistant text of the final message. */
  finalText: string
  /** Tools the agent chose to call this turn, in order. */
  toolCalls: Array<{ name: string; input: unknown }>
  /** The turn threw / ended in error. */
  errored: boolean
  errorMessage?: string
}

/**
 * A single outcome check. A golden passes iff ALL its graders pass. Discriminated
 * so the set is explicit and extends additively.
 */
export type Grader =
  | { kind: "finalContains"; text: string; ci?: boolean }
  | { kind: "finalMatches"; pattern: string; flags?: string }
  | { kind: "toolCalled"; tool: string }
  | { kind: "toolNotCalled"; tool: string }
  | { kind: "noError" }
  | { kind: "judge"; rubric: string }

export interface GradeResult {
  grader: Grader
  passed: boolean
  /** Why it failed (or a note). */
  detail?: string
}

/**
 * An LLM judge: given the outcome + a rubric, decide pass/fail. Injected so the
 * runner core stays free of any model dependency (and testable). When a golden
 * uses a `judge` grader but none is wired, that grader FAILS (surfacing the
 * misconfiguration rather than silently passing).
 */
export type JudgeFn = (input: {
  outcome: TurnOutcome
  rubric: string
}) => Promise<{ pass: boolean; reason?: string }>

/** Evaluate one code grader → `[passed, failMessage]`. `failMessage` is only
 * surfaced when `passed` is false. `judge` never reaches here (handled async). */
function evalCodeGrader(outcome: TurnOutcome, grader: Grader): [boolean, string] {
  switch (grader.kind) {
    case "finalContains": {
      const hay = grader.ci ? outcome.finalText.toLowerCase() : outcome.finalText
      const needle = grader.ci ? grader.text.toLowerCase() : grader.text
      return [hay.includes(needle), `final text lacks "${grader.text}"`]
    }
    case "finalMatches":
      return [
        new RegExp(grader.pattern, grader.flags).test(outcome.finalText),
        `final text does not match /${grader.pattern}/`,
      ]
    case "toolCalled":
      return [
        outcome.toolCalls.some((t) => t.name === grader.tool),
        `tool "${grader.tool}" was not called`,
      ]
    case "toolNotCalled":
      return [
        !outcome.toolCalls.some((t) => t.name === grader.tool),
        `tool "${grader.tool}" was called`,
      ]
    case "noError":
      return [!outcome.errored, outcome.errorMessage ?? "turn errored"]
    default:
      return [false, "unhandled grader kind"]
  }
}

function gradeCode(outcome: TurnOutcome, grader: Grader): GradeResult {
  const [passed, failMessage] = evalCodeGrader(outcome, grader)
  return { grader, passed, detail: passed ? undefined : failMessage }
}

/**
 * Grade `outcome` against every grader. Code graders resolve synchronously; a
 * `judge` grader calls `judge` (or fails if none is wired).
 */
export async function gradeOutcome(
  outcome: TurnOutcome,
  graders: Grader[],
  judge?: JudgeFn,
): Promise<GradeResult[]> {
  const results: GradeResult[] = []
  for (const grader of graders) {
    if (grader.kind === "judge") {
      if (!judge) {
        results.push({ grader, passed: false, detail: "judge grader used but no JudgeFn wired" })
        continue
      }
      try {
        const verdict = await judge({ outcome, rubric: grader.rubric })
        results.push({
          grader,
          passed: verdict.pass,
          detail: verdict.pass ? undefined : verdict.reason,
        })
      } catch (err) {
        results.push({ grader, passed: false, detail: `judge threw: ${(err as Error).message}` })
      }
    } else {
      results.push(gradeCode(outcome, grader))
    }
  }
  return results
}

/** A golden passes iff every grader passed. */
export function allPassed(results: GradeResult[]): boolean {
  return results.length > 0 && results.every((r) => r.passed)
}
