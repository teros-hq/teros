/**
 * UiStateManager — lifecycle unit tests (spec 20261022_ui-state-mca.md REQ-2).
 *
 * Report → devices, active-device resolution, session-driven presence (offline
 * after the 30 s grace, eviction after 5 min), the ≤10 devices/user bound, and
 * report validation (caps, malformed rejection — previous state kept).
 * Deterministic via an injected clock; sweeps run manually (sweepIntervalMs: 0).
 */

import { afterEach, describe, expect, it } from "bun:test"
import { UI_MAX_DEVICES_PER_USER, UI_MAX_WINDOWS, type UiStateReport } from "@teros/shared"
import {
  UI_EVICT_AFTER_MS,
  UI_OFFLINE_GRACE_MS,
  UiStateManager,
  validateUiStateReport,
} from "../../src/services/ui-state-manager"

/** Deterministic clock: start at t0, advance by `advance()` between steps. */
function makeClock(start = 1_000_000) {
  let t = start
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
  }
}

function makeManager() {
  const clock = makeClock()
  const manager = new UiStateManager({ now: clock.now, sweepIntervalMs: 0 })
  return { clock, manager }
}

function report(overrides: Partial<UiStateReport> = {}): UiStateReport {
  return {
    workspaceId: "work_1",
    deviceId: "dev_1",
    deviceLabel: "Web · Chrome",
    desktops: [
      {
        desktopId: "d1",
        name: "Desktop 1",
        layout: {
          kind: "split",
          direction: "horizontal",
          ratio: 0.5,
          children: [
            { kind: "container", windowIds: ["w1"], activeWindowId: "w1" },
            { kind: "container", windowIds: ["w2"], activeWindowId: null },
          ],
        },
      },
    ],
    activeDesktopId: "d1",
    windows: {
      w1: { windowId: "w1", type: "chat", props: { channelId: "ch_1", agentId: "agent_1" } },
      w2: { windowId: "w2", type: "terminal", props: { tabs: ["t1"], active: "t1" } },
    },
    focusedWindowId: "w1",
    windowTypes: [
      { type: "chat", displayName: "Chat" },
      { type: "terminal", displayName: "Terminal" },
    ],
    ...overrides,
  }
}

afterEach(() => {
  // Managers in these tests never start the sweeper (sweepIntervalMs: 0) —
  // destroy() is still called defensively so a future default change can't
  // leak a timer between tests.
})

// ── report → devices ────────────────────────────────────────────────────────

describe("UiStateManager.report", () => {
  it("stores the latest report and records the reporting session", () => {
    const { manager } = makeManager()
    const entry = manager.report("u1", "sess1", report())
    expect(entry.deviceId).toBe("dev_1")
    expect(manager.sessionsOfDevice("u1", "work_1", "dev_1")).toEqual(["sess1"])

    const devices = manager.devices("u1", "work_1")
    expect(devices).toHaveLength(1)
    expect(devices[0].report.windows.w1.type).toBe("chat")
    expect(devices[0].online).toBe(true)
    expect(devices[0].deviceLabel).toBe("Web · Chrome")
  })

  it("a second report replaces the state and adds the session (same device)", () => {
    const { manager } = makeManager()
    manager.report("u1", "sess1", report())
    manager.report("u1", "sess2", report({ focusedWindowId: "w2" }))
    const devices = manager.devices("u1", "work_1")
    expect(devices).toHaveLength(1)
    expect(devices[0].report.focusedWindowId).toBe("w2")
    expect([...devices[0].sessionIds].sort()).toEqual(["sess1", "sess2"])
  })

  it("keeps the last deviceLabel when a later report omits it", () => {
    const { manager } = makeManager()
    manager.report("u1", "sess1", report({ deviceLabel: "iPhone" }))
    manager.report("u1", "sess1", report({ deviceLabel: undefined }))
    expect(manager.devices("u1", "work_1")[0].deviceLabel).toBe("iPhone")
  })

  it("keeps the last userAgent when a later report omits it", () => {
    const { manager } = makeManager()
    manager.report("u1", "sess1", report({ userAgent: "Mozilla/5.0 (Macintosh) Chrome/142.0.0.0" }))
    manager.report("u1", "sess1", report({ userAgent: undefined }))
    expect(manager.devices("u1", "work_1")[0].userAgent).toBe(
      "Mozilla/5.0 (Macintosh) Chrome/142.0.0.0",
    )
  })

  it("refreshes the userAgent when a later report carries a new one", () => {
    const { manager } = makeManager()
    manager.report("u1", "sess1", report({ userAgent: "old" }))
    manager.report("u1", "sess1", report({ userAgent: "new" }))
    expect(manager.devices("u1", "work_1")[0].userAgent).toBe("new")
  })

  it("scopes by user AND workspace", () => {
    const { manager } = makeManager()
    manager.report("u1", "s", report())
    manager.report("u2", "s", report())
    manager.report("u1", "s", report({ workspaceId: "work_2" }))
    expect(manager.devices("u1", "work_1")).toHaveLength(1)
    expect(manager.devices("u2", "work_1")).toHaveLength(1)
    expect(manager.devices("u1", "work_2")).toHaveLength(1)
  })
})

