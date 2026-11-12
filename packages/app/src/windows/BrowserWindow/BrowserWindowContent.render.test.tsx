/**
 * BrowserWindowContent — render tests (web mode = a visible tab of the
 * Browser MCA over MCA streams, spec BRW-AC-4).
 *
 * On plain web the component finds the workspace's Browser app, asks it for
 * the tab + stream (`browser-view`), takes a `stream.ticket` and attaches to
 * the stream on its own WebSocket: frames paint a canvas, the person's input
 * goes back as `in` frames. No Browser app → "Browser is off"; no streams on
 * the server → the "desktop only" state. NEVER an iframe.
 *
 * The main-socket client is mocked (terosClientSingleton) and the data-plane
 * socket is a fake injected through the global WebSocket.
 *
 * The urlUtils unit tests at the bottom are kept from the Plan A era —
 * urlUtils is unchanged and both browsers use it.
 *
 *   cd packages/app && npx vitest run src/windows/BrowserWindow/BrowserWindowContent.render.test.tsx
 */

import { act, fireEvent, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "../../i18n"
import { useTilingStore } from "../../store/tilingStore"
import { renderWithTamagui } from "../../test/renderWithTamagui"

import {
  canonicalUrl,
  displayUrl,
  hostnameOf,
  normalizeUrlInput,
  resolveAddressInput,
  SEARCH_ENGINE,
} from "./urlUtils"

// ── Mocks ───────────────────────────────────────────────────────────────────

const hoisted = vi.hoisted(() => ({
  send: vi.fn<(to: string, action: string, data: unknown) => Promise<unknown>>(),
  listWorkspaceApps: vi.fn<(workspaceId: string) => Promise<unknown>>(),
  executeTool: vi.fn<(appId: string, tool: string, input: unknown) => Promise<unknown>>(),
  workspaceId: "ws_1",
}))
vi.mock("../../services/terosClientSingleton", () => ({
  getTerosClient: () => ({
    send: hoisted.send,
    getBackendBaseUrl: () => "http://backend.test",
    workspace: { listWorkspaceApps: hoisted.listWorkspaceApps },
    executeTool: hoisted.executeTool,
  }),
}))
vi.mock("../../store/workspaceStoreRef", () => ({
  getActiveWorkspaceId: () => hoisted.workspaceId,
}))

import { BrowserWindowContent } from "./BrowserWindowContent"

const WINDOW_ID = "win_browser_1"
/** The stream the Browser MCA answers for this window. */
const SID = `browser-tab:${WINDOW_ID}`
const BROWSER_APP = { appId: "a_browser", mcaId: "mca.teros.browser", name: "Browser" }

class FakeSocket {
  static instances: FakeSocket[] = []
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 3
  url: string
  binaryType = "blob"
  readyState = 0
  sent: Record<string, unknown>[] = []
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  constructor(url: string) {
    this.url = url
    FakeSocket.instances.push(this)
  }
  send(d: string) {
    this.sent.push(JSON.parse(d))
  }
  close() {
    this.readyState = 3
    this.onclose?.({})
  }
  open() {
    this.readyState = 1
    this.onopen?.({})
  }
  text(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) })
  }
}

function tabState(over: Record<string, unknown> = {}) {
  return {
    url: "https://github.com",
    title: "GitHub",
    loading: false,
    canGoBack: false,
    canGoForward: false,
    agentConsent: false,
    control: "none",
    ...over,
  }
}

function viewResult(input: unknown) {
  const i = input as { tabId: string; url?: string }
  return {
    success: true,
    result: {
      ok: true,
      streamId: `browser-tab:${i.tabId}`,
      tabId: i.tabId,
      state: tabState({ url: i.url ?? "", title: "" }),
    },
    mcaId: BROWSER_APP.mcaId,
  }
}

