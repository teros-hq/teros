import { act, render, renderHook } from "@testing-library/react"
import type { ReactElement, ReactNode } from "react"
import { TamaguiProvider } from "tamagui"
import config from "../../../tamagui.config"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { useTabState } from "../../hooks/useTabState"
import { type WindowTypeDefinition, windowRegistry } from "../../services/windowRegistry"
import { useChatStore } from "../../store/chatStore"
import {
  setWindowStatus,
  useWindowStatus,
  useWindowTabMetaStore,
  type WindowStatus,
} from "../../store/windowTabMetaStore"
import { TabStatusSlot, WindowStatusMark } from "./TabStatusSlot"

const renderWithTamagui = (ui: ReactElement) =>
  render(ui, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <TamaguiProvider config={config} defaultTheme="dark">
        {children}
      </TamaguiProvider>
    ),
  })

const TYPE = "__status_win__"

const definition: WindowTypeDefinition = {
  type: TYPE,
  audience: "user",
  displayName: "Thing",
  icon: (() => <span data-testid="type-icon" />) as unknown as WindowTypeDefinition["icon"],
  color: "#000000",
  getTitle: () => "Thing",
  defaultSize: { width: 100, height: 100 },
  component: (() => null) as unknown as WindowTypeDefinition["component"],
  serialize: (props) => props,
  deserialize: (data) => data,
}

const win = (id = "w1", extra: Record<string, unknown> = {}) => ({
  id,
  type: TYPE,
  props: {},
  hasNotification: false,
  ...extra,
})

function Slot({ id = "w1", active = false, hasNotification = false }) {
  const state = useTabState(win(id, { hasNotification }), active)
  return <TabStatusSlot state={state} glyph="#888888" />
}

beforeEach(() => {
  windowRegistry.register(definition)
  useWindowTabMetaStore.setState({ meta: {}, status: {} })
})
afterEach(() => {
  windowRegistry.unregister(TYPE)
})

describe("the generic window status", () => {
  it("[FLOAT-AC-15] a window with no status shows its type icon, as before", () => {
    const { queryByTestId } = renderWithTamagui(<Slot />)
    expect(queryByTestId("type-icon")).toBeTruthy()
    expect(queryByTestId("window-status-working")).toBeNull()
    expect(queryByTestId("window-status-needs-you")).toBeNull()
    expect(queryByTestId("window-status-finished")).toBeNull()
  })

  it.each<WindowStatus>(["working", "needs-you", "finished"])(
    "[FLOAT-AC-15] a published %s status replaces the icon with its mark, on the active tab too",
    (status) => {
      act(() => setWindowStatus("w1", status))
      const { queryByTestId, rerender } = renderWithTamagui(<Slot />)
      expect(queryByTestId(`window-status-${status}`)).toBeTruthy()
      expect(queryByTestId("type-icon")).toBeNull()
      rerender(<Slot active />)
      expect(queryByTestId(`window-status-${status}`)).toBeTruthy()
    },
  )

  it("[FLOAT-AC-15] clearing the status brings the icon back; one window's status is not another's", () => {
    act(() => setWindowStatus("w1", "working"))
    const { queryByTestId, rerender } = renderWithTamagui(<Slot id="w2" />)
    expect(queryByTestId("window-status-working")).toBeNull()
    rerender(<Slot id="w1" />)
    expect(queryByTestId("window-status-working")).toBeTruthy()
    act(() => setWindowStatus("w1", null))
    expect(queryByTestId("window-status-working")).toBeNull()
    expect(queryByTestId("type-icon")).toBeTruthy()
  })

  it("[FLOAT-AC-15] needs-you wins over an unread notification, and tells the frame it wants the person", () => {
    act(() => setWindowStatus("w1", "needs-you"))
    const { result } = renderHook(() => useTabState(win("w1", { hasNotification: true }), false))
    expect(result.current.status).toBe("needs-you")
    expect(result.current.wantsYou).toBe(true)
    expect(result.current.showBlueDot).toBe(false)
    expect(result.current.showIcon).toBe(false)
  })

  it("[FLOAT-AC-15] a window with only an unread notification keeps its blue dot when not active", () => {
    const { result, rerender } = renderHook(
      ({ active }) => useTabState(win("w1", { hasNotification: true }), active),
      { initialProps: { active: false } },
    )
    expect(result.current.showBlueDot).toBe(true)
    expect(result.current.wantsYou).toBe(false)
    rerender({ active: true })
    expect(result.current.showBlueDot).toBe(false)
    expect(result.current.showIcon).toBe(true)
  })

  it("[FLOAT-AC-15] a conversation keeps what it shows: typing is the spinner, a requested action wants you", () => {
    useChatStore.setState({
      channels: {
        c1: { channelId: "c1", title: "Chat", isTyping: true, externalActionRequested: true },
      },
    } as never)
    const chat = { id: "w9", type: "chat", props: { channelId: "c1" }, hasNotification: false }
    const { result } = renderHook(() => useTabState(chat, false))
    expect(result.current.showSpinner).toBe(true)
    expect(result.current.showRedDot).toBe(false)
    act(() =>
      useChatStore.setState({
        channels: {
          c1: { channelId: "c1", title: "Chat", isTyping: false, externalActionRequested: true },
        },
      } as never),
    )
    expect(result.current.showRedDot).toBe(true)
    expect(result.current.wantsYou).toBe(true)
  })

  it("[FLOAT-AC-15] a mounted window publishes its status and takes it away when it unmounts", () => {
    const { rerender, unmount } = renderHook(
      ({ status }: { status: WindowStatus | null }) => useWindowStatus("w5", status),
      { initialProps: { status: "working" as WindowStatus | null } },
    )
    expect(useWindowTabMetaStore.getState().status.w5).toBe("working")
    rerender({ status: "finished" })
    expect(useWindowTabMetaStore.getState().status.w5).toBe("finished")
    unmount()
    expect(useWindowTabMetaStore.getState().status.w5).toBeUndefined()
  })

  it("[FLOAT-AC-16] the mark alone draws the same three states, and nothing for none", () => {
    const { queryByTestId, rerender } = renderWithTamagui(<WindowStatusMark status="needs-you" />)
    expect(queryByTestId("window-status-needs-you")).toBeTruthy()
    rerender(<WindowStatusMark status="finished" />)
    expect(queryByTestId("window-status-finished")).toBeTruthy()
    rerender(<WindowStatusMark status="working" />)
    expect(queryByTestId("window-status-working")).toBeTruthy()
    rerender(<WindowStatusMark status={null} />)
    expect(queryByTestId("window-status-working")).toBeNull()
  })
})
