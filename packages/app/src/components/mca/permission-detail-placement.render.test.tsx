/**
 * Render tests — WHERE the permission approval detail is mounted.
 *
 * The detail belongs inside the tool card: it is information about this tool
 * call, so it lives inside the card's border and inside the region the chevron
 * collapses. It used to render as a flat sibling of the renderer, which put it
 * loose on the chat background between the card and the ControlsBar —
 * contradicting the spec's own mock
 * (docs/specs/mca/permission-approval-detail.md).
 *
 * `withPermissionSupport.render.test.tsx` covers the FALLBACK path (its fixtures
 * mount no ToolCallCard). This file covers the card path, which is what ~50 of
 * the ~54 renderers actually do.
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { TamaguiProvider, Text } from "tamagui"
import { beforeEach, describe, expect, it, vi } from "vitest"
import config from "../../../tamagui.config"
import { FallbackBody } from "./primitives/FallbackBody"
import { MCA_STRINGS } from "./primitives/strings"
import { ToolCallCard } from "./primitives/ToolCallCard"
import { PermissionContext, type ToolCallRendererProps } from "./types"
import { withPermissionSupport } from "./withPermissionSupport"
import i18n from "../../i18n"

const tr = (key: string, opts?: Record<string, unknown>) => i18n.t(key, opts) as string

const useToolDetails = vi.hoisted(() => vi.fn())
vi.mock("../../hooks/mca/useToolDetails", () => ({
  useToolDetails: (...args: unknown[]) => useToolDetails(...args),
  toolDetailsCache: { reset: () => {} },
}))

/**
 * A renderer that composes a real ToolCallCard, like ~50 of the real ones.
 *
 * `defaultExpanded` so the body is visible in NON-pending states too. Without
 * it, leaving `pending_permission` swaps the HOC's Provider element for a bare
 * renderer, which remounts the card and resets its expand state — so a test of
 * the pending → completed transition would measure collapse, not body content.
 */
function CardRenderer({ status, children }: ToolCallRendererProps & { children?: ReactNode }) {
  return (
    <ToolCallCard status={status} description="Do the thing" defaultExpanded>
      {children ?? <Text>renderer-body</Text>}
    </ToolCallCard>
  )
}

/** A card with NO children — the shape FilesystemToolShell takes while pending. */
function HeaderOnlyCardRenderer({ status }: ToolCallRendererProps) {
  return <ToolCallCard status={status} description="Do the thing" />
}

/** The default-renderer shape: a card whose body is FallbackBody. */
function FallbackCardRenderer({ status, input }: ToolCallRendererProps) {
  return (
    <ToolCallCard status={status} description="Do the thing">
      <FallbackBody status={status} input={input ?? null} />
    </ToolCallCard>
  )
}

function renderWrapped(
  Renderer: React.ComponentType<ToolCallRendererProps>,
  props: Partial<ToolCallRendererProps> = {},
  wrap?: (ui: ReactNode) => ReactNode,
) {
  const Wrapped = withPermissionSupport(Renderer)
  const ui = (
    <Wrapped
      toolCallId="tc1"
      toolName="files-read"
      status="pending_permission"
      permissionRequestId="pr1"
      appId="app1"
      {...props}
    />
  )
  return render(
    <TamaguiProvider config={config} defaultTheme="dark">
      <PermissionContext.Provider
        value={{ onGrant: vi.fn(), onGrantAlways: vi.fn(), onDeny: vi.fn(), onDenyAlways: vi.fn() }}
      >
        {wrap ? wrap(ui) : ui}
      </PermissionContext.Provider>
    </TamaguiProvider>,
  )
}

