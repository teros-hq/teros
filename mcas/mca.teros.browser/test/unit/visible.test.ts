/**
 * Visible tabs of the Browser MCA (spec BRW-AC-1/2/3): fence + gate, input
 * mapping, suggestions, and the tab lifecycle over a fake page / CDP session
 * / stream. No browser is launched.
 *   cd mcas/mca.teros.browser && bun test test/unit/visible.test.ts
 */

import { describe, expect, it } from "bun:test"
import { EventEmitter } from "node:events"
import type { McaStream, McaStreams, StreamViewer } from "@teros/mca-sdk"
import { FENCE_BLUR_GRACE_MS, FENCE_INPUT_GRACE_MS, Fence, gate } from "../../src/visible/fence.js"
import { clampSize, inputParams, normalizeUrl } from "../../src/visible/input.js"
import { isUrlLike, parseCompletions, SuggestService, VisitLog } from "../../src/visible/suggest.js"
import { streamIdOf, VisibleTabs } from "../../src/visible/tabs.js"
import { gateCurrent, INPUT_TOOLS, type VisibleRuntime } from "../../src/visible/tools.js"

describe("Fence + gate (BRW-REQ-5)", () => {
  it("[BRW-AC-1] focus + input arms it; blur shortens the grace; consent gates first", () => {
    let t = 0
    const fence = new Fence(() => t)
    expect(gate(fence)?.code).toBe("agent_control_disabled")
    fence.consent = true
    expect(gate(fence)).toBeNull()
    fence.onFocus()
    fence.onHumanInput()
    t = 2000
    expect(gate(fence)?.code).toBe("human_has_control")
    t = FENCE_INPUT_GRACE_MS + 1
    expect(gate(fence)).toBeNull()
    t = 0
    fence.onHumanInput()
    t = 1000
    fence.onBlur()
    t = 1000 + FENCE_BLUR_GRACE_MS - 1
    expect(fence.humanActive()).toBe(true)
    t = 1000 + FENCE_BLUR_GRACE_MS + 1
    expect(fence.humanActive()).toBe(false)
    fence.agentPriority = true
    expect(fence.holder()).toBe("agent")
  })

  it("[BRW-AC-1] input frames map 1:1 onto CDP Input calls", () => {
    expect(inputParams({ k: "down", x: 10, y: 20, b: "right", cc: 2, mods: 8 })).toEqual({
      method: "Input.dispatchMouseEvent",
      params: { type: "mousePressed", x: 10, y: 20, button: "right", clickCount: 2, modifiers: 8 },
    })
    expect(inputParams({ k: "move", x: 1, y: 2, b: "left" })).toMatchObject({
      params: { type: "mouseMoved", buttons: 1, clickCount: 0 },
    })
    expect(inputParams({ k: "wheel", x: 1, y: 2, dx: 0, dy: 99999 })).toMatchObject({
      params: { type: "mouseWheel", deltaY: 2000 },
    })
    expect(
      inputParams({ k: "key", type: "down", key: "a", code: "KeyA", kc: 65, text: "a" }),
    ).toMatchObject({ params: { type: "keyDown", text: "a", windowsVirtualKeyCode: 65 } })
    expect(inputParams({ k: "key", type: "down", key: "a", mods: 2 })).toMatchObject({
      params: { type: "rawKeyDown", modifiers: 2 },
    })
    expect(inputParams({ k: "text", text: "pasted" })).toEqual({
      method: "Input.insertText",
      params: { text: "pasted" },
    })
    expect(inputParams({ k: "what" })).toBeNull()
    expect(clampSize({ width: 9000, height: 600, dpr: 9 })).toEqual({
      width: 4096,
      height: 600,
      dpr: 3,
    })
    expect(normalizeUrl("teros.ai")).toBe("https://teros.ai")
  })

  it("suggestions: history ranks host-prefix first; URL-like input never asks the provider", async () => {
    let t = 0
    const log = new VisitLog(() => ++t)
    log.recordVisit("https://teros.ai/docs", "Teros docs")
    log.recordVisit("https://github.com/teros", "GitHub")
    expect(log.search("ter").map((r) => r.url)).toEqual([
      "https://teros.ai/docs",
      "https://github.com/teros",
    ])
    expect(isUrlLike("teros.ai")).toBe(true)
    expect(parseCompletions('["q",["q one","q"]]', "q")).toEqual(["q one"])
    const asked: string[] = []
    const svc = new SuggestService({
      fetchImpl: async (u) => {
        asked.push(u)
        return { ok: true, text: async () => '["x",["x y"]]' }
      },
    })
    expect((await svc.suggest("u", "x")).completions).toEqual(["x y"])
    expect((await svc.suggest("u", "teros.ai")).completions).toEqual([])
    expect(asked).toHaveLength(1)
  })
})

// ── Fakes ────────────────────────────────────────────────────────────────────

