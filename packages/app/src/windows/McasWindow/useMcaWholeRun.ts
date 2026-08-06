/**
 * Whole-MCA sequential runner + destructive-confirm gate (plan 03 / D-05/D-09/D-13/SC1/SC4). Runs an
 * MCA's read-only tools first, sequentially, through the shared single-tool path (`onRetestPress`,
 * which opens the input Sheet for input-requiring tools); when destructive tools remain the run
 * PAUSES and hands off to the confirm — destructive tools are never dropped (TEST-02). Non-runnable
 * MCAs never start (D-13). A re-entrancy guard (ref, not the state closure) allows one whole-MCA run
 * per MCA at a time.
 *
 * `runToolsSequentially` (shared by the read-only loop and the destructive-confirm so the loop lives
 * in one place) catches each tool individually so one failure never aborts the rest (SC4). Schemas
 * are loaded up-front so classification reads manifest annotations regardless of cache order; a
 * failed fetch leaves `schemas` empty → every tool classifies destructive, so nothing runs
 * unconfirmed (T-08-04). Cancel keeps the already-shown read-only results and simply does not run the
 * destructive tools (D-09/TEST-02).
 *
 * `retestSingle` is the SAME confirm gate for a single-tool Retest: a destructive tool routes through
 * the shared confirm instead of running immediately (the whole-MCA gate never covered per-tool
 * Retest). The gate lives ONLY on the button entry point — the internal loop calls the raw
 * `onRetestPress`, so a confirmed destructive tool is not re-gated into an infinite prompt.
 *
 * The re-entrancy guard is HELD across the confirm hand-off: `runWholeMca` keeps the MCA marked
 * running while its destructive confirm is pending (so its Test button stays disabled), and the
 * guard is released only when confirm/cancel resolves — not the moment the confirm opens.
 *
 * The orchestration bodies live in module-scope `*Impl` helpers and the run/confirm state in the
 * `useReentrancyGuard` / `useDestructiveConfirm` sub-hooks, so each function stays under the
 * CLAUDE.md line/complexity limits.
 */
import { useCallback, useRef, useState } from "react"
import type { McaData, McaResolvability, McaToolSchema } from "../../services/AppApi"
import { classifyTools } from "./mcaHealth.utils"

type PendingDestructive = { mcaId: string; tools: string[] } | null

export interface McaWholeRun {
  runningMcas: Set<string>
  pendingDestructive: PendingDestructive
  runWholeMca: (mcaId: string) => Promise<void>
  /** Single-tool Retest that routes a destructive tool through the shared confirm (button entry). */
  retestSingle: (mcaId: string, tool: string) => Promise<void>
  confirmDestructive: () => Promise<void>
  cancelDestructive: () => void
}

/** Load a tool's schemas, swallowing a fetch failure so an empty result → all-destructive (T-08-04). */
async function resolveSchemasSafe(
  ensureSchemas: (mcaId: string) => Promise<McaToolSchema[]>,
  mcaId: string,
): Promise<McaToolSchema[]> {
  try {
    return await ensureSchemas(mcaId)
  } catch {
    return []
  }
}

/** Run each tool through the shared single-tool path, catching per-tool so one failure never aborts. */
async function runToolsSequentiallyImpl(
  mcaId: string,
  tools: string[],
  onRetestPress: (mcaId: string, tool: string) => Promise<void>,
): Promise<void> {
  for (const tool of tools) {
    try {
      await onRetestPress(mcaId, tool)
    } catch {
      // Per-tool catch (SC4): the failed row already surfaces via runSingleTool's own catch.
    }
  }
}

/** Deps threaded from the hook into `runWholeMcaImpl`. */
interface RunDeps {
  mcas: McaData[]
  onRetestPress: (mcaId: string, tool: string) => Promise<void>
  resolvabilityCache: Map<string, McaResolvability>
  ensureResolvability: (mcaId: string) => Promise<McaResolvability | undefined>
  ensureSchemas: (mcaId: string) => Promise<McaToolSchema[]>
  runToolsSequentially: (mcaId: string, tools: string[]) => Promise<void>
  requestConfirm: (mcaId: string, tools: string[]) => void
  tryAcquire: (mcaId: string) => boolean
  release: (mcaId: string) => void
}

/**
 * Whole-MCA run: read-only tools first (sequential), then hand off to the destructive confirm while
 * KEEPING the re-entrancy guard held (confirm/cancel releases it). Non-runnable MCAs never start.
 */
async function runWholeMcaImpl(mcaId: string, d: RunDeps): Promise<void> {
  const tools = d.mcas.find((m) => m.mcaId === mcaId)?.tools ?? []
  if (tools.length === 0) return
  if (!d.tryAcquire(mcaId)) return
  let handedOffToConfirm = false
  try {
    const resolvability = d.resolvabilityCache.get(mcaId) ?? (await d.ensureResolvability(mcaId))
    if (resolvability?.runnable === false) return
    const schemas = await resolveSchemasSafe(d.ensureSchemas, mcaId)
    const { readOnly, destructive } = classifyTools(tools, schemas)
    await d.runToolsSequentially(mcaId, readOnly)
    if (destructive.length > 0) {
      d.requestConfirm(mcaId, destructive)
      handedOffToConfirm = true
    }
  } finally {
    if (!handedOffToConfirm) d.release(mcaId)
  }
}