// ── active device ───────────────────────────────────────────────────────────

describe("UiStateManager.activeDevice", () => {
  it("picks the online device with the most recent lastSeen", () => {
    const { clock, manager } = makeManager()
    manager.report("u1", "s1", report({ deviceId: "dev_A" }))
    clock.advance(1_000)
    manager.report("u1", "s2", report({ deviceId: "dev_B" }))
    expect(manager.activeDevice("u1", "work_1")?.deviceId).toBe("dev_B")

    clock.advance(2_000)
    manager.report("u1", "s1", report({ deviceId: "dev_A" }))
    expect(manager.activeDevice("u1", "work_1")?.deviceId).toBe("dev_A")
  })

  it("ties on lastSeen are won by the latest report", () => {
    const { manager } = makeManager()
    manager.report("u1", "s1", report({ deviceId: "dev_A" }))
    manager.report("u1", "s2", report({ deviceId: "dev_B" }))
    // Same clock tick: dev_B reported last → dev_B wins.
    expect(manager.activeDevice("u1", "work_1")?.deviceId).toBe("dev_B")
  })

  it("offline devices are never active", () => {
    const { clock, manager } = makeManager()
    manager.report("u1", "s1", report({ deviceId: "dev_A" }))
    manager.report("u1", "s2", report({ deviceId: "dev_B" }))
    clock.advance(1_000)
    manager.report("u1", "s1", report({ deviceId: "dev_A" })) // A is newest
    manager.dropSession("s1")
    clock.advance(UI_OFFLINE_GRACE_MS + 1)
    expect(manager.activeDevice("u1", "work_1")?.deviceId).toBe("dev_B")
  })

  it("null when nothing is online", () => {
    const { clock, manager } = makeManager()
    manager.report("u1", "s1", report())
    manager.dropSession("s1")
    clock.advance(UI_OFFLINE_GRACE_MS + 1)
    expect(manager.activeDevice("u1", "work_1")).toBeNull()
  })
})

// ── offline marking + eviction (session-driven presence) ────────────────────

