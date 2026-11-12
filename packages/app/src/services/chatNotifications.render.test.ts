import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { useChatStore } from "../store/chatStore"
import { _setChannelWorkspace, useTilingStore } from "../store/tilingStore"
import { type WindowTypeDefinition, windowRegistry } from "./windowRegistry"
import { installChatNotifications } from "./chatNotifications"

const chatDefinition: WindowTypeDefinition = {
  type: "chat",
  audience: "user",
  displayName: "Chat",
  icon: (() => null) as unknown as WindowTypeDefinition["icon"],
  color: "#000000",
  getTitle: () => "Chat",
  defaultSize: { width: 100, height: 100 },
  component: (() => null) as unknown as WindowTypeDefinition["component"],
  serialize: (props) => props,
  deserialize: (data) => data,
}

describe("chatNotifications", () => {
  let stop: () => void
  beforeEach(() => {
    windowRegistry.register(chatDefinition)
    useTilingStore.setState({ windows: {}, nextId: 1 })
    useTilingStore.getState().resetDesktops()
    useTilingStore.getState().setCompactShell(false)
    useChatStore.setState({ channelMessages: {} })
    // No workspace active in the test: a cached `null` channel workspace passes the open guard.
    _setChannelWorkspace("chA", null)
    _setChannelWorkspace("chB", null)
    stop = installChatNotifications()
  })
  afterEach(() => stop())

  it("[TABH-AC-5] a new message badges a non-active chat window, not the active one", () => {
    const s = () => useTilingStore.getState()
    // Two tabs in the same pane: the second one opened is the active tab.
    const idle = s().openWindow("chat", { channelId: "chB" }, true)!
    const active = s().openWindow("chat", { channelId: "chA" }, true)!

    useChatStore.setState({ channelMessages: { chA: ["m1"], chB: ["m2"] } })

    expect(s().windows[idle].hasNotification).toBe(true)
    expect(s().windows[idle].notificationCount).toBe(1)
    expect(s().windows[active].hasNotification).toBe(false)

    useChatStore.setState({ channelMessages: { chA: ["m1"], chB: ["m2", "m3"] } })
    expect(s().windows[idle].notificationCount).toBe(2)
  })
})
