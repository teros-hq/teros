/**
 * NativeBrowserContent — render tests (Teros Desktop F2, native mode).
 *
 * Covers: toolbar renders (URL bar + back/forward), create-on-mount and
 * destroy-on-unmount through the bridge, rect reporting on mount (visible
 * AND hidden — the display:none trap), visibility flips on tab switch,
 * state events updating the toolbar, navigate-from-props, and the
 * plain-web fallback (no bridge → renders nothing native).
 *
 * The bridge is faked on window.terosDesktop (that is the ONLY place the
 * product reads it — services/desktopBridge.ts). jsdom gives real
 * getBoundingClientRect (0×0 unless mocked) and a real ResizeObserver is
 * not available, so rect reporting is driven through the mount effect and
 * a mocked rect.
 *
 *   cd packages/app && npx vitest run src/windows/BrowserWindow/NativeBrowserContent.render.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, waitFor } from "@testing-library/react"
import "../../i18n"
import { TamaguiProvider } from "tamagui"
import config from "../../../tamagui.config"
import { renderWithTamagui } from "../../test/renderWithTamagui"
import { useTilingStore } from "../../store/tilingStore"
import { TabContext } from "../../components/workspace/TabContext"
import type { BrowserSuggestResponse, BrowserTabState } from "../../services/desktopBridge"
import { NativeBrowserContent } from "./NativeBrowserContent"
import { browserWindowDefinition } from "./definition"

const WINDOW_ID = "win_browser_1"

// ── Fake bridge ─────────────────────────────────────────────────────────────

type RectReport = { windowId: string; rect: any; visible: boolean; reason: string }

function makeState(over: Partial<BrowserTabState> = {}): BrowserTabState {
  return {
    windowId: WINDOW_ID,
    url: "https://github.com",
    title: "GitHub",
    canGoBack: false,
    canGoForward: false,
    loading: false,
    ...over,
  }
}

function makeBridge() {
  const calls = {
    create: [] as Array<{ windowId: string; url?: string }>,
    destroy: [] as string[],
    navigate: [] as { windowId: string; url: string }[],
    action: [] as { windowId: string; action: string }[],
    rects: [] as RectReport[],
    suggest: [] as string[],
    consent: [] as { windowId: string; enabled: boolean }[],
  }
  let stateCb: ((s: BrowserTabState) => void) | null = null
  let focusCb: ((windowId: string) => void) | null = null
  const bridge = {
    platform: "electron" as const,
    version: 1 as const,
    invokeBrowserCreate: vi.fn(async (windowId: string, url?: string) => {
      calls.create.push({ windowId, url })
      // The main process navigates and reports state. An empty initial url
      // (launcher path) would leave the component in the empty state —
      // tests that need the placeholder pass a real url.
      return makeState({ url: url && url.length > 0 ? url : "about:blank" })
    }),
    invokeBrowserNavigate: vi.fn(async (windowId: string, url: string) => {
      calls.navigate.push({ windowId, url })
      return { url }
    }),
    invokeBrowserAction: vi.fn(async (windowId: string, action: string) => {
      calls.action.push({ windowId, action })
      return { ok: true }
    }),
    invokeBrowserDestroy: vi.fn(async (windowId: string) => {
      calls.destroy.push(windowId)
      return { ok: true }
    }),
    invokeBrowserGetState: vi.fn(async () => makeState()),
    sendBrowserRect: vi.fn((windowId: string, rect: any, visible: boolean, reason: string) => {
      calls.rects.push({ windowId, rect, visible, reason })
    }),
    onBrowserState: vi.fn((cb: (s: BrowserTabState) => void) => {
      stateCb = cb
      return () => {
        stateCb = null
      }
    }),
    onBrowserFocusUrl: vi.fn((cb: (windowId: string) => void) => {
      focusCb = cb
      return () => {
        focusCb = null
      }
    }),
    // DBAB-REQ-13 — suggestions. Tests override `suggestResponse` / `suggestDelay`.
    suggestResponse: null as null | ((q: string) => BrowserSuggestResponse),
    suggestDelayMs: 0,
    invokeBrowserSuggest: vi.fn(async function (this: any, query: string) {
      calls.suggest.push(query)
      const make = bridge.suggestResponse
      const res = make ? make(query) : { query, history: [], completions: [] }
      if (bridge.suggestDelayMs > 0) await new Promise((r) => setTimeout(r, bridge.suggestDelayMs))
      return res
    }),
    // DBAC-REQ-2 — the consent toggle.
    invokeBrowserSetConsent: vi.fn(async (windowId: string, enabled: boolean) => {
      calls.consent.push({ windowId, enabled })
      return { agentConsent: enabled }
    }),
    /** Test helper: simulate a main-process state push. */
    __push: (s: BrowserTabState) => stateCb?.(s),
    /** Test helper: simulate the shell forwarding Cmd/Ctrl+L from inside the page. */
    __focusUrl: (windowId: string) => focusCb?.(windowId),
  }
  return { bridge, calls }
}

