/**
 * Prompt-regression gate — runner core (F4 · C3, behavioural half).
 *
 * Runs each golden `k` times through an INJECTED agent runner, grades every run
 * by outcome, and computes pass@1 (capability) + pass-rate (consistency; pass^k
 * = 1 iff all k runs passed). A golden whose baseline says `mustPass` but whose
 * runs did not all pass is a REGRESSION.
 *
 * Soberanía: the gate decision (`regressed`) is derived ONLY from local grading.
 * Latitude is a WRITE-ONLY mirror — the optional `scoreboard` sink is fire-and-
 * forget and its outcome can never change the decision. This module imports no
 * Latitude client (the guard enforces it); the CLI injects the sink. Latitude
 * down → the gate behaves identically.
 */

import type { Golden } from "./goldens"
import { allPassed, gradeOutcome, type JudgeFn, type TurnOutcome } from "./grade"

/**
 * Runs ONE golden once and returns the agent's outcome. Injected by the CLI (a
 * real agent turn) or by tests (a fake). The runner core never touches an LLM.
 * A rejection is treated as an errored run (counts as a fail), never propagated.
 */
export type RunGoldenFn = (golden: Golden) => Promise<TurnOutcome>

/** Optional fire-and-forget mirror sink (Latitude C0). MUST NOT affect the gate. */
export type ScoreboardSink = (entry: { golden: Golden; passed: boolean; passRate: number }) => void

export interface GoldenResult {
  id: string
  description: string
  coreType: string
  runs: number
  passes: number
  /** First attempt passed. */
  passAt1: boolean
  /** passes / runs. `=== 1` means pass^k (every attempt passed). */
  passRate: number
  /** baseline.mustPass && not every attempt passed. */
  regressed: boolean
}

export interface GateReport {
  results: GoldenResult[]
  /** Any golden regressed vs its baseline. This is the gate decision. */
  regressed: boolean
  totalRuns: number
}

export interface RunGateOptions {
  /** Attempts per golden (pass^k consistency). Default 1. */
  k?: number
  /** LLM judge for `judge` graders. */
  judge?: JudgeFn
  /** Optional write-only Latitude mirror. Never affects the decision. */
  scoreboard?: ScoreboardSink
}

async function runOnce(golden: Golden, runGolden: RunGoldenFn, judge?: JudgeFn): Promise<boolean> {
  let outcome: TurnOutcome
  try {
    outcome = await runGolden(golden)
  } catch (err) {
    outcome = { finalText: "", toolCalls: [], errored: true, errorMessage: (err as Error).message }
  }
  const results = await gradeOutcome(outcome, golden.graders, judge)
  return allPassed(results)
}

/**
 * Run the whole golden set and produce the gate report. Deterministic given a
 * deterministic `runGolden` (tests inject one); against a real LLM `k > 1`
 * measures consistency.
 */
export async function runGate(
  goldens: Golden[],
  runGolden: RunGoldenFn,
  opts: RunGateOptions = {},
): Promise<GateReport> {
  const k = Math.max(1, opts.k ?? 1)
  const results: GoldenResult[] = []

  for (const golden of goldens) {
    let passes = 0
    let passAt1 = false
    for (let attempt = 0; attempt < k; attempt++) {
      const ok = await runOnce(golden, runGolden, opts.judge)
      if (attempt === 0) passAt1 = ok
      if (ok) passes++
    }
    const passRate = passes / k
    const regressed = golden.baseline.mustPass && passes < k
    results.push({
      id: golden.id,
      description: golden.description,
      coreType: golden.coreType,
      runs: k,
      passes,
      passAt1,
      passRate,
      regressed,
    })

    // Write-only mirror — best-effort, isolated from the decision.
    if (opts.scoreboard) {
      try {
        opts.scoreboard({ golden, passed: passes === k, passRate })
      } catch {
        // A mirror hiccup must never change the gate outcome.
      }
    }
  }

  return {
    results,
    regressed: results.some((r) => r.regressed),
    totalRuns: goldens.length * k,
  }
}

/** One-line-per-golden human report (printed by the CLI). */
export function formatGateReport(report: GateReport): string {
  const lines = report.results.map((r) => {
    const mark = r.regressed ? "REGRESSED" : r.passRate === 1 ? "ok" : "weak"
    return `  [${mark}] ${r.id} — pass@1=${r.passAt1 ? "1" : "0"} pass-rate=${r.passes}/${r.runs} (${r.coreType})`
  })
  const verdict = report.regressed
    ? "REGRESSION: at least one must-pass golden did not pass all attempts"
    : "no regression vs baseline"
  return `Prompt-regression gate — ${report.totalRuns} runs\n${lines.join("\n")}\n${verdict}`
}
