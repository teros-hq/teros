/**
 * Permission Detail — the "what am I approving" block.
 *
 * BUILT by `withPermissionSupport` — which is what gives every MCA renderer this
 * detail with no per-renderer changes — and RENDERED inside the tool card, handed
 * down through `PermissionControlsContext.detail` and appended at the end of the
 * card body, below the renderer's own children. Renderers that mount no
 * `ToolCallCard` get it from the HOC's fallback instead. Five parts: intent line,
 * capability badges, annotated params, expansion toggle, and the technical tool
 * name (mono, tertiary) after the parameters (PERMW-REQ-4).
 *
 * Must stay useful in every metadata state — the Allow/Deny controls are never
 * gated on the fetch. See docs/specs/mca/permission-approval-detail.md.
 */

import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { YStack } from "tamagui"
import { T } from "../../ui/ds/Text"
import { useToolDetails } from "../../../hooks/mca/useToolDetails"
import { captureException } from "../../../lib/sentry"
import { AnnotatedParamsTable } from "./AnnotatedParamsTable"
import { CapabilityBadges } from "./CapabilityBadges"
import { resolveIntent } from "./permission-intent"

export interface PermissionDetailProps {
  toolName: string
  appId?: string
  mcaId?: string
  input?: Record<string, unknown>
  /** Layer-5 fallback text — the caller's static label. */
  fallbackText: string
  /** Manifest irreversibility flag already threaded through the renderer props. */
  irreversible?: boolean
  /**
   * Set false when the caller already shows the capability badges — the grouped
   * panel renders them on the collapsed row, so repeating them in the expansion
   * would say the same thing twice.
   */
  showBadges?: boolean
}

/** @spec PERMW-REQ-4 */
export function PermissionDetail({
  toolName,
  appId,
  mcaId,
  input,
  fallbackText,
  irreversible,
  showBadges = true,
}: PermissionDetailProps) {
  const { t } = useTranslation()
  const toolNames = useMemo(() => [toolName], [toolName])
  const { details, failed } = useToolDetails(appId, toolNames)
  const detail = details[toolName]

  const intent = resolveIntent({
    toolName,
    mcaId,
    input,
    ...(detail ? { detail } : {}),
    fallbackText,
    // Layer 1 runs on unvalidated LLM arguments and this tree has no error
    // boundary between it and the chat root, so a throw must be reported here
    // rather than propagated.
    onOverrideError: (error, context) =>
      captureException(error, { source: "PermissionDetail.resolveIntent", ...context }),
  })

  return (
    <YStack gap={10} testID="permission-detail">
      {/* `.tc-desc` — the sentence a reviewer reads: sans 14, text. */}
      <T step="sm" style={{ fontSize: 14, lineHeight: 19 }} testID="permission-detail-intent">
        {intent.text}
      </T>

      {showBadges ? (
        <CapabilityBadges annotations={detail?.annotations} irreversible={irreversible} />
      ) : null}

      {/* A card whose metadata failed must not be indistinguishable from a tool
          that genuinely declares nothing — the absent "Irreversible" badge would
          otherwise read as reassurance. */}
      {failed && !detail ? (
        <T step="12" tone="text3" testID="permission-detail-unavailable">
          {t("mca.permissionDetail.detailsUnavailable")}
        </T>
      ) : null}

      <AnnotatedParamsTable input={input} schema={detail?.parameters} />

      {/* PERMW-REQ-4: the header says what the tool does in words; the technical
          name stays available here, after the parameters, for whoever needs it. */}
      <T
        step="code"
        tone="text3"
        numberOfLines={1}
        ellipsizeMode="middle"
        testID="permission-detail-tool-name"
        style={{ fontSize: 11, lineHeight: 14 }}
      >
        {toolName}
      </T>
    </YStack>
  )
}
