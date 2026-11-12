/**
 * withPermissionSupport — Renderer UX Guide v2 §8.
 *
 * HOC that owns the tool-permission flow for ANY tool-call renderer,
 * independent of which primitives the renderer composes. When a tool is in
 * `pending_permission`:
 *   • Provides `PermissionControlsContext` so a `ToolCallCard` inside the
 *     renderer auto-expands (`forceExpand`) and stays open.
 *   • Renders the single-line `ControlsBar` (Always deny / Deny / Always allow / Allow)
 *     immediately AFTER the renderer's output.
 *
 * The ControlsBar lives HERE — not inside `ToolCallCard` — because the
 * permission gate is a cross-cutting concern keyed on the tool's
 * `pending_permission` status, not on the renderer's choice of layout
 * primitives. Renderers that compose `HeaderRow`/`ExpandedContainer`
 * directly (instead of `ToolCallCard`) therefore still show the widget.
 * This HOC is applied centrally by `McaRegistry` so every registered MCA —
 * and the default renderer — gets it automatically.
 *
 * Idempotent: if an outer `withPermissionSupport` already provided the
 * context (e.g. registry-applied AND a legacy per-renderer self-wrap), the
 * inner instance becomes a transparent pass-through — the outermost wrapper
 * owns the single ControlsBar. Double-wrapping is therefore safe.
 *
 * Batches (PERMW-REQ-3): a run of ≥2 pending requests is a FRAME around the
 * tools' own cards — ChatView renders a header before the first pending card
 * and a footer (Deny all / Allow all) after the last. Nothing is suppressed
 * here: every card keeps its own detail and its own ControlsBar, in the chat as
 * in the navbar sheet and the Pending approvals window (PERMW-REQ-1).
 *
 * Detail (docs/specs/mca/permission-approval-detail.md): `PermissionDetail`
 * explains what the tool will do and which parameter values will be sent. It is
 * built HERE — which is what gives all 42 MCAs the detail with no per-renderer
 * changes — but RENDERED inside the tool card, by handing it down through
 * `PermissionControlsContext.detail`. It lands at the end of the card body,
 * BELOW the renderer's own children, so a renderer's purpose-built preview (the
 * bash CommandRow, say) stays visible at the moment of decision.
 *
 * Why it goes down the context rather than being rendered here: this HOC holds
 * `<WrappedRenderer/>` as an opaque element and cannot reach into whatever card
 * it mounts. Rendering the detail as a SIBLING — which is what this file used to
 * do — put it outside the card border and outside the region the card's chevron
 * collapses, contradicting the spec's own mock.
 *
 * Fallback: four production renderers mount no `ToolCallCard` at all
 * (BrowserbaseRenderer, notion/UploadFileRenderer, drive/FoldersRenderer,
 * drive/SharingRenderer) and `McaRegistry.render.test.tsx` pins the invariant
 * that a renderer composing NEITHER card NOR bar still gets the decision
 * surface. So the detail slot is CLAIMED: a card that renders it calls
 * `claimDetailSlot`, and only when nothing claims it by the end of the commit do
 * we render it ourselves as a wrapped sibling. Default-suppressed, so the ~50
 * card renderers never flash a block that then jumps into the card.
 */

import type React from "react"
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import { View } from "react-native"
import { humanToolLabel, PermissionDetail } from "./primitives"
import { ExpandedBody, ExpandedContainer } from "./primitives/Containers"
import { ControlsBar } from "./primitives/ControlsBar"
import { PermissionControlsContext } from "./primitives/PermissionControlsContext"
import { ToolCallMetaContext, type ToolCallMeta } from "./primitives/ToolCallMetaContext"
import type { ToolCallRendererProps } from "./types"
import { parsePermissionMarker } from "../../lib/permission-marker"

/**
 * Whether a `ToolCallCard` inside the renderer took the detail slot.
 * `unknown` until the commit settles — we suppress the fallback while unknown,
 * so the common (card) case never renders a duplicate for one frame.
 */
type DetailSlotState = "unknown" | "claimed" | "unclaimed"

/**
 * Re-exported from its shared home (`lib/permission-marker.ts`) so existing
 * importers keep working; the chat hooks read it from there.
 */
export { parsePermissionMarker }

