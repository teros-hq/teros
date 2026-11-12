/**
 * FileViewerWindowContent — "Pantalla completa" hybrid behaviour (override
 * of OQ3 by Pablo, 2026-10-17 — see ux.md changelog v1.3.0).
 *
 * Iteration 1 wired the tiling path to the in-app FVU overlay. Pablo's live
 * feedback: the overlay doesn't use the full width (maxWidth 900) and its
 * height was broken (body without `fill` falls back to 400px). Decision:
 * the viewer window goes SYSTEM fullscreen (`requestFullscreen` on the
 * window's root container); the chat bubble keeps the overlay, pending
 * Pablo's call.
 *
 * The button is host-aware:
 *   - floating host (windowId exists in workspaceStore.windows) → maximize/
 *     restore this very window (previous behaviour, preserved).
 *   - tiling host (windowId NOT in the floating store) → system fullscreen
 *     with `requestFullscreen` + `webkitRequestFullscreen` fallback; ESC is
 *     handled natively by the browser; `fullscreenchange` keeps the button
 *     state in sync.
 *
 * These tests cover both paths plus the fullscreenchange sync and the
 * toggle-off path (click with fullscreen active → exitFullscreen).
 *
 *   cd packages/app && npx vitest run src/windows/FileViewerWindow/FileViewerWindowContent.render.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, waitFor } from "@testing-library/react"
import "../../i18n"
import { renderWithTamagui } from "../../test/renderWithTamagui"
import { useWorkspaceStore } from "../../store/workspaceStore"

// ── Mock the Teros client: fileWatcher watch/unwatch are no-ops, no WS. ─────
const clientMock = vi.hoisted(() => ({
  isConnected: () => false,
  on: vi.fn(),
  off: vi.fn(),
  getSessionToken: () => "test-token",
  fileWatcher: {
    watch: vi.fn(() => Promise.resolve({ content: "<h1>hi</h1>" })),
    unwatch: vi.fn(() => Promise.resolve()),
  },
  fileShare: {
    getShare: vi.fn(() => Promise.resolve(null)),
    createShare: vi.fn(() => Promise.resolve({ url: "https://x/share" })),
    deleteShare: vi.fn(() => Promise.resolve()),
  },
}))
vi.mock("../../services/terosClientSingleton", () => ({
  getTerosClient: () => clientMock,
}))

import { FileViewerWindowContent } from "./FileViewerWindowContent"

const FLOATING_ID = "win_floating_1"
const TILING_ID = "win_tiling_1"

function resetStores() {
  useWorkspaceStore.setState({
    windows: {},
    activeFloatingWindowId: null,
  })
}

function seedFloatingWindow(windowId: string) {
  useWorkspaceStore.setState({
    windows: {
      [windowId]: {
        id: windowId,
        type: "file-viewer",
        props: {},
        x: 0,
        y: 0,
        width: 800,
        height: 600,
        zIndex: 1,
        isMinimized: false,
        isMaximized: false,
        isDocked: false,
        hasNotification: false,
      },
    },
    activeFloatingWindowId: null,
  })
}

/** Stub the Fullscreen API on jsdom (it doesn't implement it). Returns the
 * spies so tests can assert. `requestFullscreen` sets
 * `document.fullscreenElement` and fires `fullscreenchange` on the document,
 * mimicking the browser. */
function stubFullscreenApi() {
  let currentElement: Element | null = null
  const requestFullscreen = vi.fn(function (this: Element) {
    currentElement = this
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => currentElement,
    })
    document.dispatchEvent(new Event("fullscreenchange"))
    return Promise.resolve()
  })
  const exitFullscreen = vi.fn(() => {
    currentElement = null
    document.dispatchEvent(new Event("fullscreenchange"))
    return Promise.resolve()
  })
  Object.defineProperty(document, "fullscreenElement", {
    configurable: true,
    get: () => currentElement,
  })
  ;(Element.prototype as any).requestFullscreen = requestFullscreen
  ;(document as any).exitFullscreen = exitFullscreen
  return { requestFullscreen, exitFullscreen }
}

