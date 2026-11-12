/**
 * PERMW-REQ-3 — a batch is a frame around real cards.
 *
 * Mirrors what ChatView does with a channel: run the REAL
 * `groupPendingPermissions` over the messages, render every tool card through
 * the registry's default renderer (wrapped by `withPermissionSupport`), put the
 * header before the group's first pending card and the footer after its anchor.
 * The batch mixes both "awaiting decision" shapes: `pending_permission` cards
 * and a `completed` card carrying the v4 `permission_requested` marker.
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TamaguiProvider } from "tamagui"
import { beforeEach, describe, expect, it, vi } from "vitest"
import config from "../../../../tamagui.config"
import { groupPendingPermissions } from "../../../hooks/chat/permission-grouping"
import i18n from "../../../i18n"
import type { Message } from "../../../store/chatStore"
import { DefaultToolCallRenderer } from "../DefaultToolCallRenderer"
import { PermissionContext, type PermissionContextValue, type ToolCallRendererProps } from "../types"
import {
  type GroupedPermissionTool,
  PermissionGroupFooter,
  PermissionGroupHeader,
} from "./GroupedPermissionPanel"

const useToolDetails = vi.hoisted(() => vi.fn())
vi.mock("../../../hooks/mca/useToolDetails", () => ({
  useToolDetails: (...args: unknown[]) => useToolDetails(...args),
  toolDetailsCache: { reset: () => {} },
}))

const tr = (key: string, opts?: Record<string, unknown>) => i18n.t(key, opts) as string

function toolMessage(id: string, content: Record<string, unknown>): Message {
  return {
    id,
    channelId: "ch_test",
    sender: "agent",
    timestamp: new Date("2026-10-28T00:00:00Z"),
    content: { type: "tool_execution", toolCallId: `tc_${id}`, ...content } as Message["content"],
  }
}

const pendingCard = (id: string, extra: Record<string, unknown> = {}) =>
  toolMessage(id, {
    toolName: "files-write",
    status: "pending_permission",
    permissionRequestId: `perm_${id}`,
    appId: "app_fs",
    ...extra,
  })

/** A pre-PERMB row: `completed`, pending fields dropped, the marker as output. */
const markerCard = (id: string, irreversible: boolean) =>
  toolMessage(id, {
    toolName: "files-delete",
    status: "completed",
    output: JSON.stringify({
      status: "permission_requested",
      permissionRequestId: `perm_${id}`,
      appId: "app_marker",
      irreversible,
    }),
  })

const completedCard = (id: string) =>
  toolMessage(id, { toolName: "files-read", status: "completed", output: "ok" })

function renderChannel(messages: Message[]) {
  const callbacks: PermissionContextValue = {
    onGrant: vi.fn(),
    onGrantAlways: vi.fn(),
    onDeny: vi.fn(),
    onDenyAlways: vi.fn(),
  }
  const byId = Object.fromEntries(messages.map((m) => [m.id, m]))
  const grouping = groupPendingPermissions(
    messages.map((m) => m.id),
    byId,
  )
  const result = render(
    <TamaguiProvider config={config} defaultTheme="dark">
      <PermissionContext.Provider value={callbacks}>
        {messages.map((m) => {
          const headerGroup = grouping.groupByFirstPendingId.get(m.id)
          const footerGroup = grouping.groupByAnchorId.get(m.id)
          return (
            <div key={m.id}>
              {headerGroup ? <PermissionGroupHeader tools={headerGroup.tools} /> : null}
              <div data-testid={`card-${m.id}`}>
                <DefaultToolCallRenderer {...(m.content as unknown as ToolCallRendererProps)} />
              </div>
              {footerGroup ? <PermissionGroupFooter tools={footerGroup.tools} /> : null}
            </div>
          )
        })}
      </PermissionContext.Provider>
    </TamaguiProvider>,
  )
  return { ...result, callbacks, grouping }
}

function renderFooter(tools: GroupedPermissionTool[], withContext = true) {
  const callbacks: PermissionContextValue = {
    onGrant: vi.fn(),
    onGrantAlways: vi.fn(),
    onDeny: vi.fn(),
    onDenyAlways: vi.fn(),
  }
  const footer = <PermissionGroupFooter tools={tools} />
  const result = render(
    <TamaguiProvider config={config} defaultTheme="dark">
      {withContext ? (
        <PermissionContext.Provider value={callbacks}>{footer}</PermissionContext.Provider>
      ) : (
        footer
      )}
    </TamaguiProvider>,
  )
  return { ...result, callbacks }
}

async function confirm() {
  const user = userEvent.setup()
  await user.click(await waitFor(() => screen.getByLabelText(tr("mca.permission.confirm"))))
}

const isBefore = (a: Element, b: Element) =>
  Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