/**
 * Tracks whether a `ToolCallCard` inside the renderer took the detail slot, so
 * the HOC only renders its own fallback when none did.
 *
 * The correctness rests on React flushing CHILD passive effects before PARENT
 * ones: the card claims in its effect, and the check below runs afterwards. The
 * check reads `claimsRef` rather than `slot` so the ordering between the two
 * `setState` calls is irrelevant. Keyed on `pending` rather than `[]` so a tool
 * that enters pending LATER re-arms instead of flashing the fallback.
 */
function useDetailSlotClaim(pending: boolean, toolName: string) {
  const claimsRef = useRef(0)
  const [slot, setSlot] = useState<DetailSlotState>("unknown")

  // MUST stay referentially stable: ToolCallCard uses it as an effect
  // dependency, so a fresh identity per render would loop.
  const claimDetailSlot = useCallback(() => {
    claimsRef.current += 1
    setSlot("claimed")
    if (typeof __DEV__ !== "undefined" && __DEV__ && claimsRef.current > 1) {
      console.warn(
        `[withPermissionSupport] ${claimsRef.current} ToolCallCards claimed the detail slot ` +
          `for one pending tool call (${toolName}). The approval detail will render once per ` +
          "card. A renderer should mount one card per tool call.",
      )
    }
    return () => {
      claimsRef.current -= 1
      if (claimsRef.current === 0) setSlot("unclaimed")
    }
  }, [toolName])

  useEffect(() => {
    if (!pending) {
      setSlot("unknown")
      return
    }
    if (claimsRef.current === 0) setSlot("unclaimed")
  }, [pending])

  return { slot, claimDetailSlot }
}

interface PendingPermissionSurfaceProps
  extends Pick<ToolCallRendererProps, "appId" | "mcaId" | "input" | "status" | "irreversible"> {
  permissionRequestId: string
  /**
   * `toolName` with '' normalised away — see the note at the call site. The raw
   * `toolName` is deliberately NOT threaded in: every consumer here (context,
   * ControlsBar, PermissionDetail) must agree on the normalised one.
   */
  safeToolName: string
  detailSlot: DetailSlotState
  claimDetailSlot: () => () => void
  /** The wrapped renderer's output. */
  children: React.ReactNode
}

/**
 * Everything the HOC adds while a tool sits in `pending_permission`: the context
 * carrying the approval detail down to the card, the fallback for renderers that
 * mount no card, and the ControlsBar attached below.
 *
 * PermissionDetail's `fallbackText` is required and must never be blank, or the
 * intent line silently renders empty instead of throwing (see resolveIntent's
 * guard) — `humanToolLabel` (primitives/utils.ts) guarantees that.
 *
 * @spec PERMW-REQ-1
 */
function PendingPermissionSurface({
  permissionRequestId,
  appId,
  safeToolName,
  mcaId,
  input,
  status,
  irreversible,
  detailSlot,
  claimDetailSlot,
  children,
}: PendingPermissionSurfaceProps) {
  const label = humanToolLabel(safeToolName)

  const detail = (
    <PermissionDetail
      toolName={safeToolName}
      appId={appId}
      mcaId={mcaId}
      input={input}
      irreversible={irreversible}
      fallbackText={label}
    />
  )

  return (
    <PermissionControlsContext.Provider
      value={{
        permissionRequestId,
        appId,
        // safeToolName, not the raw one: "Allow always" round-trips this to
        // `app.updateToolPermission`, which the backend rejects for ''. That
        // failure is only console.error'd in useChatPermissions, so the one-off
        // grant would succeed while the persistent preference silently never
        // saved — and the menu would label the rule with a blank name.
        toolName: safeToolName,
        forceExpand: true,
        detail,
        claimDetailSlot,
      }}
    >
      {children}
      {/* Fallback for renderers that mount no ToolCallCard: nothing claimed the
          slot, so render the detail here in a card-shaped wrapper rather than as
          a bare block on the chat background. Suppressed while the claim state is
          still 'unknown' — the card case must not flash. */}
      {detailSlot === "unclaimed" && (
        <ExpandedContainer status={status}>
          <ExpandedBody>
            <View testID="permission-detail-fallback" style={{ paddingTop: 10 }}>
              {detail}
            </View>
          </ExpandedBody>
        </ExpandedContainer>
      )}
      {/* The bar floats right below the card (no chrome of its own) so it reads
          as the card's footer while staying outside the collapsible region. */}
      <ControlsBar
        permissionRequestId={permissionRequestId}
        appId={appId}
        toolName={safeToolName}
      />
    </PermissionControlsContext.Provider>
  )
}

