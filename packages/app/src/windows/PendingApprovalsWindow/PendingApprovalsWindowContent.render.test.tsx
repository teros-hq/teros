/**
 * PERMW-REQ-1 / PERMW-REQ-3 — the Pending approvals window renders the same
 * cards as the navbar sheet: the tool's own card per request, grouped by
 * conversation, and the batch footer under a group of two or more.
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
vi.mock("../../components/needsYou/useTerminalNeeds", () => ({ useTerminalNeeds: () => [] }))
vi.mock("../../components/needsYou/TerminalNeedCard", () => ({ TerminalNeedCard: () => null }))
// See PermissionIndicator.render.test.tsx: the registry's fallback renderer.
vi.mock("../../components/mca", async () => {
  const { DefaultToolCallRenderer } = await import("../../components/mca/DefaultToolCallRenderer")
  return { McaRegistry: { getToolCallRendererByMcpId: () => DefaultToolCallRenderer } }
})

import { PendingApprovalsWindowContent } from "./PendingApprovalsWindowContent"

const tr = (key: string, opts?: Record<string, unknown>) => i18n.t(key, opts) as string

let client: FakePermissionsClient

async function renderWindowWithRequests() {
  render(
    <TamaguiProvider config={config} defaultTheme="dark">
      <PendingApprovalsWindowContent windowId="w1" />
    </TamaguiProvider>,
  )
  act(() => {
    for (const request of REQUESTS) client.emit("tool_permission_request", request)
  })
  await waitFor(() => screen.getByTestId("approvals-group-ch1"))
}

describe("[PERMW-AC-1] the Pending approvals window renders the same cards", () => {
  beforeEach(() => {
    client = new FakePermissionsClient()
    hoisted.client = client
    seedChannels()
  })

  it("[PERMW-AC-1] three tool cards in two conversation groups, each with the four-pill bar", async () => {
    await renderWindowWithRequests()
    const ch1 = screen.getByTestId("approvals-group-ch1")
    const ch2 = screen.getByTestId("approvals-group-ch2")
    expect(within(ch1).getByText("Sales follow-up")).toBeTruthy()
    expect(within(ch1).getByText(tr("pendingApprovals.openChat"))).toBeTruthy()
    expect(within(ch1).getByTestId("pending-card-r1")).toBeTruthy()
    expect(within(ch1).getByTestId("pending-card-r2")).toBeTruthy()
    expect(within(ch2).getByTestId("pending-card-r3")).toBeTruthy()
    for (const requestId of ["r1", "r2", "r3"]) {
      const card = screen.getByTestId(`pending-card-${requestId}`)
      for (const key of ["denyAlways", "deny", "allowAlways", "allow"]) {
        expect(within(card).getByLabelText(tr(`mca.permission.${key}`))).toBeTruthy()
      }
    }
  })

  it("[PERMW-AC-1] Deny on a card answers that request", async () => {
    await renderWindowWithRequests()
    const card = screen.getByTestId("pending-card-r3")
    await userEvent.setup().click(within(card).getByLabelText(tr("mca.permission.deny")))
    expect(client.respondToToolPermission).toHaveBeenCalledWith("r3", false)
  })

  it("[PERMW-AC-3] the two-card group shows the batch footer, the single card none", async () => {
    await renderWindowWithRequests()
    expect(within(screen.getByTestId("approvals-group-ch1")).getByTestId("permission-group-footer")).toBeTruthy()
    expect(within(screen.getByTestId("approvals-group-ch2")).queryByTestId("permission-group-footer")).toBeNull()
  })
})