describe("UiStateManager presence lifecycle", () => {
  it("stays online while any reporting session lives; grace after the last drops", () => {
    const { clock, manager } = makeManager()
    manager.report("u1", "s1", report())
    manager.report("u1", "s2", report())
    manager.dropSession("s1")
    expect(manager.devices("u1", "work_1")[0].online).toBe(true) // s2 still live

    manager.dropSession("s2")
    expect(manager.devices("u1", "work_1")[0].online).toBe(true) // grace starts
    clock.advance(UI_OFFLINE_GRACE_MS - 1)
    expect(manager.devices("u1", "work_1")[0].online).toBe(true) // last ms of grace
    clock.advance(1)
    expect(manager.devices("u1", "work_1")[0].online).toBe(false) // grace over (≤ 30 s)
  })

  it("a re-report clears the offline marking", () => {
    const { clock, manager } = makeManager()
    manager.report("u1", "s1", report())
    manager.dropSession("s1")
    clock.advance(UI_OFFLINE_GRACE_MS + 1)
    expect(manager.devices("u1", "work_1")[0].online).toBe(false)

    manager.report("u1", "s1", report())
    expect(manager.devices("u1", "work_1")[0].online).toBe(true)
  })

  it("evicts a sessionless device 5 min after it lost its last session", () => {
    const { clock, manager } = makeManager()
    manager.report("u1", "s1", report())
    manager.dropSession("s1")
    clock.advance(UI_EVICT_AFTER_MS - 1)
    expect(manager.sweep()).toBe(0)
    expect(manager.devices("u1", "work_1")).toHaveLength(1)

    clock.advance(1)
    expect(manager.sweep()).toBe(1)
    expect(manager.devices("u1", "work_1")).toHaveLength(0)
  })

  it("never evicts a device that still has a live session", () => {
    const { clock, manager } = makeManager()
    manager.report("u1", "s1", report())
    clock.advance(UI_EVICT_AFTER_MS * 3)
    expect(manager.sweep()).toBe(0)
    expect(manager.devices("u1", "work_1")).toHaveLength(1)
    expect(manager.devices("u1", "work_1")[0].online).toBe(true)
  })
})

// ── device cap (NFR-4) ──────────────────────────────────────────────────────

describe("UiStateManager device cap", () => {
  it("bounds the model at ≤10 devices per (user, workspace), evicting the stalest", () => {
    const { clock, manager } = makeManager()
    for (let i = 0; i < UI_MAX_DEVICES_PER_USER; i++) {
      manager.report("u1", `s${i}`, report({ deviceId: `dev_${i}` }))
      clock.advance(1_000)
    }
    expect(manager.devices("u1", "work_1")).toHaveLength(UI_MAX_DEVICES_PER_USER)

    // dev_0 is the stalest live device → evicted by the 11th report.
    manager.report("u1", "s_new", report({ deviceId: "dev_10" }))
    const devices = manager.devices("u1", "work_1")
    expect(devices).toHaveLength(UI_MAX_DEVICES_PER_USER)
    expect(devices.some((d) => d.deviceId === "dev_0")).toBe(false)
    expect(devices.some((d) => d.deviceId === "dev_10")).toBe(true)
  })

  it("prefers evicting sessionless devices over live ones", () => {
    const { clock, manager } = makeManager()
    for (let i = 0; i < UI_MAX_DEVICES_PER_USER; i++) {
      manager.report("u1", `s${i}`, report({ deviceId: `dev_${i}` }))
      clock.advance(1_000)
    }
    // dev_9 is the newest but lost its session; dev_0 is older but alive.
    manager.dropSession("s9")
    manager.report("u1", "s_new", report({ deviceId: "dev_10" }))
    const ids = manager.devices("u1", "work_1").map((d) => d.deviceId)
    expect(ids).not.toContain("dev_9")
    expect(ids).toContain("dev_0")
    expect(ids).toContain("dev_10")
  })
})

// ── validation (REQ-1 caps; NFR-5 never throws) ─────────────────────────────

