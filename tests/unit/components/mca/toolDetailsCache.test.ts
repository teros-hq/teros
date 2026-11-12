/**
 * Unit tests — ToolDetailsCache.
 *
 * Maps to engineering principle 3 (fail fast) and 4 (strict interfaces): the
 * cache must dedup concurrent requests for the same app, never re-fetch a
 * satisfied tool, and surface failure as an observable state rather than a
 * silent empty result.
 */

import { describe, expect, it, mock } from "bun:test"
import {
  type ToolDetail,
  ToolDetailsCache,
} from "../../../../packages/app/src/components/mca/tool-details-cache"

function detail(requestedName: string, name = requestedName): ToolDetail {
  return {
    requestedName,
    name,
    description: `desc:${name}`,
    parameters: { type: "object", properties: {} },
  }
}

describe("ToolDetailsCache", () => {
  it("(1) fetches once and serves subsequent reads from cache", async () => {
    const fetcher = mock(async () => ({ appId: "a1", mcaId: "m", tools: [detail("share-file")] }))
    const cache = new ToolDetailsCache(fetcher)

    await cache.ensure("a1", ["share-file"])
    await cache.ensure("a1", ["share-file"])

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(cache.get("a1", "share-file")?.description).toBe("desc:share-file")
  })

  it("(2) dedups concurrent ensure() calls for the same app into one fetch", async () => {
    const fetcher = mock(async () => ({ appId: "a1", mcaId: "m", tools: [detail("x")] }))
    const cache = new ToolDetailsCache(fetcher)

    await Promise.all([
      cache.ensure("a1", ["x"]),
      cache.ensure("a1", ["x"]),
      cache.ensure("a1", ["x"]),
    ])

    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("(3) only requests the tools it does not already hold", async () => {
    const fetcher = mock(async (_appId: string, toolNames: string[]) => ({
      appId: "a1",
      mcaId: "m",
      tools: toolNames.map((n) => detail(n)),
    }))
    const cache = new ToolDetailsCache(fetcher)

    await cache.ensure("a1", ["a"])
    await cache.ensure("a1", ["a", "b"])

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[1][1]).toEqual(["b"])
  })

  it("(4) keys entries per app so two apps sharing a tool name do not collide", async () => {
    const fetcher = mock(async (appId: string) => ({
      appId,
      mcaId: "m",
      tools: [{ ...detail("list-files"), description: `from:${appId}` }],
    }))
    const cache = new ToolDetailsCache(fetcher)

    await cache.ensure("a1", ["list-files"])
    await cache.ensure("a2", ["list-files"])

    expect(cache.get("a1", "list-files")?.description).toBe("from:a1")
    expect(cache.get("a2", "list-files")?.description).toBe("from:a2")
  })

  it("(5) records a failure as observable state and does not cache a bogus entry", async () => {
    const fetcher = mock(async () => {
      throw new Error("ws timeout")
    })
    const cache = new ToolDetailsCache(fetcher)

    await cache.ensure("a1", ["x"])

    expect(cache.get("a1", "x")).toBeUndefined()
    expect(cache.hasFailed("a1", "x")).toBe(true)
  })

  it("(5b) reports the failure through onError instead of swallowing it", async () => {
    // Engineering principle 2: a degraded result must never be silent.
    const boom = new Error("ws timeout")
    const fetcher = mock(async () => {
      throw boom
    })
    const onError = mock(() => {})
    const cache = new ToolDetailsCache(fetcher, onError)

    await cache.ensure("a1", ["x", "y"])

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0]).toBe(boom)
    expect(onError.mock.calls[0][1]).toEqual({ appId: "a1", toolNames: ["x", "y"] })
  })

  it("(5c) ensure() never rejects, even when the fetcher throws and no reporter is given", async () => {
    // The ControlsBar must stay interactive — a rejected promise here would
    // surface as an unhandled rejection in the render tree.
    const cache = new ToolDetailsCache(async () => {
      throw new Error("boom")
    })

    await cache.ensure("a1", ["x"])

    expect(cache.hasFailed("a1", "x")).toBe(true)
  })

  it("(5d) a throwing onError reporter cannot make ensure() reject", async () => {
    // Reporting is best-effort. If the reporter itself throws, the rejection
    // would escape into the render tree as an unhandled rejection and break the
    // "Allow/Deny stays interactive" guarantee.
    const cache = new ToolDetailsCache(
      async () => {
        throw new Error("ws timeout")
      },
      () => {
        throw new Error("sentry is down")
      },
    )

    await cache.ensure("a1", ["x"])

    expect(cache.hasFailed("a1", "x")).toBe(true)
  })

  it("(5e) an overlapping concurrent call does not re-fetch an already-resolved name", async () => {
    // Two components watching overlapping tool sets for the same app: a single
    // card via useToolDetails and a grouped panel via useToolDetailsBatch. The
    // second call must request only what the first did not already settle.
    const seen: string[][] = []
    const fetcher = mock(async (appId: string, toolNames: string[]) => {
      seen.push([...toolNames])
      await new Promise((resolve) => setTimeout(resolve, 10))
      return { appId, mcaId: "m", tools: toolNames.map((n) => detail(n)) }
    })
    const cache = new ToolDetailsCache(fetcher)

    await Promise.all([cache.ensure("a1", ["x", "y"]), cache.ensure("a1", ["y", "z"])])

    // "y" was already covered by the first fetch — the second must ask for "z" only.
    expect(seen).toEqual([["x", "y"], ["z"]])
  })

  it("(6) a tool the backend omitted is marked failed, not left pending forever", async () => {
    // Backend skipped it (broken parameters schema) — the client must stop waiting.
    const fetcher = mock(async () => ({ appId: "a1", mcaId: "m", tools: [] }))
    const cache = new ToolDetailsCache(fetcher)

    await cache.ensure("a1", ["ghost"])

    expect(cache.get("a1", "ghost")).toBeUndefined()
    expect(cache.hasFailed("a1", "ghost")).toBe(true)
  })

  it("(7) ensure() with no appId or no tools is a no-op, never a fetch", async () => {
    const fetcher = mock(async () => ({ appId: "", mcaId: "", tools: [] }))
    const cache = new ToolDetailsCache(fetcher)

    await cache.ensure(undefined, ["x"])
    await cache.ensure("a1", [])

    expect(fetcher).not.toHaveBeenCalled()
  })

  it("(8) reset() clears entries and failures", async () => {
    const fetcher = mock(async () => ({ appId: "a1", mcaId: "m", tools: [detail("x")] }))
    const cache = new ToolDetailsCache(fetcher)

    await cache.ensure("a1", ["x"])
    cache.reset()

    expect(cache.get("a1", "x")).toBeUndefined()
    await cache.ensure("a1", ["x"])
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  // ─── in-flight coalescing, retry, and reset-mid-flight. The original
  // implementation keyed in-flight work per APP and read the entry once before
  // awaiting, so it coalesced exactly two callers and lost every registration
  // but the last. `PermissionDetail` (per tool) and `GroupedPermissionPanel`
  // (per app) mount against this cache at overlapping times, so three or more
  // concurrent callers is the normal case, not a contrived one.

  it("(9) three staggered callers never double-fetch a name already in flight", async () => {
    const seen: string[][] = []
    const cache = new ToolDetailsCache(async (_appId, names) => {
      seen.push([...names])
      // "t2" is the slow one, still in flight when the 4th caller arrives.
      await new Promise((r) => setTimeout(r, names.includes("t2") ? 60 : 10))
      return { appId: "a1", mcaId: "m", tools: names.map((n) => detail(n)) }
    })

    const first = [cache.ensure("a1", ["t1"]), cache.ensure("a1", ["t2"]), cache.ensure("a1", ["t3"])]
    await new Promise((r) => setTimeout(r, 30))
    const late = cache.ensure("a1", ["t2"])
    await Promise.all([...first, late])

    expect(seen.flat().filter((n) => n === "t2")).toHaveLength(1)
    expect(seen.flat().sort()).toEqual(["t1", "t2", "t3"])
  })

  it("(10) a second app in flight does not steal or block the first app's fetch", async () => {
    const seen: Array<{ appId: string; names: string[] }> = []
    const cache = new ToolDetailsCache(async (appId, names) => {
      seen.push({ appId, names: [...names] })
      await new Promise((r) => setTimeout(r, appId === "a1" ? 50 : 5))
      return { appId, mcaId: "m", tools: names.map((n) => detail(n)) }
    })

    const slow = cache.ensure("a1", ["x"])
    const fast = cache.ensure("a2", ["x"])
    await Promise.all([slow, fast])

    expect(seen).toHaveLength(2)
    expect(cache.get("a1", "x")).toBeDefined()
    expect(cache.get("a2", "x")).toBeDefined()
  })

  it("(11) clearFailures lets a transient failure be retried", async () => {
    let attempt = 0
    const cache = new ToolDetailsCache(async () => {
      attempt += 1
      if (attempt === 1) throw new Error("socket closed")
      return { appId: "a1", mcaId: "m", tools: [detail("x")] }
    })

    await cache.ensure("a1", ["x"])
    expect(cache.hasFailed("a1", "x")).toBe(true)

    // Without this the card renders degraded for the rest of the session — one
    // blip permanently poisons every later approval of that tool.
    cache.clearFailures()
    await cache.ensure("a1", ["x"])

    expect(cache.hasFailed("a1", "x")).toBe(false)
    expect(cache.get("a1", "x")).toBeDefined()
  })

  it("(12) reset() during an in-flight fetch is not undone when that fetch lands", async () => {
    let release: (() => void) | undefined
    const cache = new ToolDetailsCache(async (appId, names) => {
      await new Promise<void>((r) => {
        release = r
      })
      return { appId, mcaId: "m", tools: names.map((n) => detail(n)) }
    })

    const pending = cache.ensure("a1", ["x"])
    await new Promise((r) => setTimeout(r, 5))
    cache.reset()
    release?.()
    await pending

    // A logout that a late response repopulates is the leak reset() exists to stop.
    expect(cache.get("a1", "x")).toBeUndefined()
    expect(cache.hasFailed("a1", "x")).toBe(false)
  })

  it("(13) a rejected fetch for one app leaves another app's cached entries intact", async () => {
    const cache = new ToolDetailsCache(async (appId, names) => {
      if (appId === "bad") throw new Error("boom")
      return { appId, mcaId: "m", tools: names.map((n) => detail(n)) }
    })

    await cache.ensure("good", ["x"])
    await cache.ensure("bad", ["x"])

    expect(cache.get("good", "x")).toBeDefined()
    expect(cache.hasFailed("good", "x")).toBe(false)
    expect(cache.hasFailed("bad", "x")).toBe(true)
  })

  it("(14) notifies onRetryable subscribers when clearFailures actually drops something", async () => {
    let calls = 0
    const cache = new ToolDetailsCache(async () => {
      throw new Error("boom")
    })
    cache.onRetryable(() => {
      calls += 1
    })

    await cache.ensure("a1", ["x"])
    cache.clearFailures()

    // Without this notification `clearFailures` only helped cards that had not
    // mounted yet — an already-mounted card's fetch effect never re-runs.
    expect(calls).toBe(1)
  })

  it("(15) stays silent when clearFailures had nothing to drop", async () => {
    let calls = 0
    const cache = new ToolDetailsCache(async (appId, names) => ({
      appId,
      mcaId: "m",
      tools: names.map((n) => detail(n)),
    }))
    cache.onRetryable(() => {
      calls += 1
    })

    await cache.ensure("a1", ["x"])
    cache.clearFailures()

    // Every reconnect on a healthy session would otherwise re-render every
    // mounted approval card for nothing.
    expect(calls).toBe(0)
  })

  it("(16) unsubscribes, and one throwing subscriber does not starve the others", async () => {
    const seen: string[] = []
    const cache = new ToolDetailsCache(async () => {
      throw new Error("boom")
    })
    const off = cache.onRetryable(() => seen.push("gone"))
    cache.onRetryable(() => {
      throw new Error("subscriber exploded")
    })
    cache.onRetryable(() => seen.push("after"))
    off()

    await cache.ensure("a1", ["x"])
    // A throwing subscriber must not escape into the transport's "connected"
    // handler, nor stop later subscribers from being told.
    expect(() => cache.clearFailures()).not.toThrow()
    expect(seen).toEqual(["after"])
  })
})