/** Plain web: no Electron bridge on window.terosDesktop. */
function ensurePlainWeb() {
  delete (window as any).terosDesktop
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  ensurePlainWeb()
  FakeSocket.instances = []
  vi.stubGlobal("WebSocket", FakeSocket)
  hoisted.send.mockReset()
  hoisted.listWorkspaceApps.mockReset()
  hoisted.executeTool.mockReset()
  useTilingStore.setState({ windows: {} } as any)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// ── Fallbacks ───────────────────────────────────────────────────────────────

describe("BrowserWindowContent (web, no Browser app / no streams)", () => {
  it('[BRW-AC-4] no Browser app in the workspace → the "Browser is off" state, no iframe', async () => {
    hoisted.listWorkspaceApps.mockResolvedValue({
      apps: [{ appId: "a_todo", mcaId: "mca.teros.todo-list", name: "Tasks" }],
    })
    const { getByTestId, queryByTestId, container } = renderWithTamagui(
      <BrowserWindowContent windowId={WINDOW_ID} url="https://example.com" />,
    )
    await waitFor(() => expect(getByTestId("bw-browser-off")).toBeTruthy())
    expect(queryByTestId("cbw-canvas")).toBeNull()
    expect(container.querySelector("iframe")).toBeNull()
    expect(hoisted.executeTool).not.toHaveBeenCalled()
  })

  it("[BRW-AC-4] a server without MCA streams → the desktop-only empty state, with no iframe ever", async () => {
    hoisted.listWorkspaceApps.mockResolvedValue({ apps: [BROWSER_APP] })
    hoisted.executeTool.mockImplementation(async (_a, _t, input) => viewResult(input))
    hoisted.send.mockRejectedValue(Object.assign(new Error("off"), { code: "STREAMS_UNAVAILABLE" }))
    const { getByTestId, queryByTestId, container } = renderWithTamagui(
      <BrowserWindowContent windowId={WINDOW_ID} url="https://example.com" />,
    )
    await waitFor(() => expect(getByTestId("bw-desktop-only")).toBeTruthy())
    expect(queryByTestId("cbw-canvas")).toBeNull()
    expect(container.querySelector("iframe")).toBeNull()
    expect(getByTestId("bw-desktop-only-cta")).toBeTruthy()
    expect(FakeSocket.instances).toHaveLength(0)
  })

  it("the desktop-only CTA opens the landing page in a new tab", async () => {
    hoisted.listWorkspaceApps.mockResolvedValue({ apps: [BROWSER_APP] })
    hoisted.executeTool.mockImplementation(async (_a, _t, input) => viewResult(input))
    hoisted.send.mockRejectedValue(Object.assign(new Error("off"), { code: "STREAMS_UNAVAILABLE" }))
    const openSpy = vi.fn()
    vi.stubGlobal("open", openSpy)
    const { getByTestId } = renderWithTamagui(
      <BrowserWindowContent windowId={WINDOW_ID} url="https://example.com" />,
    )
    await waitFor(() => expect(getByTestId("bw-desktop-only-cta")).toBeTruthy())
    fireEvent.click(getByTestId("bw-desktop-only-cta"))
    expect(openSpy).toHaveBeenCalledWith("https://teros.ai", "_blank", "noopener,noreferrer")
  })
})

// ── The visible tab ─────────────────────────────────────────────────────────

describe("BrowserWindowContent (web, a visible tab of the Browser MCA)", () => {
  beforeEach(() => {
    hoisted.listWorkspaceApps.mockResolvedValue({ apps: [BROWSER_APP] })
    hoisted.executeTool.mockImplementation(async (_appId, tool, input) => {
      if (tool === "browser-view") return viewResult(input)
      if (tool === "browser-suggest")
        return {
          success: true,
          result: { query: "", history: [], completions: [] },
          mcaId: BROWSER_APP.mcaId,
        }
      return { success: true, result: {}, mcaId: BROWSER_APP.mcaId }
    })
    hoisted.send.mockImplementation(async (to, action) => {
      if (to === "stream" && action === "ticket") return { ticket: "tkt", path: "/ws/stream" }
      return {}
    })
  })

  async function mountLive(url?: string) {
    const utils = renderWithTamagui(<BrowserWindowContent windowId={WINDOW_ID} url={url} />)
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1))
    const sock = FakeSocket.instances[0]
    act(() => sock.open())
    return { ...utils, sock }
  }

  it("[BRW-AC-4] asks the Browser app for the tab (browser-view with the window id + URL), takes a ticket and attaches to the stream", async () => {
    const { sock, getByTestId } = await mountLive("https://github.com")
    expect(hoisted.executeTool).toHaveBeenCalledWith(
      "a_browser",
      "browser-view",
      expect.objectContaining({ tabId: WINDOW_ID, url: "https://github.com" }),
    )
    expect(hoisted.send).toHaveBeenCalledWith("stream", "ticket", {})
    expect(sock.url).toBe("ws://backend.test/ws/stream?ticket=tkt")
    expect(sock.sent[0]).toMatchObject({ t: "attach", id: SID })
    expect(typeof (sock.sent[0].meta as { width: number }).width).toBe("number")
    act(() =>
      sock.text({ t: "attached", id: SID, kind: "browser-tab", state: tabState(), meta: {} }),
    )
    expect(getByTestId("nbw-url")).toBeTruthy()
    expect(getByTestId("nbw-back")).toBeTruthy()
    expect(getByTestId("cbw-canvas")).toBeTruthy()
    expect((getByTestId("nbw-url") as HTMLInputElement).value).toBe("github.com")
  })

  it("[BRW-AC-4] a state message updates the address field, the toolbar and the window props", async () => {
    useTilingStore.setState({
      windows: {
        [WINDOW_ID]: { id: WINDOW_ID, type: "browser", props: { url: "https://github.com" } },
      },
    } as any)
    const { sock, getByTestId, queryByTestId } = await mountLive("https://github.com")
    act(() =>
      sock.text({ t: "attached", id: SID, kind: "browser-tab", state: tabState(), meta: {} }),
    )
    act(() =>
      sock.text({
        t: "state",
        id: SID,
        state: tabState({
          url: "https://github.com/teros",
          title: "Teros · GitHub",
          canGoBack: true,
          loading: true,
        }),
      }),
    )
    expect((getByTestId("nbw-url") as HTMLInputElement).value).toBe("github.com/teros")
    expect(getByTestId("nbw-stop")).toBeTruthy()
    expect(queryByTestId("nbw-reload")).toBeNull()
    const win = useTilingStore.getState().windows[WINDOW_ID] as any
    expect(win.props).toMatchObject({ url: "https://github.com/teros", title: "Teros · GitHub" })
  })

  it("[BRW-AC-4] a mouse down on the canvas sends an `in` frame with CSS coordinates; keys, paste, focus and blur too", async () => {
    const { sock, getByTestId } = await mountLive("https://github.com")
    act(() =>
      sock.text({ t: "attached", id: SID, kind: "browser-tab", state: tabState(), meta: {} }),
    )
    const canvas = getByTestId("cbw-canvas") as HTMLCanvasElement
    // jsdom has no layout: the frame box reported 1280×800 (the default) and the
    // canvas is mocked at 640×400, so canvas px map ×2 to page CSS px.
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      left: 100,
      top: 50,
      width: 640,
      height: 400,
      right: 740,
      bottom: 450,
      x: 100,
      y: 50,
      toJSON: () => ({}),
    })
    sock.sent.length = 0
    fireEvent.mouseDown(canvas, { clientX: 150, clientY: 100, button: 0, detail: 1 })
    fireEvent.mouseUp(canvas, { clientX: 150, clientY: 100, button: 0, detail: 1 })
    // A mouse down focuses the canvas first (the fence learns the person is at the tab).
    expect(sock.sent[0]).toEqual({ t: "in", id: SID, k: "focus" })
    const inputs = () =>
      sock.sent.filter((m) => m.t === "in" && m.k !== "focus" && m.k !== "blur" && m.k !== "resize")
    expect(inputs()[0]).toEqual({
      t: "in",
      id: SID,
      k: "down",
      x: 100,
      y: 100,
      b: "left",
      cc: 1,
      mods: 0,
    })
    expect(inputs()[1]).toMatchObject({ k: "up", b: "left" })
    fireEvent.keyDown(canvas, { key: "a", code: "KeyA", keyCode: 65 })
    expect(inputs()[2]).toEqual({
      t: "in",
      id: SID,
      k: "key",
      type: "down",
      key: "a",
      code: "KeyA",
      kc: 65,
      mods: 0,
      text: "a",
    })
    fireEvent.keyDown(canvas, { key: "a", code: "KeyA", keyCode: 65, ctrlKey: true })
    expect(inputs()[3]).toMatchObject({ k: "key", mods: 2 })
    expect(inputs()[3].text).toBeUndefined()
    fireEvent.paste(canvas, { clipboardData: { getData: () => "pasted text" } })
    expect(inputs()[4]).toEqual({ t: "in", id: SID, k: "text", text: "pasted text" })
    fireEvent.blur(canvas)
    expect(sock.sent[sock.sent.length - 1]).toEqual({ t: "in", id: SID, k: "blur" })
  })

  it("[BRW-AC-4] Enter in the address field sends a navigate input with the resolved URL; the toggle sends consent; the suggest asks the Browser app", async () => {
    const { sock, getByTestId } = await mountLive("https://github.com")
    act(() =>
      sock.text({ t: "attached", id: SID, kind: "browser-tab", state: tabState(), meta: {} }),
    )
    sock.sent.length = 0
    const field = getByTestId("nbw-url") as HTMLInputElement
    fireEvent.focus(field)
    fireEvent.change(field, { target: { value: "teros.ai" } })
    await waitFor(() =>
      expect(hoisted.executeTool).toHaveBeenCalledWith("a_browser", "browser-suggest", {
        query: "teros.ai",
      }),
    )
    fireEvent.keyDown(field, { key: "Enter" })
    fireEvent.submit(field)
    await flush()
    expect(sock.sent.find((m) => m.k === "navigate")).toEqual({
      t: "in",
      id: SID,
      k: "navigate",
      url: "https://teros.ai",
    })
    fireEvent.click(getByTestId("nbw-consent"))
    expect(sock.sent.find((m) => m.k === "consent")).toEqual({
      t: "in",
      id: SID,
      k: "consent",
      enabled: true,
    })
  })

  it("[BRW-AC-4] without a URL it renders the new-tab page (same ids as the desktop one) and never an iframe", async () => {
    const { sock, getByTestId, container } = await mountLive(undefined)
    act(() =>
      sock.text({
        t: "attached",
        id: SID,
        kind: "browser-tab",
        state: tabState({ url: "about:blank", title: "" }),
        meta: {},
      }),
    )
    expect(getByTestId("nbw-empty")).toBeTruthy()
    expect(getByTestId("nbw-empty-input")).toBeTruthy()
    expect(getByTestId("nbw-bookmark-github")).toBeTruthy()
    expect(container.querySelector("iframe")).toBeNull()
  })

  it("unmount detaches (the MCA keeps the tab for its grace)", async () => {
    const { sock, unmount } = await mountLive("https://github.com")
    unmount()
    expect(sock.sent[sock.sent.length - 1]).toEqual({ t: "detach", id: SID })
    expect(sock.readyState).toBe(3)
  })
})

