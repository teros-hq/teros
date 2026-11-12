import type React from "react"
import { useEffect, useMemo, useState } from "react"
import { AnimatePresence, YStack } from "tamagui"
import type { McaStatusType } from "./colors"
import { ExpandedBody, ExpandedContainer } from "./Containers"
import { HeaderRow } from "./HeaderRow"
import { usePermissionControls } from "./PermissionControlsContext"
import { ToolLine } from "./ToolLine"
import { useToolCallMeta } from "./ToolCallMetaContext"
import { getShortToolName } from "./utils"
import { useToolDetails } from "../../../hooks/mca/useToolDetails"

interface ToolCallCardProps {
  status: McaStatusType
  /**
   * Fully-composed description string — the exact text shown in the header.
   * Renderers own the text; there is no automatic tense conjugation.
   */
  description?: string
  /**
   * @deprecated Renderer UX Guide v2 §7 forbids showing tool execution
   *   duration in the header. The prop is kept for backwards compatibility
   *   so the 70+ existing renderers keep compiling, but the value is
   *   silently ignored — nothing is rendered. Remove this prop from new
   *   code. The migration sweep (Fase 5) drops it from all callers.
   */
  duration?: number
  iconUri?: string
  /**
   * The app's display name for the header ("HubSpot · …"). When omitted on a
   * pending card, the card reads it from the tool details the approval detail
   * already loads, so every renderer names its app.
   *
   * @spec PERMW-REQ-4
   */
  appName?: string
  badge?: React.ReactNode
  isInContainer?: boolean
  defaultExpanded?: boolean
  /**
   * Optional left-edge accent color. When set, paints a 3px borderLeft on
   * the card. Use sparingly — only when the accent encodes information
   * not already conveyed by the StatusDot or Badge (regla
   * `feedback_color_signal_over_noise`).
   */
  accent?: string
  /**
   * If true, expansion/collapse fades in/out via CSS transition
   * (`@tamagui/animations-css` driver, preset `card` = 240ms cubic-bezier
   * with soft overshoot). Default `false` keeps legacy instant-toggle
   * for any consumer that doesn't opt in.
   */
  animateExpand?: boolean
  /**
   * Binary marker for irreversible operations (Renderer UX Guide v2 §8).
   * Renders an irreversibility indicator in the header. Sourced from
   * `manifest.tools[name].annotations.irreversible` upstream.
   */
  irreversible?: boolean
  /**
   * Binary marker for elevated security/blast risk (Renderer UX Guide
   * v2.1 §8.5). Renders the Risk Indicator amber badge in the header.
   * Decided per-call by `isToolCallElevatedRisk(mcaId, toolName, input)`
   * — see `permission-heuristics.ts`.
   */
  risk?: boolean
  /**
   * Tool identity for the header's mono pill (`gmail.send_email`). Optional:
   * the header falls back to the `ToolCallMetaContext` that
   * `withPermissionSupport` provides for every registered renderer.
   */
  toolName?: string
  children?: React.ReactNode
}

/** The pill's subtitle: the first short string value of the input. */
function subtitleFor(input?: Record<string, unknown>): string | undefined {
  if (!input) return undefined
  for (const v of Object.values(input)) {
    if (typeof v === "string" && v.trim()) {
      const one = v.replace(/\s+/g, " ").trim()
      return one.length > 48 ? `${one.slice(0, 47)}…` : one
    }
  }
  return undefined
}