class FakeStream extends EventEmitter {
  states: Record<string, unknown>[] = []
  frames: Array<{ kind: number; bytes: number }> = []
  viewers: StreamViewer[] = []
  closedReason: string | null = null
  constructor(
    readonly id: string,
    readonly kind: string,
    readonly scope: { userId: string; workspaceId: string },
    public state: Record<string, unknown>,
  ) {
    super()
  }
  get closed() {
    return this.closedReason !== null
  }
  send(kind: number, payload: Uint8Array) {
    this.frames.push({ kind, bytes: payload.length })
    return true
  }
  setState(state: Record<string, unknown>) {
    this.state = state
    this.states.push(state)
  }
  close(reason = "closed") {
    this.closedReason = reason
    this.emit("closed", reason)
  }
  _viewers(list: StreamViewer[]) {
    this.viewers = list
    this.emit("viewers", list)
  }
  _input(viewerId: string, userId: string, input: Record<string, unknown>) {
    this.emit("input", viewerId, userId, input)
  }
}

function fakeStreams() {
  const opened: FakeStream[] = []
  const streams = {
    open: (o: {
      streamId: string
      kind: string
      scope: { userId: string; workspaceId: string }
      state?: Record<string, unknown>
    }) => {
      const s = new FakeStream(o.streamId, o.kind, o.scope, o.state ?? {})
      opened.push(s)
      return s as unknown as McaStream
    },
  } as unknown as McaStreams
  return { streams, opened }
}

function fakePage() {
  const em = new EventEmitter()
  const calls: Array<{ method: string; params?: unknown }> = []
  let url = "about:blank"
  let closed = false
  const cdp = {
    on: (ev: string, l: (...a: unknown[]) => void) => em.on(`cdp:${ev}`, l),
    send: async (method: string, params?: unknown) => {
      calls.push({ method, params })
      if (method === "Page.getNavigationHistory") return { currentIndex: 1, entries: [{}, {}, {}] }
      if (method === "Browser.getWindowForTarget") return { windowId: 7 }
      if (method === "Page.getLayoutMetrics")
        return { cssVisualViewport: { clientWidth: 800, clientHeight: 500 } }
      return {}
    },
    detach: async () => {},
    emit: (ev: string, params: unknown) => em.emit(`cdp:${ev}`, params),
  }
  const mainFrame = { url: () => url }
  const page = {
    on: (ev: string, l: (...a: unknown[]) => void) => em.on(`page:${ev}`, l),
    emit: (ev: string, ...a: unknown[]) => em.emit(`page:${ev}`, ...a),
    url: () => url,
    title: async () => "Title of " + url,
    mainFrame: () => mainFrame,
    goto: async (u: string) => {
      url = u
      calls.push({ method: "goto", params: u })
      em.emit("page:framenavigated", mainFrame)
    },
    goBack: async () => {
      calls.push({ method: "goBack" })
    },
    goForward: async () => {
      calls.push({ method: "goForward" })
    },
    reload: async () => {
      calls.push({ method: "reload" })
    },
    isClosed: () => closed,
    close: async () => {
      closed = true
    },
    context: () => ({ newCDPSession: async () => cdp }),
  }
  return {
    page,
    cdp,
    calls,
    setUrl: (u: string) => {
      url = u
    },
  }
}

function fakeChrome(pageFactory: () => ReturnType<typeof fakePage>) {
  const opened: string[] = []
  const closedFor: string[] = []
  const chrome = {
    contextFor: async (userId: string) => ({
      newPage: async () => {
        const p = pageFactory()
        ;(chrome as { last: unknown }).last = p
        return p.page
      },
      newCDPSession: async () => (chrome as { last: ReturnType<typeof fakePage> }).last.cdp,
    }),
    hideHeadless: async () => {},
    tabOpened: (u: string) => opened.push(u),
    tabClosed: (u: string) => closedFor.push(u),
    last: null as unknown,
  }
  return { chrome, opened, closedFor }
}

