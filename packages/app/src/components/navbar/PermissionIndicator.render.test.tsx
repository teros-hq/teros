/**
 * PERMW-REQ-1 / PERMW-REQ-3 — the navbar sheet decides with the tool's own card.
 *
 * Drives the real `usePendingPermissions` through a fake WS client: three
 * `tool_permission_request` events (two apps in one conversation, one in
 * another) become three tool cards in two conversation groups, each with its
 * four-pill ControlsBar, and the two-card group gets the batch footer.
 */
import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TamaguiProvider } from "tamagui"
import { beforeEach, describe, expect, it, vi } from "vitest"
import config from "../../../tamagui.config"
import i18n from "../../i18n"
import { FakePermissionsClient, REQUESTS, seedChannels } from "../../test/pendingPermissionsFixture"

const hoisted = vi.hoisted(() => ({ client: undefined as unknown }))
vi.mock("../../services/terosClientSingleton", () => ({
  getTerosClient: () => hoisted.client,
}))
vi.mock("../needsYou/useTerminalNeeds", () => ({ useTerminalNeeds: () => [] }))
// Terminal notices are not the subject here (and their card pulls modules jsdom
// cannot parse).
vi.mock("../needsYou/TerminalNeedCard", () => ({ TerminalNeedCard: () => null }))
// The mca barrel registers every renderer (Flow-typed deps jsdom cannot parse).
// The registry's own fallback for an unregistered mcaId is the default renderer
// — the same `withPermissionSupport`-wrapped card the chat draws.
const getRenderer = vi.hoisted(() => vi.fn())
vi.mock("../mca", async () => {
  const { DefaultToolCallRenderer } = await import("../mca/DefaultToolCallRenderer")
  getRenderer.mockImplementation(() => DefaultToolCallRenderer)
  return { McaRegistry: { getToolCallRendererByMcpId: getRenderer } }
})

import { PermissionIndicator } from "./PermissionIndicator"

const tr = (key: string, opts?: Record<string, unknown>) => i18n.t(key, opts) as string

let client: FakePermissionsClient

async function openSheetWithRequests() {
  render(
    <TamaguiProvider config={config} defaultTheme="dark">
      <PermissionIndicator />
    </TamaguiProvider>,
  )
  act(() => {
    for (const request of REQUESTS) client.emit("tool_permission_request", request)
  })
  const banner = await waitFor(() =>
    screen.getByText(tr("nav.pendingApprovals", { count: REQUESTS.length })),
  )
  await userEvent.setup().click(banner)
  await waitFor(() => screen.getByTestId("sheet-group-ch1"))
}

describe("[PERMW-AC-1] the navbar sheet renders the tool's own cards", () => {
  beforeEach(() => {
    client = new FakePermissionsClient()
    hoisted.client = client
    seedChannels()
  })

  it("[PERMW-AC-1] three requests render three tool cards in two conversation groups, each with the four-pill bar", async () => {
    await openSheetWithRequests()

    const ch1 = screen.getByTestId("sheet-group-ch1")
    const ch2 = screen.getByTestId("sheet-group-ch2")
    expect(within(ch1).getByText("Sales follow-up")).toBeTruthy()
    expect(within(ch1).getByText("Atlas")).toBeTruthy()
    expect(within(ch2).getByText("Release notes")).toBeTruthy()
    expect(within(ch1).getByLabelText(tr("permissions.openChat"))).toBeTruthy()

    expect(within(ch1).getByTestId("pending-card-r1")).toBeTruthy()
    expect(within(ch1).getByTestId("pending-card-r2")).toBeTruthy()
    expect(within(ch2).getByTestId("pending-card-r3")).toBeTruthy()

    // Each card is resolved through the registry by the request's mcaId.
    expect(getRenderer).toHaveBeenCalledWith("mca.test.hubspot", "hubspot_create-contact")
    expect(getRenderer).toHaveBeenCalledWith("mca.test.gmail", "gmail_send-email")

    for (const requestId of ["r1", "r2", "r3"]) {
      const card = screen.getByTestId(`pending-card-${requestId}`)
      expect(within(card).getByTestId("permission-detail")).toBeTruthy()
      for (const key of ["denyAlways", "deny", "allowAlways", "allow"]) {
        expect(within(card).getByLabelText(tr(`mca.permission.${key}`))).toBeTruthy()
      }
    }
    expect(tr("mca.permission.allowAlways")).toBe("Always allow")
    expect(tr("mca.permission.denyAlways")).toBe("Always deny")
  })

  it("[PERMW-AC-1] Allow answers that request only", async () => {
    await openSheetWithRequests()
    const card = screen.getByTestId("pending-card-r1")
    await userEvent.setup().click(within(card).getByLabelText(tr("mca.permission.allow")))
    expect(client.respondToToolPermission).toHaveBeenCalledTimes(1)
    expect(client.respondToToolPermission).toHaveBeenCalledWith("r1", true)
    await waitFor(() => expect(screen.queryByTestId("pending-card-r1")).toBeNull())
  })

  it("[PERMW-AC-1] Always allow confirms, then answers and persists the rule", async () => {
    await openSheetWithRequests()
    const user = userEvent.setup()
    const card = screen.getByTestId("pending-card-r3")
    await user.click(within(card).getByLabelText(tr("mca.permission.allowAlways")))
    expect(client.respondToToolPermission).not.toHaveBeenCalled()
    await user.click(await waitFor(() => screen.getByLabelText(tr("mca.permission.confirm"))))
    expect(client.respondToToolPermission).toHaveBeenCalledWith("r3", true)
    expect(client.app.updateToolPermission).toHaveBeenCalledWith("app_fs", "files-write", "allow")
  })

  it("[PERMW-AC-3] a conversation group with two cards shows the batch footer; a single card shows none", async () => {
    await openSheetWithRequests()
    expect(within(screen.getByTestId("sheet-group-ch1")).getByTestId("permission-group-footer")).toBeTruthy()
    expect(within(screen.getByTestId("sheet-group-ch2")).queryByTestId("permission-group-footer")).toBeNull()
    expect(screen.queryByTestId("permission-group-header")).toBeNull()
  })

  it("[PERMW-AC-3] Allow all in the sheet grants the reversible request and leaves the irreversible one", async () => {
    await openSheetWithRequests()
    const user = userEvent.setup()
    const group = screen.getByTestId("sheet-group-ch1")
    await user.click(within(group).getByLabelText(tr("mca.permissionGroup.allowAll")))
    await user.click(await waitFor(() => screen.getByLabelText(tr("mca.permission.confirm"))))
    expect(client.respondToToolPermission).toHaveBeenCalledTimes(1)
    expect(client.respondToToolPermission).toHaveBeenCalledWith("r1", true)
    expect(screen.getByTestId("pending-card-r2")).toBeTruthy()
  })

  it("[PERMW-AC-1] a decision taken elsewhere settles the card through tool_status_update", async () => {
    await openSheetWithRequests()
    act(() => {
      client.emit("message_chunk", {
        chunkType: "tool_status_update",
        channelId: "ch2",
        messageId: "msg3",
        toolCallId: "tc3",
        toolStatus: "running",
      })
    })
    await waitFor(() => expect(screen.queryByTestId("pending-card-r3")).toBeNull())
    expect(client.channel.getMessages).not.toHaveBeenCalled()
  })
})