describe("FileViewerWindowContent — Pantalla completa (hybrid by host)", () => {
  beforeEach(() => {
    resetStores()
    // jsdom lacks createObjectURL; stub it so binary kinds don't crash.
    if (!(URL as any).createObjectURL) {
      ;(URL as any).createObjectURL = vi.fn(() => "blob:mock")
      ;(URL as any).revokeObjectURL = vi.fn()
    }
  })
  afterEach(() => {
    vi.restoreAllMocks()
    resetStores()
    // Clean up the fullscreen stubs so other suites aren't affected.
    delete (Element.prototype as any).requestFullscreen
    delete (document as any).exitFullscreen
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => null,
    })
  })

  it("tiling host: click on -fullscreen calls requestFullscreen on the root, NOT maximizeWindow, and mounts NO overlay", async () => {
    const { requestFullscreen } = stubFullscreenApi()
    const maximizeSpy = vi.spyOn(useWorkspaceStore.getState(), "maximizeWindow")
    const { getByTestId, queryByTestId } = renderWithTamagui(
      <FileViewerWindowContent
        windowId={TILING_ID}
        filePath="/workspace/mockup.html"
        channelId="ch_1"
        workspaceId="ws_1"
      />,
    )

    fireEvent.click(getByTestId("fvw-actions-fullscreen"))

    await waitFor(() => {
      expect(requestFullscreen).toHaveBeenCalled()
    })
    expect(maximizeSpy).not.toHaveBeenCalled()
    // No in-app overlay in the tiling path anymore (Pablo's override).
    expect(queryByTestId("fvw-overlay")).toBeNull()
    expect(document.body.querySelector('[data-testid="fvw-overlay"]')).toBeNull()
  })

  it("floating host: click on -fullscreen calls maximizeWindow (previous behaviour preserved)", async () => {
    const { requestFullscreen } = stubFullscreenApi()
    seedFloatingWindow(FLOATING_ID)
    const maximizeSpy = vi.spyOn(useWorkspaceStore.getState(), "maximizeWindow")
    const { getByTestId } = renderWithTamagui(
      <FileViewerWindowContent
        windowId={FLOATING_ID}
        filePath="/workspace/mockup.html"
        channelId="ch_1"
        workspaceId="ws_1"
      />,
    )

    fireEvent.click(getByTestId("fvw-actions-fullscreen"))

    await waitFor(() => {
      expect(maximizeSpy).toHaveBeenCalledWith(FLOATING_ID)
    })
    // And the store reflects the maximize.
    expect(useWorkspaceStore.getState().windows[FLOATING_ID]?.isMaximized).toBe(true)
    // System fullscreen is NOT used in the floating path.
    expect(requestFullscreen).not.toHaveBeenCalled()
  })

  it("tiling host: fullscreenchange syncs the button state (ESC-equivalent path)", async () => {
    const { requestFullscreen, exitFullscreen } = stubFullscreenApi()
    const { getByTestId } = renderWithTamagui(
      <FileViewerWindowContent
        windowId={TILING_ID}
        filePath="/workspace/mockup.html"
        channelId="ch_1"
        workspaceId="ws_1"
      />,
    )

    // Enter fullscreen.
    fireEvent.click(getByTestId("fvw-actions-fullscreen"))
    await waitFor(() => {
      expect(requestFullscreen).toHaveBeenCalled()
    })
    expect(document.fullscreenElement).not.toBeNull()

    // Simulate the browser's native ESC: fullscreenElement goes null and
    // the document fires fullscreenchange. The component's listener must
    // pick it up (state sync).
    exitFullscreen()
    await waitFor(() => {
      expect(document.fullscreenElement).toBeNull()
    })
    // If the listener is wired, a second click re-enters fullscreen (toggle
    // state was reset by the fullscreenchange handler).
    fireEvent.click(getByTestId("fvw-actions-fullscreen"))
    await waitFor(() => {
      expect(requestFullscreen).toHaveBeenCalledTimes(2)
    })
  })

  it("tiling host: click with fullscreen active calls exitFullscreen (toggle off)", async () => {
    const { requestFullscreen, exitFullscreen } = stubFullscreenApi()
    const { getByTestId } = renderWithTamagui(
      <FileViewerWindowContent
        windowId={TILING_ID}
        filePath="/workspace/mockup.html"
        channelId="ch_1"
        workspaceId="ws_1"
      />,
    )

    // Enter fullscreen.
    fireEvent.click(getByTestId("fvw-actions-fullscreen"))
    await waitFor(() => {
      expect(requestFullscreen).toHaveBeenCalled()
    })
    expect(document.fullscreenElement).not.toBeNull()

    // Click again → toggle off.
    fireEvent.click(getByTestId("fvw-actions-fullscreen"))
    await waitFor(() => {
      expect(exitFullscreen).toHaveBeenCalled()
    })
    expect(document.fullscreenElement).toBeNull()
  })
})
