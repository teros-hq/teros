import { act, fireEvent, render } from "@testing-library/react"
import { TamaguiProvider } from "tamagui"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import config from "../../../tamagui.config"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, o?: { defaultValue?: string }) => o?.defaultValue ?? key,
    }),
  }
})

import { type WindowTypeDefinition, windowRegistry } from "../../services/windowRegistry"
import { useTilingStore } from "../../store/tilingStore"
import {
  useWindowChrome,
  useWindowChromeStore,
  type WindowChrome,
} from "../../store/windowChromeStore"
import { WindowCloseConfirm } from "./WindowCloseConfirm"
import { requestCloseWindow, requestCloseWindows } from "./windowClose"

const TYPE = "__close_probe__"
const published: Record<string, WindowChrome | null> = {}

function Probe({ windowId }: { windowId: string }) {
  useWindowChrome(windowId, published[windowId] ?? null)
  return <WindowCloseConfirm windowId={windowId} />
}

const definition: WindowTypeDefinition = {
  type: TYPE,
  audience: "user",
  displayName: TYPE,
  icon: (() => null) as unknown as WindowTypeDefinition["icon"],
  color: "#000000",
  noPreview: true,
  getTitle: () => TYPE,
  defaultSize: { width: 100, height: 100 },
  component: (() => null) as unknown as WindowTypeDefinition["component"],
  serialize: (props) => props,
  deserialize: (data) => data,
}

const s = () => useTilingStore.getState()
const open = (n: number) => s().openWindow(TYPE, { n }, { inNewTab: true }) as string
const mount = (...ids: string[]) =>
  render(
    <TamaguiProvider config={config} defaultTheme="dark">
      {ids.map((id) => (
        <Probe key={id} windowId={id} />
      ))}
    </TamaguiProvider>,
  )

const question = (extra: Partial<ReturnType<NonNullable<WindowChrome["closeGuard"]>>> = {}) => ({
  message: "Shell 1 has something running. Ending it stops it.",
  confirmLabel: "End",
  keepLabel: "Keep running",
  onConfirm: vi.fn(),
  onKeep: vi.fn(),
  ...extra,
})

beforeEach(() => {
  windowRegistry.register(definition)
  useTilingStore.setState({ windows: {}, nextId: 1 })
  s().resetDesktops()
  s().setCompactShell(false)
  useWindowChromeStore.setState({ chrome: {}, closing: {} })
  for (const key of Object.keys(published)) delete published[key]
})
afterEach(() => {
  windowRegistry.unregister(TYPE)
})

describe("a window may guard its own close", () => {
  it("[TW-AC-27] a window that publishes nothing closes at once", () => {
    const id = open(1)
    mount(id)
    act(() => requestCloseWindow(id))
    expect(s().windows[id]).toBeUndefined()
  })

  it("[TW-AC-27] a guard with nothing to ask lets the window close and the window is told it was closed", () => {
    const id = open(1)
    const onClose = vi.fn()
    published[id] = { closeGuard: () => null, onClose }
    mount(id)
    act(() => requestCloseWindow(id))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(s().windows[id]).toBeUndefined()
  })

  it("[TW-AC-27] a guard with a question keeps the window, brings it to the front and asks in the window; the keep answer is the default", () => {
    const first = open(1)
    const second = open(2)
    const asked = question()
    const onClose = vi.fn()
    published[first] = { closeGuard: () => asked, onClose }
    const { getByTestId, queryByTestId } = mount(first, second)
    act(() => requestCloseWindow(first))
    expect(s().windows[first]).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
    const pane = s().windows[first].containerId
    const layout = s().desktops[s().activeDesktopIndex].layout as { activeWindowId?: string }
    expect(pane).toBeTruthy()
    expect(layout.activeWindowId).toBe(first)
    const bar = getByTestId(`window-close-confirm-${first}`)
    expect(bar.textContent).toContain("Shell 1 has something running. Ending it stops it.")
    expect(getByTestId(`window-close-confirm-${first}-ok`).textContent).toBe("End")
    expect(getByTestId(`window-close-confirm-${first}-keep`).textContent).toBe("Keep running")
    expect(document.activeElement).toBe(getByTestId(`window-close-confirm-${first}-keep`))
    expect(queryByTestId(`window-close-confirm-${second}`)).toBeNull()
    const answers = getByTestId(`window-close-confirm-${first}-ok`).parentElement
    expect(answers).toBe(getByTestId(`window-close-confirm-${first}-keep`).parentElement)
    expect(answers).not.toBe(bar)
  })

  it("[TW-AC-27] the confirm answer runs the window's own ending and closes it", () => {
    const id = open(1)
    const asked = question()
    published[id] = { closeGuard: () => asked }
    const { getByTestId, queryByTestId } = mount(id)
    act(() => requestCloseWindow(id))
    fireEvent.click(getByTestId(`window-close-confirm-${id}-ok`))
    expect(asked.onConfirm).toHaveBeenCalledTimes(1)
    expect(asked.onKeep).not.toHaveBeenCalled()
    expect(s().windows[id]).toBeUndefined()
    expect(queryByTestId(`window-close-confirm-${id}`)).toBeNull()
  })

  it("[TW-AC-27] the keep answer closes the window and ends nothing; Escape is the keep answer", () => {
    for (const how of ["click", "escape"] as const) {
      const id = open(how === "click" ? 1 : 2)
      const asked = question()
      published[id] = { closeGuard: () => asked }
      const { getByTestId, unmount } = mount(id)
      act(() => requestCloseWindow(id))
      if (how === "click") fireEvent.click(getByTestId(`window-close-confirm-${id}-keep`))
      else fireEvent.keyDown(document, { key: "Escape" })
      expect(asked.onKeep).toHaveBeenCalledTimes(1)
      expect(asked.onConfirm).not.toHaveBeenCalled()
      expect(s().windows[id]).toBeUndefined()
      unmount()
    }
  })

  it("[TW-AC-27] closing a pane asks each guarded window in it; a pane with no guard closes whole", () => {
    const plain = open(1)
    const guarded = open(2)
    const asked = question()
    published[guarded] = { closeGuard: () => asked }
    mount(plain, guarded)
    const whole = vi.fn()
    act(() => requestCloseWindows([plain, guarded], whole))
    expect(whole).not.toHaveBeenCalled()
    expect(s().windows[plain]).toBeUndefined()
    expect(s().windows[guarded]).toBeTruthy()
    act(() => requestCloseWindows([plain], whole))
    expect(whole).toHaveBeenCalledTimes(1)
  })
})
