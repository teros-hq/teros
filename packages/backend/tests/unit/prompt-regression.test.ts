/**
 * Unit tests for the behavioural prompt-regression gate (F4 · C3): the grader
 * and the runner core. Mutation-verified.
 *
 * The load-bearing assertions:
 *  - grading is by outcome, exact per-grader pass/fail;
 *  - a must-pass golden that doesn't pass ALL k attempts is a regression (pass^k);
 *  - the gate decision is derived from local grading ONLY — the Latitude
 *    scoreboard is a write-only sink whose call (or throw) never changes the
 *    verdict (soberanía: Latitude down → gate identical).
 */

import { describe, expect, it } from "bun:test"
import type { Golden } from "../../src/eval/goldens"
import { allPassed, gradeOutcome, type JudgeFn, type TurnOutcome } from "../../src/eval/grade"
import { type RunGoldenFn, runGate } from "../../src/eval/prompt-regression"

const outcome = (over: Partial<TurnOutcome> = {}): TurnOutcome => ({
  finalText: "",
  toolCalls: [],
  errored: false,
  ...over,
})

describe("gradeOutcome — code graders", () => {
  it("finalContains: case-sensitive by default, ci when asked", async () => {
    const t = outcome({ finalText: "I am a Teros agent" })
    expect((await gradeOutcome(t, [{ kind: "finalContains", text: "Teros" }]))[0].passed).toBe(true)
    expect((await gradeOutcome(t, [{ kind: "finalContains", text: "teros" }]))[0].passed).toBe(
      false,
    )
    expect(
      (await gradeOutcome(t, [{ kind: "finalContains", text: "teros", ci: true }]))[0].passed,
    ).toBe(true)
  })

  it("finalMatches: regex with flags", async () => {
    const t = outcome({ finalText: "Step 1. do X" })
    expect(
      (await gradeOutcome(t, [{ kind: "finalMatches", pattern: "^step \\d", flags: "i" }]))[0]
        .passed,
    ).toBe(true)
    expect(
      (await gradeOutcome(t, [{ kind: "finalMatches", pattern: "^step \\d" }]))[0].passed,
    ).toBe(false)
  })

  it("toolCalled / toolNotCalled", async () => {
    const t = outcome({ toolCalls: [{ name: "send-email", input: {} }] })
    expect((await gradeOutcome(t, [{ kind: "toolCalled", tool: "send-email" }]))[0].passed).toBe(
      true,
    )
    expect((await gradeOutcome(t, [{ kind: "toolCalled", tool: "bash" }]))[0].passed).toBe(false)
    expect((await gradeOutcome(t, [{ kind: "toolNotCalled", tool: "bash" }]))[0].passed).toBe(true)
    expect((await gradeOutcome(t, [{ kind: "toolNotCalled", tool: "send-email" }]))[0].passed).toBe(
      false,
    )
  })

  it("noError reflects the errored flag", async () => {
    expect((await gradeOutcome(outcome(), [{ kind: "noError" }]))[0].passed).toBe(true)
    expect((await gradeOutcome(outcome({ errored: true }), [{ kind: "noError" }]))[0].passed).toBe(
      false,
    )
  })

  it("allPassed requires at least one grader and every one passing", () => {
    expect(allPassed([])).toBe(false)
    expect(allPassed([{ grader: { kind: "noError" }, passed: true }])).toBe(true)
    expect(
      allPassed([
        { grader: { kind: "noError" }, passed: true },
        { grader: { kind: "noError" }, passed: false },
      ]),
    ).toBe(false)
  })
})