/** @spec PERMW-REQ-4 */
export function ToolCallCard({
  status,
  description,
  duration: _duration, // accepted for back-compat, intentionally unused (guide v2 §7)
  iconUri,
  appName,
  badge,
  isInContainer,
  defaultExpanded = false,
  accent,
  animateExpand = false,
  irreversible,
  risk,
  toolName,
  children,
}: ToolCallCardProps) {
  // Description: the renderer owns the text. No automatic tense conjugation —
  // the old verb/tense system was removed (it produced generic labels like
  // "Execute command" instead of what the tool actually did).
  const resolvedDescription = description ?? ""
  // When a permission request is active, the surrounding HOC injects the
  // permission context. The card automatically expands and appends the
  // approval detail at the end of the body — renderers stay ignorant of the
  // flow (Renderer UX Guide v2 §8).
  const permission = usePermissionControls()
  const meta = useToolCallMeta()
  const [expanded, setExpanded] = useState(defaultExpanded || Boolean(permission?.forceExpand))

  // PERMW-REQ-4: the app's name comes from the tool details. Only looked up
  // while a permission is pending and the renderer passed none — the same
  // (appId, toolName) PermissionDetail fetches, so no extra round trip.
  const detailsAppId = permission && appName === undefined ? permission.appId : undefined
  const detailsToolNames = useMemo(
    () => (permission?.toolName ? [permission.toolName] : []),
    [permission?.toolName],
  )
  const { appName: detailsAppName } = useToolDetails(detailsAppId, detailsToolNames)
  const resolvedAppName = appName ?? detailsAppName

  // Keep the card open when a permission request arrives, so the approval
  // detail is visible without the user having to hunt for it.
  useEffect(() => {
    if (permission?.forceExpand) setExpanded(true)
  }, [permission?.forceExpand])

  // Tell the HOC we are rendering the detail, so it suppresses its own sibling
  // fallback (which exists for renderers that mount no ToolCallCard at all).
  // Depend on a BOOLEAN and a STABLE function — never on `permission.detail`
  // itself, which is a fresh element every render. See the contracts documented
  // in PermissionControlsContext.
  const hasDetail = Boolean(permission?.detail)
  const claimDetailSlot = permission?.claimDetailSlot
  useEffect(() => {
    if (!hasDetail || !claimDetailSlot) return
    return claimDetailSlot()
  }, [hasDetail, claimDetailSlot])

  // The Allow/Deny ControlsBar is rendered by `withPermissionSupport` AFTER
  // the card — the permission gate is owned by the HOC so it works for every
  // renderer regardless of composition (ToolCallCard vs HeaderRow/Expanded…),
  // and so collapsing this card can never hide the decision.
  //
  // The approval DETAIL, by contrast, belongs in here: it is information about
  // this tool call, so it lives inside the card's border and inside the region
  // the chevron collapses. It is APPENDED below the renderer's own children,
  // never substituted for them — a renderer's purpose-built preview (e.g. the
  // bash CommandRow) is exactly what a reviewer needs at approval time.
  // See docs/specs/mca/permission-approval-detail.md.
  const bodyContent = permission?.detail ? (
    <>
      {children}
      {permission.detail}
    </>
  ) : (
    (children ?? null)
  )

  // Executed, running, failed or queued calls are a LINE in the turn (the
  // prototype's `tline`): chip · note · markers · {} detail. Only a call that
  // waits for the human keeps the `.approval` card below.
  if (status !== "pending_permission" && !permission?.detail) {
    // Title + subtitle in one pill: the renderer's wording for this state
    // ("Sending email") and the call's headline value in grey ("ana@…").
    const rawName = toolName ?? meta?.toolName ?? ""
    const label = resolvedDescription || (rawName ? getShortToolName(rawName) : "tool")
    return (
      <YStack width="100%" testID="tool-call-card">
        <ToolLine
          status={status}
          iconUri={iconUri}
          label={label}
          argument={subtitleFor(meta?.input)}
          defaultExpanded={defaultExpanded}
          trailing={badge || irreversible || risk ? <>{badge}</> : undefined}
        >
          {children}
        </ToolLine>
      </YStack>
    )
  }

  // ONE border per card. The `.approval` card chrome is ALWAYS there — a
  // collapsed call is the same card showing only its header row (the OS
  // prototype has no "bare line" state). When a body exists this card wraps
  // header + body in its own ExpandedContainer, so the header goes borderless
  // (isInContainer semantics) instead of drawing a second outline. A bodyless
  // card is just the standalone header, which paints the chrome itself.
  const header = (
    <HeaderRow
      status={status}
      description={resolvedDescription}
      iconUri={iconUri}
      appName={resolvedAppName}
      badge={badge}
      irreversible={irreversible}
      risk={risk}
      toolName={toolName}
      expanded={expanded}
      onToggle={() => setExpanded((prev) => !prev)}
      isInContainer={isInContainer || Boolean(bodyContent)}
    />
  )

  // A card with output-gated children (e.g. FilesystemToolShell, whose body is
  // all `{data && …}`) has no body while pending. `bodyContent` is non-null
  // whenever a detail exists, so such a card grows a real ExpandedContainer for
  // the approval and reverts to a standalone header afterwards.
  if (!bodyContent) return header

  // We animate `opacity` + `scale` (transform, NOT layout). Scale gives
  // a tactile "pop" without causing the text below to shift, because
  // transforms don't affect document flow. translateY is intentionally
  // avoided — that *would* shift surrounding text during the transition.
  const animatedBody = (
    <YStack
      key="tool-call-body"
      animation="card"
      opacity={1}
      scale={1}
      enterStyle={{ opacity: 0, scale: 0.96 }}
      exitStyle={{ opacity: 0, scale: 0.98 }}
      transformOrigin="top"
    >
      <ExpandedBody>{bodyContent}</ExpandedBody>
    </YStack>
  )

  const body = !expanded ? null : animateExpand ? (
    animatedBody
  ) : (
    <ExpandedBody>{bodyContent}</ExpandedBody>
  )
  const content = (
    <>
      {header}
      {animateExpand ? <AnimatePresence>{body}</AnimatePresence> : body}
    </>
  )

  if (isInContainer) {
    return (
      <YStack
        width="100%"
        testID="tool-call-card"
        {...(accent ? { borderLeftWidth: 3, borderLeftColor: accent } : {})}
      >
        {content}
      </YStack>
    )
  }

  return (
    <YStack width="100%" testID="tool-call-card">
      <ExpandedContainer status={status} accent={accent}>
        {content}
      </ExpandedContainer>
    </YStack>
  )
}
