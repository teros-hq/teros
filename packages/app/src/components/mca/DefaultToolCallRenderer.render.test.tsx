/**
 * PERMW-REQ-4 — the card names the app and says what the tool does.
 *
 * The default renderer reads the tool details (stubbed here): before they load
 * the header says the humanized tool name, once they load it says
 * "HubSpot · Create a new HubSpot contact", and the technical name sits inside
 * the approval detail, after the parameters.
 */
import { render, screen, within } from "@testing-library/react"
import { TamaguiProvider } from "tamagui"
import { beforeEach, describe, expect, it, vi } from "vitest"
import config from "../../../tamagui.config"
import "../../i18n"
import { DefaultToolCallRenderer } from "./DefaultToolCallRenderer"
import { PermissionContext, type PermissionContextValue } from "./types"

const useToolDetails = vi.hoisted(() => vi.fn())
vi.mock("../../hooks/mca/useToolDetails", () => ({
  useToolDetails: (...args: unknown[]) => useToolDetails(...args),
  toolDetailsCache: { reset: () => {} },
}))

const TOOL = "hubspot_create-contact"

const LOADED = {
  details: {
    [TOOL]: {
      requestedName: TOOL,
      name: "create-contact",
      description: "Create a new HubSpot contact",
      parameters: { type: "object" as const, properties: { email: { type: "string" } } },
    },
  },
  appName: "HubSpot",
  loading: false,
  failed: false,
}

const callbacks: PermissionContextValue = {
  onGrant: vi.fn(),
  onGrantAlways: vi.fn(),
  onDeny: vi.fn(),
  onDenyAlways: vi.fn(),
}

function card(status: "pending_permission" | "completed" = "pending_permission") {
  return (
    <TamaguiProvider config={config} defaultTheme="dark">
      <PermissionContext.Provider value={callbacks}>
        <DefaultToolCallRenderer
          toolCallId="tc1"
          toolName={TOOL}
          appId="app_hs"
          status={status}
          permissionRequestId={status === "pending_permission" ? "perm_1" : undefined}
          output={status === "completed" ? "ok" : undefined}
          input={{ email: "ana@example.com" }}
        />
      </PermissionContext.Provider>
    </TamaguiProvider>
  )
}

describe("[PERMW-AC-4] default renderer names the app and the action", () => {
  beforeEach(() => {
    useToolDetails.mockReset()
  })

  it("[PERMW-AC-4] shows the humanized name before the details load, no app name", () => {
    useToolDetails.mockReturnValue({ details: {}, loading: true, failed: false })
    render(card())
    expect(screen.getAllByText("Create Contact").length).toBeGreaterThan(0)
    expect(screen.queryByTestId("header-app-name")).toBeNull()
  })

  it("[PERMW-AC-4] shows \"HubSpot · Create a new HubSpot contact\" once the details load", () => {
    useToolDetails.mockReturnValue({ details: {}, loading: true, failed: false })
    const { rerender } = render(card())
    useToolDetails.mockReturnValue(LOADED)
    rerender(card())
    expect(screen.getByTestId("header-app-name").textContent).toBe("HubSpot ·")
    expect(screen.getAllByText("Create a new HubSpot contact").length).toBeGreaterThan(0)
    expect(screen.queryByText("Create Contact")).toBeNull()
  })

  it("[PERMW-AC-4] shows the technical tool name inside the detail, after the parameters", () => {
    useToolDetails.mockReturnValue(LOADED)
    render(card())
    const detail = screen.getByTestId("permission-detail")
    const technical = within(detail).getByTestId("permission-detail-tool-name")
    expect(technical.textContent).toBe(TOOL)
    const params = within(detail).getByTestId("permission-params")
    expect(Boolean(params.compareDocumentPosition(technical) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(
      true,
    )
  })

  it("[PERMW-AC-4] only asks for the details while a permission is pending", () => {
    useToolDetails.mockReturnValue({ details: {}, loading: false, failed: false })
    render(card("completed"))
    for (const call of useToolDetails.mock.calls) expect(call[0]).toBeUndefined()
  })
})
