import { act, fireEvent, render } from "@testing-library/react"
import { type ReactNode, useContext, useRef, useState } from "react"
import { TamaguiProvider } from "tamagui"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import config from "../../../../tamagui.config"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, o?: { defaultValue?: string }) => o?.defaultValue ?? key,
    }),
  }
})

import { __resetResizeGuardForTest } from "../../../lib/resizeGuard"
import { type WindowTypeDefinition, windowRegistry } from "../../../services/windowRegistry"
import { useTilingStore } from "../../../store/tilingStore"
import { useWindowChromeStore } from "../../../store/windowChromeStore"
import { setWindowStatus, useWindowTabMetaStore } from "../../../store/windowTabMetaStore"
import { TabContext } from "../TabContext"
import { FloatingWindowLayer } from "./FloatingWindowLayer"

const TYPE = "__layer_probe__"
const PLAIN = "__layer_plain__"

function Plain({ windowId }: { windowId: string }) {
  const renders = useRef(0)
  renders.current += 1
  return <div data-testid={`plain-${windowId}`} data-renders={renders.current} />
}

function Probe({ windowId, n }: { windowId: string; n: number }) {
  const [clicks, setClicks] = useState(0)
  const tab = useContext(TabContext)
  const renders = useRef(0)
  renders.current += 1
  return (
    <button
      type="button"
      data-testid={`probe-${windowId}`}
      data-renders={renders.current}
      data-tab-active={String(tab?.isTabActive)}
      data-front={String(tab?.isContainerActive)}
      onClick={() => setClicks((c) => c + 1)}
    >
      {`${n}:${clicks}`}
    </button>
  )
}

const definition: WindowTypeDefinition = {
  type: TYPE,
  audience: "user",
  displayName: "Probe",
  icon: (() => <span data-testid="probe-icon" />) as unknown as WindowTypeDefinition["icon"],
  color: "#000000",
  noPreview: true,
  getTitle: (props) => `Probe ${props.n}`,
  defaultSize: { width: 100, height: 100 },
  component: Probe as unknown as WindowTypeDefinition["component"],
  serialize: (props) => props,
  deserialize: (data) => data,
}

const s = () => useTilingStore.getState()
const tab = (n: number) => s().openWindow(TYPE, { n }, { inNewTab: true })!

function mount() {
  return render(<FloatingWindowLayer />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <TamaguiProvider config={config} defaultTheme="dark">
        {children}
      </TamaguiProvider>
    ),
  })
}

const pointer = (type: string, x: number, y: number) =>
  new PointerEvent(type, {
    pointerId: 1,
    clientX: x,
    clientY: y,
    bubbles: true,
    cancelable: true,
    pointerType: "mouse",
    button: type === "pointerdown" ? 0 : -1,
  })

const frame = (c: HTMLElement, id: string) =>
  c.querySelector(`[data-float-window="${id}"]`) as HTMLElement | null
const bubble = (c: HTMLElement, id: string) =>
  c.querySelector(`[data-float-bubble="${id}"]`) as HTMLElement | null

beforeEach(() => {
  windowRegistry.register(definition)
  windowRegistry.register({
    ...definition,
    type: PLAIN,
    component: Plain as unknown as WindowTypeDefinition["component"],
  })
  useTilingStore.setState({
    windows: {},
    floats: {},
    floatSheetId: null,
    nextId: 1,
    activeDesktopIndex: 0,
  })
  useWindowTabMetaStore.setState({ meta: {}, status: {} })
  s().resetDesktops()
  s().setCompactShell(false)
  __resetResizeGuardForTest()
})
afterEach(() => {
  windowRegistry.unregister(TYPE)
  windowRegistry.unregister(PLAIN)
  document.body.style.userSelect = ""
})

