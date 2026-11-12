/**
 * Capability badges for a pending approval — Reads only / Irreversible / Network.
 *
 * Rendered by `PermissionDetail`. "Irreversible" is derived from the manifest
 * flag OR either annotation; that rule lives here (`isIrreversible`) rather than
 * being restated at each call site.
 *
 * Renders nothing when a tool declares no capabilities — an empty strip would add
 * a row of padding that reads as a loading state.
 */

import { useTranslation } from "react-i18next"
import { XStack } from "tamagui"
import type { ToolAnnotations } from "../../../types/tool-details"
import { Badge } from "./Badge"

/**
 * The subset this component reads, DERIVED from the canonical annotations rather
 * than restated: a hand-written copy stays structurally assignable to the whole,
 * so a renamed or retyped field would compile here and silently stop matching.
 */
export type CapabilityAnnotations = Pick<
  ToolAnnotations,
  "readOnlyHint" | "destructiveHint" | "openWorldHint" | "irreversible"
>

export interface CapabilityBadgesProps {
  annotations?: CapabilityAnnotations
  /** Manifest irreversibility flag, already threaded through the renderer props. */
  irreversible?: boolean
}

/**
 * Fail-closed: any one of the three signals marks the action irreversible. The
 * manifest flag and the two annotations are independent sources and none of them
 * is authoritative enough to override another downwards.
 */
export function isIrreversible(
  annotations: CapabilityAnnotations | undefined,
  irreversible: boolean | undefined,
): boolean {
  return Boolean(irreversible || annotations?.irreversible || annotations?.destructiveHint)
}

export function CapabilityBadges({ annotations, irreversible }: CapabilityBadgesProps) {
  const { t } = useTranslation()
  const showIrreversible = isIrreversible(annotations, irreversible)
  const showReadsOnly = Boolean(annotations?.readOnlyHint)
  const showNetwork = Boolean(annotations?.openWorldHint)

  if (!showReadsOnly && !showIrreversible && !showNetwork) return null

  return (
    <XStack gap={4} flexWrap="wrap">
      {showReadsOnly ? (
        <Badge text={t("mca.permissionDetail.readsOnly")} variant="info" />
      ) : null}
      {showIrreversible ? (
        <Badge text={t("mca.permissionDetail.irreversible")} variant="error" />
      ) : null}
      {showNetwork ? <Badge text={t("mca.permissionDetail.network")} variant="gray" /> : null}
    </XStack>
  )
}
