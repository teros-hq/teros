import { beforeEach, describe, expect, it, vi } from "vitest"

const saved = new Map<string, unknown>()
vi.mock("../../src/services/storage", () => ({
  STORAGE_KEYS: { TERMINAL_FLOAT: "teros_terminal_float" },
  storage: {
    get: async (k: string) => saved.get(k) ?? null,
    set: async (k: string, v: unknown) => {
      saved.set(k, v)
    },
  },
}))

const { useTerminalFloatStore } = await import(
  "../../src/windows/TerminalWindow/floating/terminalFloatStore"
)
const store = () => useTerminalFloatStore.getState()

describe("terminalFloatStore", () => {
  beforeEach(() => {
    saved.clear()
    useTerminalFloatStore.setState({ floating: {}, drag: null, hydratedFor: null })
  })

  it("pops out, raises, minimises and docks — and persists each step", () => {
    store().popOut("a", { x: 600, y: 300 })
    store().popOut("b")
    const { a, b } = store().floating
    expect(b.z).toBeGreaterThan(a.z)
    expect(a.x).toBe(600 - 260)

    store().focus("a")
    expect(store().floating.a.z).toBeGreaterThan(store().floating.b.z)

    store().minimize("a", true)
    expect(store().floating.a.minimized).toBe(true)
    store().focus("a")
    expect(store().floating.a.minimized).toBe(false)

    store().dock("a")
    expect(Object.keys(store().floating)).toEqual(["b"])
    expect(Object.keys(saved.get("teros_terminal_float") as object)).toEqual(["b"])
  })

  it("keeps at most three floating: the one at the back docks", () => {
    for (const id of ["a", "b", "c"]) store().popOut(id)
    store().focus("a")
    store().popOut("d")
    expect(Object.keys(store().floating).sort()).toEqual(["a", "c", "d"])
  })

  it("popping out a floating terminal brings it back instead of adding one", () => {
    store().popOut("a")
    store().minimize("a", true)
    store().popOut("a")
    expect(Object.keys(store().floating)).toEqual(["a"])
    expect(store().floating.a.minimized).toBe(false)
  })

  it("hydrates a workspace's saved windows, clamped, once", async () => {
    saved.set("teros_terminal_float", {
      a: { x: -9999, y: 40, w: 520, h: 340, z: 2, minimized: true },
      bad: null,
    })
    await store().hydrate("ws1")
    expect(store().hydratedFor).toBe("ws1")
    expect(Object.keys(store().floating)).toEqual(["a"])
    expect(store().floating.a.x).toBe(64 - 520)
    expect(store().floating.a.minimized).toBe(true)
    saved.set("teros_terminal_float", {})
    await store().hydrate("ws1")
    expect(Object.keys(store().floating)).toEqual(["a"])
  })
})