// ── URL normalization (unit — unchanged, shared with desktop mode) ──────────

describe("normalizeUrlInput", () => {
  it("prepends https:// to scheme-less domains", () => {
    expect(normalizeUrlInput("example.com")).toBe("https://example.com")
    expect(normalizeUrlInput("raw-os.teros.ai")).toBe("https://raw-os.teros.ai")
    expect(normalizeUrlInput("example.com:8080/path?q=1")).toBe("https://example.com:8080/path?q=1")
    expect(normalizeUrlInput("  example.com  ")).toBe("https://example.com")
  })

  it("keeps explicit schemes as-is", () => {
    expect(normalizeUrlInput("https://example.com")).toBe("https://example.com")
    expect(normalizeUrlInput("http://localhost:3000")).toBe("http://localhost:3000")
    expect(normalizeUrlInput("mailto:a@b.com")).toBe("mailto:a@b.com")
  })

  it("treats localhost as a host", () => {
    expect(normalizeUrlInput("localhost")).toBe("https://localhost")
    expect(normalizeUrlInput("localhost:3000/admin")).toBe("https://localhost:3000/admin")
  })

  it("rejects non-URL input with null (no search engine in Plan A)", () => {
    expect(normalizeUrlInput("hello world")).toBeNull()
    expect(normalizeUrlInput("justoneword")).toBeNull()
    expect(normalizeUrlInput("/some/path")).toBeNull()
    expect(normalizeUrlInput("")).toBeNull()
    expect(normalizeUrlInput("   ")).toBeNull()
  })

  it("does not mistake a port for a scheme", () => {
    // `example.com:8080` must NOT be parsed as scheme "example.com:"
    expect(normalizeUrlInput("example.com:8080")).toBe("https://example.com:8080")
  })
})