describe("the floating layer of the window system", () => {
  it("[FLOAT-AC-1] renders nothing while no window floats", () => {
    tab(1)
    const { container } = mount()
    expect(container.querySelector("[data-floating-layer]")).toBeNull()
  })

  it("[FLOAT-AC-1] a float shows the window's own content, with its id and props, under a header with its title", () => {
    const a = tab(1)
    tab(2)
    act(() => {
      s().floatWindow(a)
    })
    const { container, getByTestId } = mount()
    const f = frame(container, a)!
    expect(f).toBeTruthy()
    expect(f.contains(getByTestId(`probe-${a}`))).toBe(true)
    expect(getByTestId(`probe-${a}`).textContent).toBe("1:0")
    expect(f.getAttribute("aria-label")).toBe("Probe 1")
    expect(f.style.left).toBe(`${s().floats[a].x}px`)
    expect(f.style.width).toBe(`${s().floats[a].w}px`)
    expect(getByTestId(`probe-${a}`).getAttribute("data-tab-active")).toBe("true")
  })

  it("[FLOAT-AC-7] minimising turns it into a bubble and keeps the window mounted with its state; the bubble brings it back", () => {
    const a = tab(1)
    tab(2)
    act(() => {
      s().floatWindow(a)
    })
    const { container, getByTestId } = mount()
    fireEvent.click(getByTestId(`probe-${a}`))
    expect(getByTestId(`probe-${a}`).textContent).toBe("1:1")
    const node = getByTestId(`probe-${a}`)
    fireEvent.click(getByTestId(`float-minimize-${a}`))
    expect(s().floats[a].minimized).toBe(true)
    expect(frame(container, a)!.style.display).toBe("none")
    expect(getByTestId(`probe-${a}`)).toBe(node)
    expect(node.getAttribute("data-tab-active")).toBe("false")
    const b = bubble(container, a)!
    expect(b.getAttribute("aria-label")).toBe("Probe 1")
    act(() => {
      b.dispatchEvent(pointer("pointerdown", 10, 10))
      window.dispatchEvent(pointer("pointerup", 10, 10))
    })
    expect(s().floats[a].minimized).toBe(false)
    expect(frame(container, a)!.style.display).not.toBe("none")
    expect(getByTestId(`probe-${a}`)).toBe(node)
    expect(node.textContent).toBe("1:1")
    expect(bubble(container, a)).toBeNull()
  })

  it("[FLOAT-AC-6] bringing one float to the front does not remount or reorder the others", () => {
    const a = tab(1)
    const b = tab(2)
    tab(3)
    act(() => {
      s().floatWindow(a)
      s().floatWindow(b)
    })
    const { container, getByTestId } = mount()
    const nodeA = getByTestId(`probe-${a}`)
    const nodeB = getByTestId(`probe-${b}`)
    const order = () =>
      Array.from(container.querySelectorAll("[data-float-window]")).map((el) =>
        el.getAttribute("data-float-window"),
      )
    const before = order()
    expect(nodeB.getAttribute("data-front")).toBe("true")
    expect(nodeA.getAttribute("data-front")).toBe("false")
    act(() => {
      frame(container, a)!.dispatchEvent(pointer("pointerdown", 5, 5))
    })
    expect(s().floats[a].z).toBeGreaterThan(s().floats[b].z)
    expect(order()).toEqual(before)
    expect(getByTestId(`probe-${a}`)).toBe(nodeA)
    expect(getByTestId(`probe-${b}`)).toBe(nodeB)
    expect(nodeA.getAttribute("data-front")).toBe("true")
    expect(Number(frame(container, a)!.style.zIndex)).toBeGreaterThan(
      Number(frame(container, b)!.style.zIndex),
    )
  })

  it("[FLOAT-AC-6] dragging the header moves the float and saves the place on release", () => {
    const a = tab(1)
    tab(2)
    act(() => {
      s().floatWindow(a)
      s().setFloatRect(a, { x: 200, y: 100, w: 520, h: 340 })
    })
    const { container } = mount()
    const header = container.querySelector(`[data-float-header="${a}"]`) as HTMLElement
    act(() => {
      header.dispatchEvent(pointer("pointerdown", 300, 110))
    })
    act(() => {
      window.dispatchEvent(pointer("pointermove", 340, 160))
    })
    expect(frame(container, a)!.style.left).toBe("240px")
    expect(frame(container, a)!.style.top).toBe("150px")
    expect(s().floats[a]).toMatchObject({ x: 200, y: 100 })
    act(() => {
      window.dispatchEvent(
        new PointerEvent("pointerup", { pointerId: 7, clientX: 900, clientY: 700, bubbles: true }),
      )
    })
    expect(s().floats[a]).toMatchObject({ x: 200, y: 100 })
    expect(frame(container, a)!.style.left).toBe("240px")
    act(() => {
      window.dispatchEvent(pointer("pointerup", 340, 160))
    })
    expect(s().floats[a]).toMatchObject({ x: 240, y: 150, w: 520, h: 340 })
  })

  it("[FLOAT-AC-6] dragging the corner resizes it, never below the minimum", () => {
    const a = tab(1)
    tab(2)
    act(() => {
      s().floatWindow(a)
      s().setFloatRect(a, { x: 200, y: 100, w: 520, h: 340 })
    })
    const { container } = mount()
    const grip = container.querySelector(`[data-float-resize="${a}-se"]`) as HTMLElement
    act(() => {
      grip.dispatchEvent(pointer("pointerdown", 720, 440))
    })
    act(() => {
      document.dispatchEvent(pointer("pointermove", 760, 500))
    })
    expect(frame(container, a)!.style.width).toBe("560px")
    act(() => {
      document.dispatchEvent(pointer("pointerup", 760, 500))
    })
    expect(s().floats[a]).toMatchObject({ w: 560, h: 400 })
    act(() => {
      grip.dispatchEvent(pointer("pointerdown", 760, 500))
    })
    act(() => {
      document.dispatchEvent(pointer("pointermove", 0, 0))
    })
    act(() => {
      document.dispatchEvent(pointer("pointerup", 0, 0))
    })
    expect(s().floats[a]).toMatchObject({ w: 300, h: 200 })
  })

  it("[FLOAT-AC-4] the header's dock button puts it back in a pane", () => {
    const a = tab(1)
    tab(2)
    act(() => {
      s().floatWindow(a)
    })
    const { container, getByTestId } = mount()
    fireEvent.click(getByTestId(`float-dock-${a}`))
    expect(s().floats[a]).toBeUndefined()
    expect(s().windows[a]).toBeDefined()
    expect(frame(container, a)).toBeNull()
  })

  it("[FLOAT-AC-9] the header's close button closes the window", () => {
    const a = tab(1)
    tab(2)
    act(() => {
      s().floatWindow(a)
    })
    const { getByTestId } = mount()
    fireEvent.click(getByTestId(`float-close-${a}`))
    expect(s().windows[a]).toBeUndefined()
    expect(s().floats[a]).toBeUndefined()
  })

  it("[TW-AC-27] the header's close button asks the window's close guard first: the question shows in the frame and the keep answer closes it", () => {
    const a = tab(1)
    tab(2)
    act(() => {
      s().floatWindow(a)
    })
    const { getByTestId } = mount()
    const onKeep = vi.fn()
    act(() => {
      useWindowChromeStore.getState().setChrome(a, {
        closeGuard: () => ({
          message: "Shell 1 has something running. Ending it stops it.",
          confirmLabel: "End",
          keepLabel: "Keep running",
          onConfirm: () => {},
          onKeep,
        }),
      })
    })
    fireEvent.click(getByTestId(`float-close-${a}`))
    expect(s().windows[a]).toBeDefined()
    expect(getByTestId(`window-close-confirm-${a}`).textContent).toContain("has something running")
    fireEvent.click(getByTestId(`window-close-confirm-${a}-keep`))
    expect(onKeep).toHaveBeenCalledTimes(1)
    expect(s().windows[a]).toBeUndefined()
    act(() => useWindowChromeStore.getState().setChrome(a, null))
  })

  it("[FLOAT-AC-15] a window that needs the person marks its frame and its bubble the same way as its tab", () => {
    const a = tab(1)
    tab(2)
    act(() => {
      s().floatWindow(a)
      setWindowStatus(a, "needs-you")
    })
    const { container } = mount()
    const f = frame(container, a)!
    expect(f.getAttribute("data-wants-you")).toBe("true")
    expect(f.querySelector('[data-testid="window-status-needs-you"]')).toBeTruthy()
    act(() => {
      s().minimizeFloat(a, true)
    })
    const b = bubble(container, a)!
    expect(b.getAttribute("data-wants-you")).toBe("true")
    expect(b.querySelector('[data-testid="window-status-needs-you"]')).toBeTruthy()
    expect(s().floats[a].minimized).toBe(true)
    act(() => {
      setWindowStatus(a, "working")
    })
    expect(bubble(container, a)!.getAttribute("data-wants-you")).toBe("false")
    expect(
      bubble(container, a)!.querySelector('[data-testid="window-status-working"]'),
    ).toBeTruthy()
    act(() => {
      setWindowStatus(a, null)
    })
    expect(bubble(container, a)!.querySelector('[data-testid="probe-icon"]')).toBeTruthy()
  })

  it("[FLOAT-AC-6] what happens around a window (its status, its place, which float is in front) never re-renders it", () => {
    const plain = (n: number) => s().openWindow(PLAIN, { n }, { inNewTab: true })!
    const a = plain(1)
    const b = plain(2)
    plain(3)
    act(() => {
      s().floatWindow(a)
      s().floatWindow(b)
    })
    const { getByTestId } = mount()
    const renders = () => getByTestId(`plain-${a}`).getAttribute("data-renders")
    const before = renders()
    act(() => {
      setWindowStatus(a, "working")
    })
    act(() => {
      setWindowStatus(a, "needs-you")
      s().setFloatRect(a, { x: 10, y: 10, w: 400, h: 300 })
      s().setFloatRect(b, { x: 30, y: 30, w: 400, h: 300 })
    })
    act(() => {
      s().focusWindow(a)
    })
    act(() => {
      s().focusWindow(b)
      s().minimizeFloat(b, true)
    })
    expect(renders()).toBe(before)
  })

  it("[FLOAT-AC-6] a press inside a float's embedded page brings that float to the front", () => {
    vi.useFakeTimers()
    try {
      const a = tab(1)
      const b = tab(2)
      tab(3)
      act(() => {
        s().floatWindow(a)
        s().floatWindow(b)
      })
      const { container } = mount()
      expect(s().floats[b].z).toBeGreaterThan(s().floats[a].z)
      const page = document.createElement("iframe")
      frame(container, a)!.appendChild(page)
      page.focus()
      expect(document.activeElement).toBe(page)
      act(() => {
        window.dispatchEvent(new FocusEvent("blur"))
        vi.advanceTimersByTime(5)
      })
      expect(s().floats[a].z).toBeGreaterThan(s().floats[b].z)
    } finally {
      vi.useRealTimers()
    }
  })

  it("[FLOAT-AC-7] the bubble's label offers the way back to a pane", () => {
    const a = tab(1)
    tab(2)
    act(() => {
      s().floatWindow(a)
      s().minimizeFloat(a, true)
    })
    const { container, getByTestId } = mount()
    fireEvent.mouseEnter(bubble(container, a)!)
    fireEvent.click(getByTestId(`float-bubble-dock-${a}`))
    expect(s().floats[a]).toBeUndefined()
    expect(s().windows[a]).toBeDefined()
  })

  it("[FLOAT-AC-10] on the phone shell there are no frames: floats are bubbles, a tap opens one as a sheet, and nothing saved changes", () => {
    const a = tab(1)
    const b = tab(2)
    tab(3)
    act(() => {
      s().floatWindow(a)
      s().floatWindow(b)
      s().setCompactShell(true)
    })
    const saved = JSON.stringify(s().floats)
    const { container, getByTestId } = mount()
    const tap = (id: string) =>
      act(() => {
        bubble(container, id)!.dispatchEvent(pointer("pointerdown", 10, 10))
        window.dispatchEvent(pointer("pointerup", 10, 10))
      })
    expect(bubble(container, a)).toBeTruthy()
    expect(bubble(container, b)).toBeTruthy()
    expect(frame(container, a)!.style.display).toBe("none")
    expect(frame(container, b)!.style.display).toBe("none")
    expect(container.querySelector("[data-float-scrim]")).toBeNull()
    const node = getByTestId(`probe-${a}`)
    tap(a)
    expect(frame(container, a)!.getAttribute("data-float-mode")).toBe("sheet")
    expect(node.getAttribute("data-tab-active")).toBe("true")
    expect(bubble(container, a)).toBeNull()
    expect(bubble(container, b)).toBeTruthy()
    expect(container.querySelector(`[data-float-resize="${a}-se"]`)).toBeNull()
    fireEvent.pointerDown(container.querySelector("[data-float-scrim]") as HTMLElement)
    expect(frame(container, a)!.getAttribute("data-float-mode")).toBe("sheet")
    fireEvent.click(container.querySelector("[data-float-scrim]") as HTMLElement)
    expect(container.querySelector("[data-float-scrim]")).toBeNull()
    expect(frame(container, a)!.style.display).toBe("none")
    expect(getByTestId(`probe-${a}`)).toBe(node)
    tap(a)
    tap(b)
    expect(frame(container, b)!.getAttribute("data-float-mode")).toBe("sheet")
    expect(frame(container, a)!.style.display).toBe("none")
    fireEvent.click(getByTestId(`float-minimize-${b}`))
    expect(container.querySelector("[data-float-scrim]")).toBeNull()
    const strip = (text: string) => text.replace(/"z":\d+/g, "")
    expect(strip(JSON.stringify(s().floats))).toBe(strip(saved))
    act(() => {
      s().setCompactShell(false)
    })
    expect(frame(container, a)!.getAttribute("data-float-mode")).toBe("frame")
    expect(frame(container, b)!.getAttribute("data-float-mode")).toBe("frame")
  })

  it("[FLOAT-AC-14] the shortcut floats the focused pane's tab, and pressed again docks it", () => {
    const a = tab(1)
    const b = tab(2)
    const { container } = mount()
    const press = () =>
      act(() => {
        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            code: "KeyF",
            shiftKey: true,
            ctrlKey: true,
            altKey: true,
            bubbles: true,
            cancelable: true,
          }),
        )
      })
    press()
    expect(s().floats[b]).toBeDefined()
    expect(s().floats[a]).toBeUndefined()
    press()
    expect(s().floats[b]).toBeUndefined()
    expect(s().windows[b]).toBeDefined()
    press()
    const inside = frame(container, b)!.querySelector(`[data-testid="probe-${b}"]`) as HTMLElement
    inside.focus()
    press()
    expect(s().floats[b]).toBeUndefined()
    const elsewhere = document.createElement("input")
    document.body.appendChild(elsewhere)
    act(() => {
      s().floatWindow(a)
    })
    elsewhere.focus()
    press()
    expect(s().floats[a]).toBeDefined()
    expect(s().floats[b]).toBeDefined()
    elsewhere.remove()
  })

  it("[FLOAT-AC-14] while a tab is being dragged the floats step aside, so the drop reaches the pane under them", () => {
    const a = tab(1)
    const b = tab(2)
    act(() => {
      s().floatWindow(a)
    })
    const { container } = mount()
    const layer = container.querySelector("[data-floating-layer]") as HTMLElement
    expect(layer.getAttribute("data-tab-drag")).toBe("false")
    act(() => s().setGlobalDrag(b, [b], false))
    expect(layer.getAttribute("data-tab-drag")).toBe("true")
    const rule = Array.from(document.querySelectorAll("style"))
      .map((el) => el.textContent ?? "")
      .find((text) => text.includes('[data-tab-drag="true"]'))
    expect(rule).toMatch(
      /\[data-floating-layer\]\[data-tab-drag="true"\] \*\{pointer-events:none !important\}/,
    )
    act(() => s().clearGlobalDrag())
    expect(layer.getAttribute("data-tab-drag")).toBe("false")
    expect(frame(container, a)).toBeTruthy()
  })

  it("[FLOAT-AC-13] a float whose window no longer exists is not drawn", () => {
    const a = tab(1)
    tab(2)
    act(() => {
      s().floatWindow(a)
      useTilingStore.setState({
        floats: { ...s().floats, ghost: { x: 0, y: 0, w: 300, h: 200, minimized: false, z: 9 } },
      })
    })
    const { container } = mount()
    expect(frame(container, a)).toBeTruthy()
    expect(frame(container, "ghost")).toBeNull()
  })
})
