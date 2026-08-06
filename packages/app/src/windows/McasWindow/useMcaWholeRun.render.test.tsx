/**
 * useMcaWholeRun — synchronous re-entrancy-guard coverage (PR #347 review iter-2 follow-up).
 *
 * The dashboard render suite's "second Test press is a no-op" case only exercises the UI
 * button-disable path (`testDisabled` folds `runningMcas`), because by the time the second click
 * fires React has already re-rendered the Test button disabled. It never reaches the SYNCHRONOUS
 * `runningMcasRef` guard in `runWholeMca` — mutation check: deleting that guard leaves the render
 * test green. This hook test isolates the ref guard: two `runWholeMca(id)` calls fired in the SAME
 * tick (before the first's first await resolves) must run the MCA exactly once.
 *
 *   cd packages/app && npx vitest run src/windows/McasWindow/useMcaWholeRun.render.test.tsx
 */
import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { McaData, McaResolvability, McaToolSchema } from "../../services/AppApi"
import { useMcaWholeRun } from "./useMcaWholeRun"

const mcas = [{ mcaId: "slack", name: "Slack", tools: ["read-a"] }] as unknown as McaData[]
const readOnlySchemas = [
  {
    tool: "read-a",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
] as unknown as McaToolSchema[]

let onRetestPress: ReturnType<typeof vi.fn>
let ensureResolvability: ReturnType<typeof vi.fn>
let ensureSchemas: ReturnType<typeof vi.fn>

function mountRunner(cache = new Map<string, McaResolvability>()) {
  return renderHook(() =>
    useMcaWholeRun(mcas, onRetestPress, cache, ensureResolvability, ensureSchemas),
  )
}

beforeEach(() => {
  onRetestPress = vi.fn().mockResolvedValue(undefined)
  ensureResolvability = vi.fn().mockResolvedValue({ runnable: true })
  ensureSchemas = vi.fn().mockResolvedValue(readOnlySchemas)
})

describe("useMcaWholeRun re-entrancy guard (PR #347 review iter-2)", () => {
  it("runs the MCA once when runWholeMca is fired twice in the same tick (runningMcasRef guard)", async () => {
    const { result } = mountRunner()

    await act(async () => {
      // Same-tick double-fire: the first call adds "slack" to runningMcasRef before its first await;
      // the second must hit `if (runningMcasRef.current.has(mcaId)) return` and bail with no work.
      const p1 = result.current.runWholeMca("slack")
      const p2 = result.current.runWholeMca("slack")
      await Promise.all([p1, p2])
    })

    // The guarded second call never probed resolvability nor ran the read-only tool.
    expect(ensureResolvability).toHaveBeenCalledTimes(1)
    expect(onRetestPress).toHaveBeenCalledTimes(1)
    expect(onRetestPress).toHaveBeenCalledWith("slack", "read-a")
    // Guard released in the finally → the running mirror is empty again.
    expect(result.current.runningMcas.has("slack")).toBe(false)
  })

  it("allows a fresh run after the first completes (guard is per-run, not permanent)", async () => {
    const { result } = mountRunner()

    await act(async () => {
      await result.current.runWholeMca("slack")
    })
    await act(async () => {
      await result.current.runWholeMca("slack")
    })

    // Two sequential (non-overlapping) runs each pass the guard → the tool ran both times.
    expect(onRetestPress).toHaveBeenCalledTimes(2)
  })
})