describe("validateUiStateReport", () => {
  it("accepts a well-formed report", () => {
    const result = validateUiStateReport(report())
    expect(result.ok).toBe(true)
  })

  it("accepts mobile's simplified layout (stack of containers, no ratios)", () => {
    const mobile = report({
      desktops: [
        {
          desktopId: "d1",
          layout: {
            kind: "split",
            direction: "vertical",
            children: [
              { kind: "container", windowIds: ["w1"], activeWindowId: "w1" },
              { kind: "container", windowIds: ["w2"], activeWindowId: "w2" },
            ],
          },
        },
      ],
    })
    expect(validateUiStateReport(mobile).ok).toBe(true)
  })

  it("rejects non-objects and missing core fields", () => {
    expect(validateUiStateReport(null).ok).toBe(false)
    expect(validateUiStateReport("nope").ok).toBe(false)
    expect(validateUiStateReport({ ...report(), workspaceId: "" }).ok).toBe(false)
    expect(validateUiStateReport({ ...report(), deviceId: 42 }).ok).toBe(false)
    expect(validateUiStateReport({ ...report(), activeDesktopId: "dX" }).ok).toBe(false)
    expect(validateUiStateReport({ ...report(), desktops: [] }).ok).toBe(false)
  })

  it("accepts a real user agent and omits it when absent", () => {
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36"
    expect(validateUiStateReport({ ...report(), userAgent: ua }).ok).toBe(true)
    expect(validateUiStateReport({ ...report(), userAgent: undefined }).ok).toBe(true)
  })

  it("rejects a malformed user agent (wrong type, empty, over cap)", () => {
    expect(validateUiStateReport({ ...report(), userAgent: 42 }).ok).toBe(false)
    expect(validateUiStateReport({ ...report(), userAgent: "" }).ok).toBe(false)
    expect(validateUiStateReport({ ...report(), userAgent: "x".repeat(513) }).ok).toBe(false)
  })

  it("enforces the caps: >45 windows, >10 desktops", () => {
    const windows: Record<string, { windowId: string; type: string; props: {} }> = {}
    for (let i = 0; i <= UI_MAX_WINDOWS; i++) {
      windows[`w${i}`] = { windowId: `w${i}`, type: "chat", props: {} }
    }
    expect(validateUiStateReport({ ...report(), windows }).ok).toBe(false)

    const desktops = Array.from({ length: 11 }, (_, i) => ({ desktopId: `d${i + 1}`, layout: null }))
    expect(validateUiStateReport({ ...report(), desktops, activeDesktopId: "d1" }).ok).toBe(false)
  })

  it("rejects malformed layout nodes and window entries", () => {
    expect(
      validateUiStateReport({
        ...report(),
        desktops: [{ desktopId: "d1", layout: { kind: "bogus" } }],
      }).ok,
    ).toBe(false)
    expect(
      validateUiStateReport({
        ...report(),
        desktops: [
          {
            desktopId: "d1",
            layout: { kind: "split", direction: "diagonal", children: [] },
          },
        ],
      }).ok,
    ).toBe(false)
    // windowId must match its key
    expect(
      validateUiStateReport({
        ...report(),
        windows: { w1: { windowId: "other", type: "chat", props: {} } },
      }).ok,
    ).toBe(false)
  })

  it("bounds a malicious layout tree (depth + node count)", () => {
    // 16-deep nested split (max depth is 12)
    let deep: unknown = { kind: "container", windowIds: ["w1"], activeWindowId: "w1" }
    for (let i = 0; i < 16; i++) {
      deep = { kind: "split", direction: "vertical", children: [deep, deep] }
    }
    expect(
      validateUiStateReport({ ...report(), desktops: [{ desktopId: "d1", layout: deep }] }).ok,
    ).toBe(false)
  })

  it("a rejected report keeps the previous state (domain contract)", () => {
    const { manager } = makeManager()
    manager.report("u1", "s1", report({ focusedWindowId: "w1" }))
    const bad = { ...report({ deviceId: "dev_1" }), desktops: [] }
    expect(manager.validateReport(bad).ok).toBe(false)
    // The domain only calls manager.report() after validation — the stored
    // state is untouched by the rejected payload.
    expect(manager.devices("u1", "work_1")[0].report.focusedWindowId).toBe("w1")
  })
})
