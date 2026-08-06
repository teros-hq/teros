/**
 * Prompt-regression gate — CLI (F4 · C3, behavioural half).
 *
 * Runs the golden set through a REAL agent turn (per its core's system prompt),
 * grades each by outcome, and reports pass@1 / pass-rate vs the versioned
 * baseline. This is the behavioural complement to the deterministic contract
 * gate (`core-prompt-contract.test.ts`, which blocks per-PR with no LLM calls).
 *
 * Informative by default (exit 0) — behavioural evals are flaky/costly, so per
 * TER-475 they run nightly/manual and only BLOCK (`--block`) once trustworthy.
 * The gate DECISION is 100% local (grading); `--scoreboard` mirrors results to
 * Latitude best-effort (C0 reuse) but never affects the verdict.
 *
 * Skips (exit 0) when no provider is configured, so a nightly CI job stays green
 * until a key is wired.
 *
 * Exit codes: 0 = ok / skipped / informative · 1 = regression (only with --block)
 *             · 3 = setup error.
 *
 * Usage:
 *   EVAL_PROVIDER=anthropic EVAL_MODEL=claude-haiku-4-5-20251001 EVAL_API_KEY=… \
 *     npx tsx --tsconfig packages/backend/tsconfig.json scripts/prompt-regression-gate.ts [--k=3] [--block] [--scoreboard]
 */

import { config as dotenvConfig } from "dotenv"

dotenvConfig()

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  ChannelWorkerRegistry,
  ConversationManager,
  type ILLMClient,
  LLMClientFactory,
  type LLMConfig,
} from "@teros/core"
import { EvalSessionStore } from "../packages/backend/src/eval/eval-session-store"
import { GOLDENS, type Golden } from "../packages/backend/src/eval/goldens"
import type { JudgeFn, TurnOutcome } from "../packages/backend/src/eval/grade"
import {
  formatGateReport,
  runGate,
  type ScoreboardSink,
} from "../packages/backend/src/eval/prompt-regression"
import { createLatitudeScoreClient } from "../packages/backend/src/services/latitude-score-emitter"
import { traceIdFor } from "../packages/backend/src/services/otel-span-builder"

const HERE = dirname(fileURLToPath(import.meta.url))
const PROMPTS_DIR = join(HERE, "../packages/backend/src/prompts")

const args = process.argv.slice(2)
const BLOCK = args.includes("--block")
const SCOREBOARD = args.includes("--scoreboard")
const kArg = args.find((a) => a.startsWith("--k="))
const K = kArg ? Math.max(1, Number(kArg.slice(4)) || 1) : 1

const JUDGE_SYSTEM =
  "You are a strict, terse evaluator. Given a rubric and an assistant's answer, decide whether the answer satisfies the rubric. Reply with exactly PASS or FAIL as the FIRST word, then a one-line reason."

function loadCorePrompt(coreType: Golden["coreType"]): string {
  const file = coreType === "super-agent" ? "base-super-agent-core.md" : "base-agent-core.md"
  return readFileSync(join(PROMPTS_DIR, file), "utf8")
}

/** Build an LLMConfig from env. Uniform across providers: `config[provider] = {model, apiKey?}`. */
function buildLLMConfig(provider: string, model: string): LLMConfig {
  const sub: Record<string, unknown> = { model }
  const apiKey = process.env.EVAL_API_KEY
  if (apiKey) sub.apiKey = apiKey
  return { provider, [provider]: sub } as unknown as LLMConfig
}