describe("resolveAddressInput (desktop address bar, DBAB)", () => {
  it("[DBAB-AC-1] free text searches on the default engine (Perplexity)", () => {
    expect(SEARCH_ENGINE.id).toBe("perplexity")
    expect(resolveAddressInput("hola mundo")).toEqual({
      kind: "search",
      url: "https://www.perplexity.ai/search?q=hola%20mundo",
      query: "hola mundo",
    })
    expect(resolveAddressInput("teros")).toMatchObject({ kind: "search", query: "teros" })
    expect(resolveAddressInput("  what is 3.14 ?  ")).toMatchObject({
      kind: "search",
      query: "what is 3.14 ?",
    })
  })

  it("[DBAB-AC-2] host-shaped input and explicit schemes are URLs; empty is nothing", () => {
    expect(resolveAddressInput("teros.ai")).toEqual({ kind: "url", url: "https://teros.ai" })
    expect(resolveAddressInput("http://localhost:3000")).toEqual({
      kind: "url",
      url: "http://localhost:3000",
    })
    expect(resolveAddressInput("about:blank")).toEqual({ kind: "url", url: "about:blank" })
    expect(resolveAddressInput("mailto:a@b.com")).toEqual({ kind: "url", url: "mailto:a@b.com" })
    expect(resolveAddressInput("192.168.1.1:8080")).toEqual({
      kind: "url",
      url: "https://192.168.1.1:8080",
    })
    expect(resolveAddressInput("localhost:3000/admin")).toEqual({
      kind: "url",
      url: "https://localhost:3000/admin",
    })
    expect(resolveAddressInput("")).toBeNull()
    expect(resolveAddressInput("   ")).toBeNull()
  })

  it("[DBAB-AC-4] displayUrl drops https:// and a lone trailing slash, keeps everything else", () => {
    expect(displayUrl("https://github.com/")).toBe("github.com")
    expect(displayUrl("https://github.com")).toBe("github.com")
    expect(displayUrl("https://github.com/teros-hq/")).toBe("github.com/teros-hq/")
    expect(displayUrl("http://localhost:3000/a?b=1")).toBe("http://localhost:3000/a?b=1")
    expect(displayUrl("https://www.perplexity.ai/search?q=hola%20mundo")).toBe(
      "www.perplexity.ai/search?q=hola%20mundo",
    )
    expect(displayUrl("about:blank")).toBe("about:blank")
    expect(displayUrl("")).toBe("")
  })
})

describe("hostnameOf / canonicalUrl", () => {
  it("extracts the hostname", () => {
    expect(hostnameOf("https://raw-os.teros.ai/x")).toBe("raw-os.teros.ai")
    expect(hostnameOf("not a url")).toBeNull()
    expect(hostnameOf(undefined)).toBeNull()
  })

  it("canonicalizes props urls but passes weird-but-real ones through", () => {
    expect(canonicalUrl("example.com")).toBe("https://example.com")
    expect(canonicalUrl("https://example.com")).toBe("https://example.com")
    // Unparseable-but-real URL: pass through, the embed hint handles failure.
    expect(canonicalUrl("myapp://screen/1")).toBe("myapp://screen/1")
    expect(canonicalUrl(undefined)).toBeUndefined()
  })
})