/** @spec PERMW-REQ-1 @spec PERMW-REQ-3 */
export function withPermissionSupport<P extends ToolCallRendererProps>(
  WrappedRenderer: React.ComponentType<P>,
): React.ComponentType<P> {
  const displayName = WrappedRenderer.displayName || WrappedRenderer.name || "Component"

  function RendererWithPermission(props: P) {
    // Idempotency guard: a non-null context means an outer wrapper already
    // owns the permission flow for this subtree — don't provide it (or the
    // ControlsBar) twice.
    const alreadyOwned = useContext(PermissionControlsContext) !== null

    // v4 permission cut (2026-10-27): the ask ends the turn with the
    // `permission_requested` JSON marker as the tool result, so the message
    // settles as `completed` and completeToolMessage DROPS
    // `permissionRequestId` from the content. Two shapes therefore mean
    // "awaiting the user's decision" (task tn_HnCvjxasWA8DD30R):
    //   1. pre-v4/legacy: status `pending_permission` + permissionRequestId
    //      (the transient state before the marker result lands, and restored
    //      rows from before the cut).
    //   2. v4: status `completed` + the marker in the OUTPUT — the durable
    //      shape that also survives reload (the DB row keeps the marker).
    // The marker's requestId feeds grant/deny — useChatPermissions' map is
    // keyed on requestId from the tool_permission_request broadcast.
    const marker =
      props.status === "completed" ? parsePermissionMarker(props.output) : null
    const effectiveRequestId =
      props.status === "pending_permission" && props.permissionRequestId
        ? props.permissionRequestId
        : marker?.permissionRequestId
    const pending = !!effectiveRequestId
    // `||`, not `??`: `ToolExecutionMessageContentSchema` types toolName as
    // `z.string()`, which accepts '', and resolveIntent THROWS on a falsy name.
    // With no error boundary between here and the chat root, that throw blanks
    // the conversation and the user can neither approve nor deny.
    const safeToolName = props.toolName || "unknown"

    // Unconditional — precedes the `pending` branch below, as hooks must.
    const { slot: detailSlot, claimDetailSlot } = useDetailSlotClaim(pending, safeToolName)

    // The tool's identity, pending or not, so the card header can show the
    // mono tool pill (`gmail.send_email`) without every renderer threading
    // `toolName` by hand. The raw name, not `safeToolName`: a blank name means
    // "no pill", not a pill that says "unknown".
    const meta = useMemo<ToolCallMeta>(
      () => ({
        toolName: props.toolName || undefined,
        mcaId: props.mcaId,
        appId: props.appId,
        input: props.input,
      }),
      [props.toolName, props.mcaId, props.appId, props.input],
    )

    if (pending && !alreadyOwned) {
      return (
        <ToolCallMetaContext.Provider value={meta}>
          <PendingPermissionSurface
            permissionRequestId={effectiveRequestId as string}
            appId={props.appId ?? marker?.appId}
            safeToolName={safeToolName}
            mcaId={props.mcaId}
            input={props.input}
            // Display status, not the raw one: when the pending state comes from
            // the v4 marker the message is settled as `completed`, but the tool
            // is still awaiting the user's decision — the fallback container
            // must keep the live approval wash, not the quiet settled style.
            status={marker ? "pending_permission" : props.status}
            irreversible={props.irreversible ?? marker?.irreversible}
            detailSlot={detailSlot}
            claimDetailSlot={claimDetailSlot}
          >
            <WrappedRenderer {...props} />
          </PendingPermissionSurface>
        </ToolCallMetaContext.Provider>
      )
    }

    return (
      <ToolCallMetaContext.Provider value={meta}>
        <WrappedRenderer {...props} />
      </ToolCallMetaContext.Provider>
    )
  }

  RendererWithPermission.displayName = `withPermissionSupport(${displayName})`
  return RendererWithPermission
}