describe("VisibleTabs (BRW-REQ-2/3/4)", () => {
  it("[BRW-AC-2] ensure opens the stream with the tab state; navigation updates it; viewers start/stop the cast; consent only from the owner; close closes page + stream", async () => {
    const t = 0
    const { streams, opened } = fakeStreams()
    let fp: ReturnType<typeof fakePage> | null = null
    const { chrome, closedFor } = fakeChrome(() => {
      fp = fakePage()
      return fp
    })
    const tabs = new VisibleTabs({ streams, chrome: chrome as never, now: () => t })
    const scope = { userId: "u", workspaceId: "w" }
    const tab = await tabs.ensure(scope, "win1", "example.com", { width: 800, height: 500 })
    expect(opened[0].id).toBe(streamIdOf("win1"))
    expect(opened[0].kind).toBe("browser-tab")
    expect(opened[0].scope).toEqual(scope)
    expect(tab.state).toMatchObject({
      url: "https://example.com",
      loading: true,
      agentConsent: false,
      control: "none",
    })
    const page = fp!
    await new Promise((r) => setTimeout(r, 5))
    expect(page.calls.some((c) => c.method === "goto" && c.params === "https://example.com")).toBe(
      true,
    )
    expect(page.calls.some((c) => c.method === "Page.enable")).toBe(true)

    // The same id from another user is refused; the same user gets the same tab.
    await expect(tabs.ensure({ userId: "x", workspaceId: "w" }, "win1")).rejects.toThrow(
      /another user/,
    )
    expect(await tabs.ensure(scope, "win1")).toBe(tab)

    // A load → state with the title; the visit log learns it.
    page.setUrl("https://example.com/")
    page.page.emit("load")
    await new Promise((r) => setTimeout(r, 5))
    expect(tab.state).toMatchObject({
      url: "https://example.com/",
      title: "Title of https://example.com/",
      loading: false,
      canGoBack: true,
      canGoForward: true,
    })

    // A viewer attaches: cast at its device size; frames are forwarded; the empty list stops it.
    const stream = opened[0]
    stream._viewers([{ viewerId: "v1", userId: "u", meta: { width: 1000, height: 600, dpr: 2 } }])
    await new Promise((r) => setTimeout(r, 5))
    const start = page.calls.find((c) => c.method === "Page.startScreencast")
    expect(start?.params).toMatchObject({ format: "jpeg", maxWidth: 2000, maxHeight: 1200 })
    page.cdp.emit("Page.screencastFrame", {
      data: Buffer.from("abc").toString("base64"),
      sessionId: 3,
    })
    await new Promise((r) => setTimeout(r, 5))
    expect(stream.frames).toEqual([{ kind: 1, bytes: 3 }])
    expect(page.calls.some((c) => c.method === "Page.screencastFrameAck")).toBe(true)
    // The window follows the viewer's CSS size (debounced).
    await new Promise((r) => setTimeout(r, 300))
    expect(page.calls.find((c) => c.method === "Browser.setWindowBounds")?.params).toMatchObject({
      windowId: 7,
      bounds: { width: 1000, height: 600 },
    })

    // Person's input: focus + consent from the owner; another user's consent is ignored.
    stream._input("v1", "u", { k: "focus" })
    stream._input("v1", "x", { k: "consent", enabled: true })
    expect(tab.fence.consent).toBe(false)
    stream._input("v1", "u", { k: "consent", enabled: true })
    expect(tab.fence.consent).toBe(true)
    expect(tab.state.agentConsent).toBe(true)
    stream._input("v1", "u", { k: "down", x: 5, y: 6, b: "left", cc: 1 })
    await new Promise((r) => setTimeout(r, 5))
    expect(page.calls.find((c) => c.method === "Input.dispatchMouseEvent")?.params).toMatchObject({
      type: "mousePressed",
      x: 5,
      y: 6,
    })
    expect(tab.fence.humanActive()).toBe(true)
    stream._input("v1", "u", { k: "navigate", url: "teros.ai" })
    await new Promise((r) => setTimeout(r, 5))
    expect(page.calls.some((c) => c.method === "goto" && c.params === "https://teros.ai")).toBe(
      true,
    )
    stream._input("v1", "u", { k: "action", action: "back" })
    await new Promise((r) => setTimeout(r, 5))
    expect(page.calls.some((c) => c.method === "goBack")).toBe(true)

    stream._viewers([])
    await new Promise((r) => setTimeout(r, 5))
    expect(page.calls.some((c) => c.method === "Page.stopScreencast")).toBe(true)
    expect(tab.casting).toBe(false)

    expect(await tabs.close("win1", "bye")).toBe(true)
    expect(stream.closedReason).toBe("bye")
    expect(page.page.isClosed()).toBe(true)
    expect(closedFor).toEqual(["u"])
    expect(tabs.get("win1")).toBeUndefined()
  })

  it("[BRW-AC-3] gateCurrent refuses input tools on the selected visible tab without consent, and while the person types", () => {
    let t = 0
    const { streams } = fakeStreams()
    const { chrome } = fakeChrome(() => fakePage())
    const tabs = new VisibleTabs({ streams, chrome: chrome as never, now: () => t })
    const rt: VisibleRuntime = { tabs, suggest: new SuggestService(), current: null }
    expect(gateCurrent(rt)).toBeNull()
    expect(INPUT_TOOLS.has("browser-click")).toBe(true)
    expect(INPUT_TOOLS.has("browser-snapshot")).toBe(false)
    return tabs.ensure({ userId: "u", workspaceId: "w" }, "win2").then((tab) => {
      rt.current = tab
      expect(gateCurrent(rt)).toMatchObject({
        ok: false,
        code: "agent_control_disabled",
        tabId: "win2",
      })
      tab.fence.consent = true
      expect(gateCurrent(rt)).toBeNull()
      tab.fence.onFocus()
      tab.fence.onHumanInput()
      expect(gateCurrent(rt)).toMatchObject({ code: "human_has_control" })
      t = 10_000
      expect(gateCurrent(rt)).toBeNull()
    })
  })
})