/** Deps threaded from the hook into `retestSingleImpl`. */
type RetestDeps = Pick<RunDeps, "ensureSchemas" | "onRetestPress" | "requestConfirm">

/**
 * Single-tool Retest through the SAME confirm gate: a destructive tool opens the shared confirm; a
 * read-only tool delegates to the raw single-tool path. Schemas unavailable → treat as destructive.
 */
async function retestSingleImpl(mcaId: string, tool: string, d: RetestDeps): Promise<void> {
  const schemas = await resolveSchemasSafe(d.ensureSchemas, mcaId)
  const { destructive } = classifyTools([tool], schemas)
  if (destructive.length > 0) {
    d.requestConfirm(mcaId, [tool])
    return
  }
  await d.onRetestPress(mcaId, tool)
}

interface ReentrancyGuard {
  runningMcas: Set<string>
  /** Acquire the per-MCA guard; false if already held (a same-tick double-fire bails synchronously). */
  tryAcquire: (mcaId: string) => boolean
  /** Release the guard; no-op if the MCA is not held (e.g. a retestSingle path that never acquired). */
  release: (mcaId: string) => void
}

/**
 * One whole-MCA run per MCA at a time. `runningMcasRef` is the guard's synchronous source of truth (a
 * state closure reads a stale Set); the state mirror drives the disabled render.
 */
function useReentrancyGuard(): ReentrancyGuard {
  const runningMcasRef = useRef<Set<string>>(new Set())
  const [runningMcas, setRunningMcas] = useState<Set<string>>(new Set())

  const tryAcquire = useCallback((mcaId: string) => {
    if (runningMcasRef.current.has(mcaId)) return false
    runningMcasRef.current.add(mcaId)
    setRunningMcas(new Set(runningMcasRef.current))
    return true
  }, [])

  const release = useCallback((mcaId: string) => {
    if (runningMcasRef.current.delete(mcaId)) setRunningMcas(new Set(runningMcasRef.current))
  }, [])

  return { runningMcas, tryAcquire, release }
}

interface DestructiveConfirm {
  pendingDestructive: PendingDestructive
  requestConfirm: (mcaId: string, tools: string[]) => void
  confirmDestructive: () => Promise<void>
  cancelDestructive: () => void
}

/**
 * Owns the pending-destructive confirm state + its confirm/cancel handlers. `confirm` runs the parked
 * tools then releases the whole-MCA guard; `cancel` skips them but still releases the guard.
 */
function useDestructiveConfirm(
  runToolsSequentially: (mcaId: string, tools: string[]) => Promise<void>,
  release: (mcaId: string) => void,
): DestructiveConfirm {
  const [pendingDestructive, setPendingDestructive] = useState<PendingDestructive>(null)

  const requestConfirm = useCallback((mcaId: string, tools: string[]) => {
    setPendingDestructive({ mcaId, tools })
  }, [])

  const confirmDestructive = useCallback(async () => {
    setPendingDestructive(null)
    if (!pendingDestructive) return
    try {
      await runToolsSequentially(pendingDestructive.mcaId, pendingDestructive.tools)
    } finally {
      release(pendingDestructive.mcaId)
    }
  }, [pendingDestructive, runToolsSequentially, release])

  const cancelDestructive = useCallback(() => {
    setPendingDestructive(null)
    if (pendingDestructive) release(pendingDestructive.mcaId)
  }, [pendingDestructive, release])

  return { pendingDestructive, requestConfirm, confirmDestructive, cancelDestructive }
}

export function useMcaWholeRun(
  mcas: McaData[],
  onRetestPress: (mcaId: string, tool: string) => Promise<void>,
  resolvabilityCache: Map<string, McaResolvability>,
  ensureResolvability: (mcaId: string) => Promise<McaResolvability | undefined>,
  ensureSchemas: (mcaId: string) => Promise<McaToolSchema[]>,
): McaWholeRun {
  const { runningMcas, tryAcquire, release } = useReentrancyGuard()

  const runToolsSequentially = useCallback(
    (mcaId: string, tools: string[]) => runToolsSequentiallyImpl(mcaId, tools, onRetestPress),
    [onRetestPress],
  )

  const { pendingDestructive, requestConfirm, confirmDestructive, cancelDestructive } =
    useDestructiveConfirm(runToolsSequentially, release)

  const runWholeMca = useCallback(
    (mcaId: string) =>
      runWholeMcaImpl(mcaId, {
        mcas,
        onRetestPress,
        resolvabilityCache,
        ensureResolvability,
        ensureSchemas,
        runToolsSequentially,
        requestConfirm,
        tryAcquire,
        release,
      }),
    [
      mcas,
      onRetestPress,
      resolvabilityCache,
      ensureResolvability,
      ensureSchemas,
      runToolsSequentially,
      requestConfirm,
      tryAcquire,
      release,
    ],
  )

  const retestSingle = useCallback(
    (mcaId: string, tool: string) =>
      retestSingleImpl(mcaId, tool, { ensureSchemas, onRetestPress, requestConfirm }),
    [ensureSchemas, onRetestPress, requestConfirm],
  )

  return {
    runningMcas,
    pendingDestructive,
    runWholeMca,
    retestSingle,
    confirmDestructive,
    cancelDestructive,
  }
}