// ── Harness ─────────────────────────────────────────────────────────────────

function resetStores() {
  useTilingStore.setState({
    windows: {
      [WINDOW_ID]: {
        id: WINDOW_ID,
        type: "browser",
        props: {},
        containerId: "container_0",
        desktopIndex: 0,
        hasNotification: false,
        history: [],
        historyIndex: 0,
      },
    },
    activeDesktopIndex: 0,
  })
}

/** Mock the placeholder's rect so rect reporting has real numbers. */
function mockPlaceholderRect(x = 8, y = 40, width = 640, height = 480) {
  const rect = new DOMRect(x, y, width, height)
  const spy = vi
    .spyOn(Element.prototype, "getBoundingClientRect")
    .mockReturnValue(rect)
  return () => spy.mockRestore()
}

function renderNative(props: { url?: string; isTabActive?: boolean } = {}) {
  const { isTabActive = true } = props
  return renderWithTamagui(
    <TabContext.Provider value={{ tabBgColor: "#000", isContainerActive: true, isTabActive } as any}>
      <NativeBrowserContent windowId={WINDOW_ID} url={props.url} />
    </TabContext.Provider>,
  )
}

/** The toolbar's address field, once the create promise has resolved. */
async function urlInput(): Promise<HTMLInputElement> {
  return waitFor(() => {
    const input = document.querySelector('[data-testid="nbw-url"]') as HTMLInputElement
    expect(input).toBeTruthy()
    return input
  })
}

let restoreRect: (() => void) | null = null

beforeEach(() => {
  resetStores()
  restoreRect = mockPlaceholderRect()
})

afterEach(() => {
  restoreRect?.()
  restoreRect = null
  delete (window as any).terosDesktop
  vi.restoreAllMocks()
})

// ── Tests ───────────────────────────────────────────────────────────────────