describe("permission detail placement", () => {
  beforeEach(() => {
    useToolDetails.mockReturnValue({ details: {}, loading: false, failed: false })
  })

  it("(N1) renders the detail INSIDE the tool card, not as a sibling", () => {
    renderWrapped(CardRenderer)

    const card = screen.getByTestId("tool-call-card")
    const detail = screen.getByTestId("permission-detail")

    // Containment is the requirement — presence alone was what let the original
    // bug ship, since the detail was present but outside the card.
    expect(card.contains(detail)).toBe(true)
    expect(screen.queryByTestId("permission-detail-fallback")).toBeNull()
  })

  it("(N2) keeps the renderer's own body — the detail is appended, not substituted", () => {
    renderWrapped(CardRenderer)

    // A renderer's purpose-built preview (e.g. the bash CommandRow) is exactly
    // what a reviewer needs at approval time. Replacing it would hide the
    // command at the moment the user decides whether to run it.
    expect(screen.getByText("renderer-body")).toBeTruthy()
    expect(screen.getByTestId("permission-detail")).toBeTruthy()
  })

  it('(N3) a default-rendered tool states "no parameters" exactly once', () => {
    renderWrapped(FallbackCardRenderer, { input: {} })

    // FallbackBody's ParamsTable is suppressed while pending because
    // AnnotatedParamsTable renders the same input, ranked and annotated. Both
    // firing produced two different wordings of the same fact.
    expect(screen.queryByText(MCA_STRINGS.fallback.noParams)).toBeNull()
    expect(screen.getByText(tr("mca.permissionDetail.noParams"))).toBeTruthy()
  })

  it("(N4) reverts to the renderer body once the tool is no longer pending", () => {
    // `Wrapped` is built ONCE: re-wrapping would create a new component type,
    // remount the card and reset its expand state, which would make this test
    // measure remounting rather than the pending → completed transition.
    const Wrapped = withPermissionSupport(CardRenderer)
    const tree = (status: ToolCallRendererProps["status"]) => (
      <TamaguiProvider config={config} defaultTheme="dark">
        <PermissionContext.Provider
          value={{
            onGrant: vi.fn(),
            onGrantAlways: vi.fn(),
            onDeny: vi.fn(),
            onDenyAlways: vi.fn(),
          }}
        >
          <Wrapped
            toolCallId="tc1"
            toolName="files-read"
            status={status}
            permissionRequestId="pr1"
            appId="app1"
          />
        </PermissionContext.Provider>
      </TamaguiProvider>
    )

    const { rerender } = render(tree("pending_permission"))
    expect(screen.getByTestId("permission-detail")).toBeTruthy()

    rerender(tree("completed"))

    expect(screen.getByText("renderer-body")).toBeTruthy()
    expect(screen.queryByTestId("permission-detail")).toBeNull()
    expect(screen.queryByTestId("permission-detail-fallback")).toBeNull()
  })

  it("(N5) a card with no children still grows a body to hold the detail", () => {
    // FilesystemToolShell's children are entirely output-gated, so while pending
    // it passes nothing and ToolCallCard used to short-circuit to a bare header.
    renderWrapped(HeaderOnlyCardRenderer)

    const card = screen.getByTestId("tool-call-card")
    expect(card.contains(screen.getByTestId("permission-detail"))).toBe(true)
  })

  it("(N6) collapsing the card hides the detail but never the Allow/Deny controls", async () => {
    const user = userEvent.setup()
    renderWrapped(CardRenderer)

    expect(screen.getByTestId("permission-detail")).toBeTruthy()
    await user.click(screen.getByText("Do the thing"))

    // The decision must stay reachable — that is why ControlsBar is a sibling
    // below the card rather than inside the collapsible body.
    expect(screen.queryByTestId("permission-detail")).toBeNull()
    expect(screen.getByLabelText(tr("mca.permission.allow"))).toBeTruthy()
    expect(screen.getByLabelText(tr("mca.permission.deny"))).toBeTruthy()
  })

  it("(N7) renders the detail exactly once for a card renderer", () => {
    renderWrapped(CardRenderer)

    // Guards the claim gate failing open: the card renders it AND the HOC
    // fallback renders it too.
    expect(screen.getAllByTestId("permission-detail")).toHaveLength(1)
  })

  it("(N8) double-wrapping yields one detail and one ControlsBar", () => {
    // Renderers self-wrap AND McaRegistry wraps them again; the inner instance
    // must stay a transparent pass-through now that the claim travels by context.
    renderWrapped(withPermissionSupport(CardRenderer))

    expect(screen.getAllByTestId("permission-detail")).toHaveLength(1)
    expect(screen.getAllByLabelText(tr("mca.permission.allow"))).toHaveLength(1)
  })

  it("(N11) FallbackBody adds no body region when it has nothing to draw", () => {
    // Non-grouped: the detail supplies the params, so FallbackBody renders
    // nothing — and must do so as `null`, or a renderer whose body is only this
    // primitive grows a second empty padded region inside the card.
    renderWrapped(FallbackCardRenderer, { input: { path: "/etc/hosts" } })

    expect(screen.getByTestId("permission-detail")).toBeTruthy()
    // One body region — the card's own. FallbackBody contributed no second one.
    expect(screen.getAllByTestId("expanded-body")).toHaveLength(1)
  })
})