/** Run ONE agent turn and flatten the result into a gradeable outcome. */
async function runAgentTurn(
  llm: ILLMClient,
  systemPrompt: string,
  channel: string,
  userText: string,
): Promise<TurnOutcome> {
  const cm = new ConversationManager(
    new EvalSessionStore(),
    llm,
    "eval-agent",
    undefined, // no tools — the starter goldens grade text behaviour
    new ChannelWorkerRegistry(),
    { enableStreaming: false, maxSteps: 4 },
  )
  try {
    const result = await cm.prompt({
      sessionID: channel,
      userId: "eval-user",
      channelId: channel,
      parts: [{ type: "text", text: userText }],
      systemPrompt,
    })
    const finalText = result.parts
      .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text" && !p.synthetic)
      .map((p) => p.text)
      .join("\n")
    const toolCalls = result.parts
      .filter((p): p is Extract<typeof p, { type: "tool" }> => p.type === "tool")
      .map((p) => ({ name: p.tool, input: (p.state as { input?: unknown }).input }))
    return { finalText, toolCalls, errored: false }
  } catch (err) {
    return { finalText: "", toolCalls: [], errored: true, errorMessage: (err as Error).message }
  }
}

/**
 * Optional Latitude mirror (C0 reuse). Best-effort, fire-and-forget — it never
 * affects the verdict. Returns undefined unless --scoreboard AND LATITUDE_* env.
 */
function buildScoreboard(): ScoreboardSink | undefined {
  if (!SCOREBOARD) return undefined
  const apiBaseUrl = process.env.LATITUDE_API_URL
  const token = process.env.LATITUDE_EXPORT_TOKEN
  const project = process.env.LATITUDE_EXPORT_PROJECT
  if (!apiBaseUrl || !token || !project) {
    console.warn(
      "[prompt-regression] --scoreboard set but LATITUDE_* env missing — mirror disabled",
    )
    return undefined
  }
  const client = createLatitudeScoreClient({ apiBaseUrl, token, project })
  const sha = process.env.GITHUB_SHA ?? "local"
  return (entry) => {
    void client
      .submit({
        value: entry.passed ? 1 : 0,
        passed: entry.passed,
        feedback: entry.passed ? "prompt_regression_pass" : "prompt_regression_fail",
        sourceId: `ci-${sha}`,
        trace: { by: "id", id: traceIdFor(`eval-${entry.golden.id}`) },
        metadata: {
          golden: entry.golden.id,
          coreType: entry.golden.coreType,
          passRate: entry.passRate,
        },
      })
      .catch(() => {})
  }
}

async function main(): Promise<number> {
  const provider = process.env.EVAL_PROVIDER
  const model = process.env.EVAL_MODEL
  if (!provider || !model) {
    console.log(
      "[prompt-regression] skipped: set EVAL_PROVIDER + EVAL_MODEL (+ EVAL_API_KEY) to run the behavioural gate. The deterministic contract gate still enforces prompt invariants per-PR.",
    )
    return 0
  }

  let llm: ILLMClient
  try {
    llm = await LLMClientFactory.create(buildLLMConfig(provider, model))
  } catch (err) {
    console.error(`[prompt-regression] setup error building LLM client: ${(err as Error).message}`)
    return 3
  }

  const judge: JudgeFn = async ({ outcome, rubric }) => {
    const verdict = await runAgentTurn(
      llm,
      JUDGE_SYSTEM,
      "eval-judge",
      `Rubric:\n${rubric}\n\nAssistant answer:\n${outcome.finalText || "(no answer / errored)"}\n\nReply PASS or FAIL then a one-line reason.`,
    )
    const firstWord = verdict.finalText.trim().split(/\s+/)[0]?.toUpperCase() ?? ""
    return { pass: firstWord === "PASS", reason: verdict.finalText.slice(0, 200) }
  }

  const runGolden = (golden: Golden): Promise<TurnOutcome> =>
    runAgentTurn(llm, loadCorePrompt(golden.coreType), `eval-${golden.id}`, golden.userText)

  const report = await runGate(GOLDENS, runGolden, { k: K, judge, scoreboard: buildScoreboard() })
  console.log(formatGateReport(report))

  if (report.regressed && BLOCK) {
    console.error("[prompt-regression] BLOCKING: regression detected (--block).")
    return 1
  }
  if (report.regressed) {
    console.warn(
      "[prompt-regression] regression detected (informative; pass --block to fail the build).",
    )
  }
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[prompt-regression] unexpected error: ${(err as Error).stack ?? err}`)
    process.exit(3)
  })