describe("NativeBrowserContent (F2 native mode)", () => {
  it("renders nothing native without the bridge (plain web → definition picks Plan A)", () => {
    delete (window as any).terosDesktop
    const { queryByTestId } = renderNative({ url: "https://github.com" })
    expect(queryByTestId("nbw-placeholder")).toBeNull()
  })

  it("creates the native tab on mount and destroys it on unmount", async () => {
    const { bridge, calls } = makeBridge()
    ;(window as any).terosDesktop = bridge
    const { unmount } = renderNative({ url: "https://github.com" })

    await waitFor(() => expect(calls.create).toHaveLength(1))
    expect(calls.create[0]).toEqual({ windowId: WINDOW_ID, url: "https://github.com" })

    unmount()
    await waitFor(() => expect(calls.destroy).toEqual([WINDOW_ID]))
  })

  it("reports the placeholder rect with visible:true on mount", async () => {
    const { bridge, calls } = makeBridge()
    ;(window as any).terosDesktop = bridge
    renderNative({ url: "https://github.com" })

    await waitFor(() => expect(calls.rects.length).toBeGreaterThan(0))
    const mount = calls.rects.find((r) => r.reason === "mount")
    expect(mount).toBeDefined()
    expect(mount!.visible).toBe(true)
    expect(mount!.rect).toEqual({ x: 8, y: 40, width: 640, height: 480 })
  })

  it("reports visible:false even with a 0×0 rect (display:none trap)", async () => {
    restoreRect?.()
    // The trap: INACTIVE tabs are display:none → getBoundingClientRect is
    // 0×0. The visible:false report MUST still travel or the native view
    // never detaches. (An ACTIVE tab with a 0×0 rect is the opposite case:
    // a visible rect too small to pin — correctly skipped, no report.)
    restoreRect = mockPlaceholderRect(0, 0, 0, 0)
    const { bridge, calls } = makeBridge()
    ;(window as any).terosDesktop = bridge
    renderNative({ url: "https://github.com", isTabActive: false })

    await waitFor(() => {
      expect(calls.rects.some((r) => !r.visible)).toBe(true)
    })
    const hidden = calls.rects.find((r) => !r.visible)!
    // The rect itself is degenerate (0×0) — visibility is what matters.
    expect(hidden.rect).toEqual({ x: 0, y: 0, width: 0, height: 0 })
  })

  it("flips visibility when the tab becomes inactive", async () => {
    const { bridge, calls } = makeBridge()
    ;(window as any).terosDesktop = bridge
    const { rerender } = renderNative({ url: "https://github.com" })

    await waitFor(() => expect(calls.rects.some((r) => r.visible)).toBe(true))

    // Re-render with the tab inactive → a visibility report with visible:false.
    // rerender replaces the WHOLE tree — re-wrap TamaguiProvider or useThemeName throws.
    rerender(
      <TamaguiProvider config={config} defaultTheme="dark">
        <TabContext.Provider value={{ tabBgColor: "#000", isContainerActive: true, isTabActive: false } as any}>
          <NativeBrowserContent windowId={WINDOW_ID} url="https://github.com" />
        </TabContext.Provider>
      </TamaguiProvider>,
    )
    await waitFor(() => {
      const hidden = calls.rects.find((r) => r.reason === "visibility" && !r.visible)
      expect(hidden).toBeDefined()
    })
  })

  it("flips visibility when the desktop changes", async () => {
    const { bridge, calls } = makeBridge()
    ;(window as any).terosDesktop = bridge
    const { rerender } = renderNative({ url: "https://github.com" })

    await waitFor(() => expect(calls.rects.some((r) => r.visible)).toBe(true))

    act(() => {
      useTilingStore.setState({ activeDesktopIndex: 2 })
    })
    rerender(
      <TamaguiProvider config={config} defaultTheme="dark">
        <TabContext.Provider value={{ tabBgColor: "#000", isContainerActive: true, isTabActive: true } as any}>
          <NativeBrowserContent windowId={WINDOW_ID} url="https://github.com" />
        </TabContext.Provider>
      </TamaguiProvider>,
    )
    await waitFor(() => {
      const hidden = calls.rects.find((r) => r.reason === "visibility" && !r.visible)
      expect(hidden).toBeDefined()
    })
  })

  it("hides the native view while a modal overlay is open and re-pins it when the modal closes (F2 §4 Overlay rule)", async () => {
    const { bridge, calls } = makeBridge()
    ;(window as any).terosDesktop = bridge
    renderNative({ url: "https://github.com" })
    await waitFor(() => expect(calls.rects.some((r) => r.visible)).toBe(true))

    // A modal opens anywhere in the SPA — the permission sheet is an RNW
    // <Modal>, whose content carries aria-modal="true" in a body portal.
    const before = calls.rects.length
    const portal = document.createElement("div")
    const sheet = document.createElement("div")
    sheet.setAttribute("aria-modal", "true")
    sheet.setAttribute("role", "dialog")
    portal.appendChild(sheet)
    await act(async () => {
      document.body.appendChild(portal)
    })
    await waitFor(() => {
      const hidden = calls.rects.slice(before).find((r) => r.reason === "visibility" && !r.visible)
      expect(hidden).toBeDefined()
    })

    // The modal closes — the view is pinned again at the placeholder's rect.
    const after = calls.rects.length
    await act(async () => {
      portal.remove()
    })
    await waitFor(() => {
      const shown = calls.rects.slice(after).find((r) => r.reason === "visibility" && r.visible)
      expect(shown).toBeDefined()
      expect(shown!.rect).toEqual({ x: 8, y: 40, width: 640, height: 480 })
    })
  })

  it("toolbar: state push updates the URL bar and mirrors url into window props", async () => {
    const { bridge } = makeBridge()
    ;(window as any).terosDesktop = bridge
    renderNative({ url: "https://github.com" })

    await waitFor(() => expect(bridge.onBrowserState).toHaveBeenCalled())

    act(() => {
      bridge.__push(makeState({ url: "https://teros.ai/en", title: "Teros", canGoBack: true }))
    })
    await waitFor(() => {
      const input = document.querySelector('[data-testid="nbw-url"]') as HTMLInputElement
      expect(input.value).toContain("teros.ai")
    })
    // Mirror into window props (persistence / dedupe / ui-state keep working).
    expect(useTilingStore.getState().windows[WINDOW_ID].props.url).toBe("https://teros.ai/en")
  })

  it("toolbar: Enter in the URL bar navigates the native view", async () => {
    const { bridge, calls } = makeBridge()
    ;(window as any).terosDesktop = bridge
    renderNative({ url: "https://github.com" })

    const input = await urlInput()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "teros.ai" } })
    fireEvent.keyDown(input, { key: "Enter", shiftKey: false })

    await waitFor(() => expect(calls.navigate.length).toBeGreaterThan(0))
    expect(calls.navigate[calls.navigate.length - 1].url).toBe("https://teros.ai")
    // Persisted into the window props too (dedupe / restore).
    expect(useTilingStore.getState().windows[WINDOW_ID].props.url).toBe("https://teros.ai")
  })

  it("[DBAB-AC-1] toolbar: free text in the URL bar searches on Perplexity", async () => {
    const { bridge, calls } = makeBridge()
    ;(window as any).terosDesktop = bridge
    renderNative({ url: "https://github.com" })

    const input = await urlInput()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "hola mundo" } })
    fireEvent.keyDown(input, { key: "Enter", shiftKey: false })

    await waitFor(() => expect(calls.navigate.length).toBeGreaterThan(0))
    expect(calls.navigate[calls.navigate.length - 1].url).toBe(
      "https://www.perplexity.ai/search?q=hola%20mundo",
    )
    // Shown right away (optimistic, DBAB-REQ-6) — the shell's push confirms later.
    await waitFor(() => expect(input.value).toBe("www.perplexity.ai/search?q=hola%20mundo"))
  })

  it("[DBAB-AC-3] focusing the URL bar shows the full URL and selects it all", async () => {
    const { bridge } = makeBridge()
    ;(window as any).terosDesktop = bridge
    renderNative({ url: "https://github.com" })

    const input = await urlInput()
    // Display form while not focused (DBAB-REQ-4).
    expect(input.value).toBe("github.com")
    const select = vi.spyOn(HTMLInputElement.prototype, "select")
    fireEvent.focus(input)
    await waitFor(() => expect(input.value).toBe("https://github.com"))
    expect(select).toHaveBeenCalled()
  })

  it("[DBAB-AC-4] unfocused, the URL bar shows the live URL in display form", async () => {
    const { bridge } = makeBridge()
    ;(window as any).terosDesktop = bridge
    renderNative({ url: "https://github.com" })

    const input = await urlInput()
    act(() => {
      bridge.__push(makeState({ url: "https://github.com/" }))
    })
    await waitFor(() => expect(input.value).toBe("github.com"))
    act(() => {
      bridge.__push(makeState({ url: "http://localhost:3000/a?b=1" }))
    })
    await waitFor(() => expect(input.value).toBe("http://localhost:3000/a?b=1"))
  })

  it("[DBAB-AC-5] a state push never clobbers a draft; Escape restores the live URL", async () => {
    const { bridge } = makeBridge()
    ;(window as any).terosDesktop = bridge
    renderNative({ url: "https://github.com" })

    const input = await urlInput()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "foo" } })
    expect(input.value).toBe("foo")

    act(() => {
      bridge.__push(makeState({ url: "https://teros.ai/en", title: "Teros" }))
    })
    // Still the draft.
    expect(input.value).toBe("foo")

    fireEvent.keyDown(input, { key: "Escape" })
    await waitFor(() => expect(document.activeElement).not.toBe(input))
    await waitFor(() => expect(input.value).toBe("teros.ai/en"))
  })

  it("[DBAB-AC-6] the shell's focus-url push focuses this window's field only", async () => {
    const { bridge } = makeBridge()
    ;(window as any).terosDesktop = bridge
    renderNative({ url: "https://github.com" })

    const input = await urlInput()
    await waitFor(() => expect(bridge.onBrowserFocusUrl).toHaveBeenCalled())
    expect(document.activeElement).not.toBe(input)

    act(() => {
      bridge.__focusUrl("win_other")
    })
    expect(document.activeElement).not.toBe(input)

    act(() => {
      bridge.__focusUrl(WINDOW_ID)
    })
    await waitFor(() => expect(document.activeElement).toBe(input))
  })

  it("[DBAB-AC-7] Cmd/Ctrl+L on the document focuses the field of the active window", async () => {
    const { bridge } = makeBridge()
    ;(window as any).terosDesktop = bridge
    renderNative({ url: "https://github.com" })

    const input = await urlInput()
    expect(document.activeElement).not.toBe(input)
    fireEvent.keyDown(document, { key: "l", metaKey: true })
    await waitFor(() => expect(document.activeElement).toBe(input))
  })

  it("[DBAB-AC-8] the page title is mirrored into the window props and names the tab", async () => {
    const { bridge } = makeBridge()
    ;(window as any).terosDesktop = bridge
    renderNative({ url: "https://github.com" })

    await waitFor(() => expect(bridge.onBrowserState).toHaveBeenCalled())
    act(() => {
      bridge.__push(makeState({ url: "https://github.com/teros-hq", title: "teros-hq · GitHub" }))
    })
    await waitFor(() => {
      expect(useTilingStore.getState().windows[WINDOW_ID].props.title).toBe("teros-hq · GitHub")
    })
    const props = useTilingStore.getState().windows[WINDOW_ID].props
    expect(browserWindowDefinition.getTitle(props)).toBe("teros-hq · GitHub")
    expect(browserWindowDefinition.getTitle({ url: "https://github.com/teros-hq" })).toBe("github.com")
  })

  it("toolbar: back button fires the back action", async () => {
    const { bridge, calls } = makeBridge()
    ;(window as any).terosDesktop = bridge
    renderNative({ url: "https://github.com" })

    // Wait for the create promise to resolve FIRST: its .then would
    // otherwise land AFTER the push below and overwrite the pushed state
    // with the default canGoBack:false (test/promise race, not a product
    // issue — the URL bar showing the create url proves create.then ran).
    await waitFor(() => {
      const input = document.querySelector('[data-testid="nbw-url"]') as HTMLInputElement
      expect(input?.value).toBe("github.com")
    })

    // A state push with canGoBack enables the button — wait for it to be
    // ENABLED before clicking (aria-disabled flips false).
    act(() => {
      bridge.__push(makeState({ canGoBack: true }))
    })
    // RNW omits aria-disabled entirely when the control is ENABLED (it only
    // renders the attribute when true) — so "not true" is the enabled check.
    const btn = await waitFor(() => {
      const el = document.querySelector('[data-testid="nbw-back"]') as HTMLElement
      expect(el).toBeTruthy()
      expect(el.getAttribute("aria-disabled")).not.toBe("true")
      return el
    })
    fireEvent.click(btn)
    await waitFor(() => expect(calls.action).toContainEqual({ windowId: WINDOW_ID, action: "back" }))
  })

  // ── Suggestions (DBAB-REQ-11..13) ────────────────────────────────────────

  const TER_RESPONSE = (query: string): BrowserSuggestResponse => ({
    query,
    history: [{ url: "https://teros.ai", title: "Teros", visits: 3, lastVisitAt: 1 }],
    completions: ["teros", "terminal"],
  })

  async function suggestionRows(): Promise<HTMLElement[]> {
    return waitFor(() => {
      const rows = Array.from(document.querySelectorAll('[data-testid^="nbw-suggestions-"]')) as HTMLElement[]
      expect(rows.length).toBeGreaterThan(1)
      return rows
    })
  }

  it("[DBAB-AC-10] typing asks the shell and lists: row 1 search, history, completions", async () => {
    const { bridge, calls } = makeBridge()
    bridge.suggestResponse = TER_RESPONSE
    ;(window as any).terosDesktop = bridge
    renderNative({ url: "https://github.com" })

    const input = await urlInput()
    fireEvent.focus(input)
    // The selected live URL is not a draft yet — no list before typing.
    expect(document.querySelector('[data-testid="nbw-suggestions"]')).toBeNull()
    fireEvent.change(input, { target: { value: "ter" } })

    const rows = await suggestionRows()
    await waitFor(() => expect(calls.suggest).toContain("ter"))
    expect(rows).toHaveLength(4)
    expect(rows[0].textContent).toContain("ter")
    expect(rows[0].textContent).toContain("Search Perplexity")
    expect(rows[1].textContent).toContain("Teros")
    expect(rows[1].textContent).toContain("teros.ai")
    expect(rows[2].textContent).toContain("teros")
    expect(rows[3].textContent).toContain("terminal")
    // The native page is re-pinned below the list: the placeholder is still there.
    expect(document.querySelector('[data-testid="nbw-placeholder"]')).toBeTruthy()
  })

  it("[DBAB-AC-11] a URL-shaped draft reads 'Go to …' in row 1", async () => {
    const { bridge } = makeBridge()
    ;(window as any).terosDesktop = bridge
    renderNative({ url: "https://github.com" })

    const input = await urlInput()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "teros.ai" } })
    const row = await waitFor(() => {
      const el = document.querySelector('[data-testid="nbw-suggestions-0"]') as HTMLElement
      expect(el).toBeTruthy()
      return el
    })
    expect(row.textContent).toContain("Go to teros.ai")
  })

  it("[DBAB-AC-12] ArrowDown + Enter opens the highlighted history row; three downs search the completion", async () => {
    const { bridge, calls } = makeBridge()
    bridge.suggestResponse = TER_RESPONSE
    ;(window as any).terosDesktop = bridge
    renderNative({ url: "https://github.com" })

    const input = await urlInput()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "ter" } })
    await suggestionRows()

    fireEvent.keyDown(input, { key: "ArrowDown" })
    await waitFor(() => {
      expect(document.querySelector('[data-testid="nbw-suggestions-1"]')?.getAttribute("data-highlighted")).toBe("true")
    })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(calls.navigate.at(-1)?.url).toBe("https://teros.ai"))
    // The list is gone once a row is picked.
    await waitFor(() => expect(document.querySelector('[data-testid="nbw-suggestions"]')).toBeNull())

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "ter" } })
    await suggestionRows()
    fireEvent.keyDown(input, { key: "ArrowDown" })
    fireEvent.keyDown(input, { key: "ArrowDown" })
    fireEvent.keyDown(input, { key: "ArrowDown" })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() =>
      expect(calls.navigate.at(-1)?.url).toBe("https://www.perplexity.ai/search?q=terminal"),
    )
  })

  it("[DBAB-AC-12] clicking a row opens it", async () => {
    const { bridge, calls } = makeBridge()
    bridge.suggestResponse = TER_RESPONSE
    ;(window as any).terosDesktop = bridge
    renderNative({ url: "https://github.com" })

    const input = await urlInput()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "ter" } })
    const rows = await suggestionRows()
    fireEvent.click(rows[1])
    await waitFor(() => expect(calls.navigate.at(-1)?.url).toBe("https://teros.ai"))
  })

  it("[DBAB-AC-13] a late answer for an older draft is discarded; Escape hides the list", async () => {
    const { bridge } = makeBridge()
    let resolveTe: ((r: BrowserSuggestResponse) => void) | null = null
    bridge.invokeBrowserSuggest = vi.fn((query: string) => {
      if (query === "te") return new Promise<BrowserSuggestResponse>((r) => (resolveTe = r))
      return Promise.resolve(TER_RESPONSE(query))
    }) as any
    ;(window as any).terosDesktop = bridge
    renderNative({ url: "https://github.com" })

    const input = await urlInput()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "te" } })
    await waitFor(() => expect(bridge.invokeBrowserSuggest).toHaveBeenCalledWith("te"))
    fireEvent.change(input, { target: { value: "ter" } })
    await suggestionRows()
    // The stale "te" answer arrives now — with rows that must never show.
    act(() => {
      resolveTe?.({ query: "te", history: [{ url: "https://tesla.com", title: "Tesla", visits: 1, lastVisitAt: 1 }], completions: ["tea"] })
    })
    await new Promise((r) => setTimeout(r, 30))
    const texts = Array.from(document.querySelectorAll('[data-testid^="nbw-suggestions-"]')).map((e) => e.textContent)
    expect(texts.join(" ")).not.toContain("Tesla")
    expect(texts.join(" ")).not.toContain("tea")

    fireEvent.keyDown(input, { key: "Escape" })
    await waitFor(() => expect(document.querySelector('[data-testid="nbw-suggestions"]')).toBeNull())
  })

  it("[DBAB-REQ-14] the new-tab page shows suggestions under its field (about:blank is 'no page yet')", async () => {
    const { bridge, calls } = makeBridge()
    bridge.suggestResponse = TER_RESPONSE
    ;(window as any).terosDesktop = bridge
    renderNative({})
    // The shell primes the tab with about:blank and reports it — the new-tab page must stay.
    await waitFor(() => expect(calls.create).toHaveLength(1))
    act(() => {
      bridge.__push(makeState({ url: "about:blank", title: "" }))
    })
    expect(document.querySelector('[data-testid="nbw-url"]')).toBeNull()

    const input = await waitFor(() => {
      const el = document.querySelector('[data-testid="nbw-empty-input"]') as HTMLInputElement
      expect(el).toBeTruthy()
      return el
    })
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "ter" } })
    const rows = await suggestionRows()
    expect(rows).toHaveLength(4)
    fireEvent.click(rows[1])
    await waitFor(() => expect(calls.navigate.at(-1)?.url).toBe("https://teros.ai"))
  })

  it("[DBAB-REQ-14] back to the blank start hides the native view (visible:false) so the start page is usable", async () => {
    const { bridge, calls } = makeBridge()
    ;(window as any).terosDesktop = bridge
    renderNative({ url: "https://github.com" })
    await urlInput()
    await waitFor(() => expect(calls.rects.some((r) => r.visible)).toBe(true))
    const before = calls.rects.length

    // History Back landed on the blank start: the shell reports no URL.
    act(() => {
      bridge.__push(makeState({ url: "", title: "", canGoBack: false }))
    })
    const input = await waitFor(() => {
      const el = document.querySelector('[data-testid="nbw-empty-input"]') as HTMLInputElement
      expect(el).toBeTruthy()
      return el
    })
    const hidden = calls.rects.slice(before).find((r) => !r.visible)
    expect(hidden).toBeDefined()
    // …and the field takes input.
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "teros.ai" } })
    expect(input.value).toBe("teros.ai")
  })

  // ── Agent-control toggle (DBAC-REQ-13) ───────────────────────────────────

  it("[DBAC-AC-8] the consent toggle follows the push and flips through the bridge", async () => {
    const { bridge, calls } = makeBridge()
    ;(window as any).terosDesktop = bridge
    renderNative({ url: "https://github.com" })
    await urlInput()

    // No agentConsent in the state → no toggle (older shell).
    expect(document.querySelector('[data-testid="nbw-consent"]')).toBeNull()

    act(() => {
      bridge.__push(makeState({ agentConsent: false }))
    })
    const toggle = await waitFor(() => {
      const el = document.querySelector('[data-testid="nbw-consent"]') as HTMLElement
      expect(el).toBeTruthy()
      return el
    })
    expect(toggle.getAttribute("aria-label")).toBe("Agent control off")

    fireEvent.click(toggle)
    await waitFor(() => expect(calls.consent).toEqual([{ windowId: WINDOW_ID, enabled: true }]))
    await waitFor(() => expect(toggle.getAttribute("aria-label")).toBe("Agent control on"))

    act(() => {
      bridge.__push(makeState({ agentConsent: false }))
    })
    await waitFor(() => expect(toggle.getAttribute("aria-label")).toBe("Agent control off"))
  })

  it("navigates from window props (history back/forward, agent commands)", async () => {
    const { bridge, calls } = makeBridge()
    ;(window as any).terosDesktop = bridge
    const { rerender } = renderNative({ url: "https://github.com" })

    await waitFor(() => expect(calls.create).toHaveLength(1))

    rerender(
      <TamaguiProvider config={config} defaultTheme="dark">
        <TabContext.Provider value={{ tabBgColor: "#000", isContainerActive: true, isTabActive: true } as any}>
          <NativeBrowserContent windowId={WINDOW_ID} url="https://example.com" />
        </TabContext.Provider>
      </TamaguiProvider>,
    )
    await waitFor(() => {
      expect(calls.navigate.some((n) => n.url === "https://example.com")).toBe(true)
    })
  })
})