describe("[PERMW-AC-3] a batch is a frame around real cards", () => {
  beforeEach(() => {
    useToolDetails.mockReturnValue({ details: {}, loading: false, failed: false })
  })

  it("[PERMW-AC-3] a run of three renders one header before the first card and one footer after the last; every card keeps its detail and bar", () => {
    renderChannel([
      completedCard("m0"),
      pendingCard("m1"),
      pendingCard("m2", { irreversible: true }),
      markerCard("m3", false),
    ])

    const headers = screen.getAllByTestId("permission-group-header")
    const footers = screen.getAllByTestId("permission-group-footer")
    expect(headers).toHaveLength(1)
    expect(footers).toHaveLength(1)
    expect(screen.getByText(tr("mca.permissionGroup.awaiting", { count: 3 }))).toBeTruthy()
    expect(screen.getByText(tr("mca.permissionGroup.destructiveNote", { count: 1 }))).toBeTruthy()

    // Header right before the FIRST pending card (after the completed m0),
    // footer after the LAST card of the run.
    expect(isBefore(screen.getByTestId("card-m0"), headers[0])).toBe(true)
    expect(isBefore(headers[0], screen.getByTestId("card-m1"))).toBe(true)
    expect(isBefore(screen.getByTestId("card-m3"), footers[0])).toBe(true)

    // Nothing suppressed: three details and three four-pill bars.
    expect(screen.getAllByTestId("permission-detail")).toHaveLength(3)
    expect(screen.getAllByLabelText(tr("mca.permission.allow"))).toHaveLength(3)
    expect(screen.getAllByLabelText(tr("mca.permission.deny"))).toHaveLength(3)
    expect(screen.getAllByLabelText(tr("mca.permission.allowAlways"))).toHaveLength(3)
    expect(screen.getAllByLabelText(tr("mca.permission.denyAlways"))).toHaveLength(3)
  })

  it("[PERMW-AC-3] Allow all grants the two reversible requests and leaves the irreversible one", async () => {
    const user = userEvent.setup()
    const { callbacks } = renderChannel([
      pendingCard("m1"),
      pendingCard("m2", { irreversible: true }),
      markerCard("m3", false),
    ])
    await user.click(screen.getByLabelText(tr("mca.permissionGroup.allowAll")))
    await confirm()
    expect(callbacks.onGrant).toHaveBeenCalledTimes(2)
    expect(callbacks.onGrant).toHaveBeenCalledWith("perm_m1")
    expect(callbacks.onGrant).toHaveBeenCalledWith("perm_m3")
    expect(callbacks.onGrant).not.toHaveBeenCalledWith("perm_m2")
    expect(callbacks.onGrantAlways).not.toHaveBeenCalled()
  })

  it("[PERMW-AC-3] each card's own Allow decides only its request", async () => {
    const user = userEvent.setup()
    const { callbacks } = renderChannel([pendingCard("m1"), pendingCard("m2")])
    await user.click(screen.getAllByLabelText(tr("mca.permission.allow"))[1])
    expect(callbacks.onGrant).toHaveBeenCalledTimes(1)
    expect(callbacks.onGrant).toHaveBeenCalledWith("perm_m2")
  })

  it("[PERMW-AC-3] one pending card renders neither header nor footer, and keeps its bar", () => {
    renderChannel([completedCard("m0"), pendingCard("m1")])
    expect(screen.queryByTestId("permission-group-header")).toBeNull()
    expect(screen.queryByTestId("permission-group-footer")).toBeNull()
    expect(screen.getAllByLabelText(tr("mca.permission.allow"))).toHaveLength(1)
  })
})

describe("[PERMW-AC-3] PermissionGroupFooter", () => {
  const REV1: GroupedPermissionTool = { requestId: "r1", irreversible: false }
  const REV2: GroupedPermissionTool = { requestId: "r2", irreversible: false }
  const IRREV: GroupedPermissionTool = { requestId: "r3", irreversible: true }

  it("[PERMW-AC-3] Deny all denies every request, the irreversible one included", async () => {
    const user = userEvent.setup()
    const { callbacks } = renderFooter([REV1, REV2, IRREV])
    await user.click(screen.getByLabelText(tr("mca.permissionGroup.denyAll")))
    await confirm()
    expect(callbacks.onDeny).toHaveBeenCalledTimes(3)
    expect(callbacks.onDenyAlways).not.toHaveBeenCalled()
  })

  it("[PERMW-AC-3] nothing is decided until the confirmation", async () => {
    const user = userEvent.setup()
    const { callbacks } = renderFooter([REV1, REV2])
    await user.click(screen.getByLabelText(tr("mca.permissionGroup.allowAll")))
    expect(callbacks.onGrant).not.toHaveBeenCalled()
  })

  it("[PERMW-AC-3] hides Allow all when every request is irreversible", () => {
    renderFooter([IRREV, { requestId: "r4", irreversible: true }])
    expect(screen.queryByLabelText(tr("mca.permissionGroup.allowAll"))).toBeNull()
    expect(screen.getByLabelText(tr("mca.permissionGroup.denyAll"))).toBeTruthy()
  })

  it("throws in dev when mounted without PermissionContext", () => {
    expect(() => renderFooter([REV1], false)).toThrow(/PermissionContext/)
  })
})
