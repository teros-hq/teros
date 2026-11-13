import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const world = vi.hoisted(() => ({
  active: "w1" as string | null,
  restoredFor: "w1" as string | null,
  restoreGeneration: 0,
  listeners: new Set<() => void>(),
  show: [] as Array<[unknown, string]>,
  float: [] as Array<[unknown, string]>,
  replaced: [] as string[],
}))

vi.mock("expo-router", () => ({
  router: { replace: (to: string) => world.replaced.push(to) },
}))
vi.mock("../../store/workspaceStore", () => ({
  useWorkspaceStore: {
    getState: () => ({ activeWorkspaceId: world.active }),
    subscribe: (l: () => void) => {
      world.listeners.add(l)
      return () => world.listeners.delete(l)
    },
  },
}))
vi.mock("../../store/tilingStore", () => ({
  useTilingStore: {
    getState: () => ({
      layoutRestoredForWorkspace: world.restoredFor,
      restoreGeneration: world.restoreGeneration,
    }),
    subscribe: (l: () => void) => {
      world.listeners.add(l)
      return () => world.listeners.delete(l)
    },
  },
}))
vi.mock("../../windows/TerminalWindow/terminalSessions", () => ({
  showTerminalSession: (workspaceId: unknown, terminalId: string) => {
    world.show.push([workspaceId, terminalId])
  },
  floatTerminalSession: (workspaceId: unknown, terminalId: string) => {
    world.float.push([workspaceId, terminalId])
  },
}))

import { openTerminalNeed } from "./openTerminalNeed"

function emit() {
  for (const l of [...world.listeners]) l()
}

beforeEach(() => {
  vi.useFakeTimers()
  world.active = "w1"
  world.restoredFor = "w1"
  world.restoreGeneration = 0
  world.listeners.clear()
  world.show = []
  world.float = []
  world.replaced = []
})
afterEach(() => {
  vi.useRealTimers()
})

describe("openTerminalNeed: a notice shows its session [TW-AC-3]", () => {
  it("in the workspace on screen it shows the session at once, with no navigation", async () => {
    await openTerminalNeed("w1", "t1")
    expect(world.show).toEqual([["w1", "t1"]])
    expect(world.replaced).toEqual([])
  })

  it("with no workspace given it shows the session where the person is", async () => {
    await openTerminalNeed(null, "t1")
    expect(world.show).toEqual([[null, "t1"]])
  })

  it("a session of another workspace switches there first and shows it once the layout settled", async () => {
    const done = openTerminalNeed("w2", "t9")
    expect(world.replaced).toEqual(["/workspace/w2"])
    expect(world.show).toEqual([])
    world.active = "w2"
    emit()
    expect(world.show).toEqual([])
    world.restoredFor = "w2"
    world.restoreGeneration = 1
    emit()
    await vi.advanceTimersByTimeAsync(700)
    await done
    expect(world.show).toEqual([["w2", "t9"]])
  })

  it("a layout restored again while it waits is waited for too", async () => {
    const done = openTerminalNeed("w2", "t9")
    world.active = "w2"
    world.restoredFor = "w2"
    emit()
    await vi.advanceTimersByTimeAsync(300)
    world.restoreGeneration = 5
    await vi.advanceTimersByTimeAsync(400)
    expect(world.show).toEqual([])
    await vi.advanceTimersByTimeAsync(700)
    await done
    expect(world.show).toEqual([["w2", "t9"]])
  })

  it("a workspace that never comes up shows nothing", async () => {
    const done = openTerminalNeed("w2", "t9")
    await vi.advanceTimersByTimeAsync(16_000)
    await done
    expect(world.show).toEqual([])
  })

  it("[FLOAT-AC-17] asked to float, it floats the session's window instead of taking the person to a tab", async () => {
    await openTerminalNeed("w1", "t1", "float")
    expect(world.float).toEqual([["w1", "t1"]])
    expect(world.show).toEqual([])
    expect(world.replaced).toEqual([])
  })

  it("[FLOAT-AC-17] a session of another workspace floats there once that workspace is up", async () => {
    const done = openTerminalNeed("w2", "t9", "float")
    expect(world.replaced).toEqual(["/workspace/w2"])
    world.active = "w2"
    world.restoredFor = "w2"
    world.restoreGeneration = 1
    emit()
    await vi.advanceTimersByTimeAsync(700)
    await done
    expect(world.float).toEqual([["w2", "t9"]])
    expect(world.show).toEqual([])
  })

  it("[FLOAT-AC-17] the float it opens is the window system's: nothing here draws a terminal of its own", () => {
    const source = readFileSync(resolve(__dirname, "openTerminalNeed.ts"), "utf8")
    expect(source).not.toMatch(/TerminalView|popOut/)
  })
})