describe("gradeOutcome — judge grader", () => {
  const passJudge: JudgeFn = async () => ({ pass: true })
  const failJudge: JudgeFn = async () => ({ pass: false, reason: "fabricated steps" })

  it("delegates to the injected judge", async () => {
    const t = outcome({ finalText: "..." })
    expect((await gradeOutcome(t, [{ kind: "judge", rubric: "r" }], passJudge))[0].passed).toBe(
      true,
    )
    const failed = await gradeOutcome(t, [{ kind: "judge", rubric: "r" }], failJudge)
    expect(failed[0]).toEqual({
      grader: { kind: "judge", rubric: "r" },
      passed: false,
      detail: "fabricated steps",
    })
  })

  it("FAILS (does not silently pass) when a judge grader has no JudgeFn wired", async () => {
    const res = await gradeOutcome(outcome(), [{ kind: "judge", rubric: "r" }])
    expect(res[0].passed).toBe(false)
    expect(res[0].detail).toMatch(/no JudgeFn wired/)
  })

  it("treats a throwing judge as a fail", async () => {
    const boom: JudgeFn = async () => {
      throw new Error("judge model down")
    }
    const res = await gradeOutcome(outcome(), [{ kind: "judge", rubric: "r" }], boom)
    expect(res[0].passed).toBe(false)
    expect(res[0].detail).toMatch(/judge threw: judge model down/)
  })
})

const golden = (over: Partial<Golden> = {}): Golden => ({
  id: "g1",
  description: "d",
  coreType: "agent",
  userText: "hi",
  graders: [{ kind: "finalContains", text: "OK" }],
  baseline: { mustPass: true },
  ...over,
})

describe("runGate — pass^k + regression decision", () => {
  it("all attempts pass → no regression, passRate 1, passAt1 true", async () => {
    const run: RunGoldenFn = async () => outcome({ finalText: "OK" })
    const report = await runGate([golden()], run, { k: 3 })
    expect(report.regressed).toBe(false)
    expect(report.totalRuns).toBe(3)
    expect(report.results[0]).toMatchObject({
      id: "g1",
      runs: 3,
      passes: 3,
      passAt1: true,
      passRate: 1,
      regressed: false,
    })
  })

  it("a must-pass golden that fails ONE of k attempts is a regression (pass^k)", async () => {
    let n = 0
    const run: RunGoldenFn = async () => outcome({ finalText: n++ === 1 ? "nope" : "OK" }) // 2nd attempt fails
    const report = await runGate([golden()], run, { k: 3 })
    expect(report.regressed).toBe(true)
    expect(report.results[0]).toMatchObject({
      passes: 2,
      runs: 3,
      passAt1: true,
      passRate: 2 / 3,
      regressed: true,
    })
  })

  it("a runGolden rejection counts as a failed attempt (never propagates)", async () => {
    const run: RunGoldenFn = async () => {
      throw new Error("agent crashed")
    }
    const report = await runGate([golden({ graders: [{ kind: "noError" }] })], run, { k: 1 })
    expect(report.regressed).toBe(true)
    expect(report.results[0].passes).toBe(0)
  })

  it("baseline.mustPass=false → never a regression even if it fails", async () => {
    const run: RunGoldenFn = async () => outcome({ finalText: "nope" })
    const report = await runGate([golden({ baseline: { mustPass: false } })], run, { k: 2 })
    expect(report.regressed).toBe(false)
    expect(report.results[0]).toMatchObject({ passes: 0, regressed: false })
  })

  it("default k is 1", async () => {
    let calls = 0
    const run: RunGoldenFn = async () => {
      calls++
      return outcome({ finalText: "OK" })
    }
    await runGate([golden()], run)
    expect(calls).toBe(1)
  })
})

describe("runGate — Latitude scoreboard is write-only, isolated from the decision", () => {
  it("calls the sink once per golden with the exact payload", async () => {
    const run: RunGoldenFn = async () => outcome({ finalText: "OK" })
    const seen: Array<{ id: string; passed: boolean; passRate: number }> = []
    const g = golden()
    await runGate([g], run, {
      k: 2,
      scoreboard: (e) => seen.push({ id: e.golden.id, passed: e.passed, passRate: e.passRate }),
    })
    expect(seen).toEqual([{ id: "g1", passed: true, passRate: 1 }])
  })

  it("a THROWING scoreboard does not change the gate verdict (fire-and-forget)", async () => {
    const run: RunGoldenFn = async () => outcome({ finalText: "OK" })
    const report = await runGate([golden()], run, {
      k: 1,
      scoreboard: () => {
        throw new Error("latitude unreachable")
      },
    })
    // Verdict identical to the no-scoreboard run — Latitude down → gate identical.
    expect(report.regressed).toBe(false)
    expect(report.results[0].passes).toBe(1)
  })
})
