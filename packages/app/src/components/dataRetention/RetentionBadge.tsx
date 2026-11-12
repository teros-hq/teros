/**
 * RetentionBadge — compact pill showing a model/provider's data-retention tier.
 *
 * Use next to a model or provider name in any picker so the user sees the
 * posture at a glance (🟢 zero retention / 🟡 retains / 🔴 trains on your data).
 * Pair with <RetentionNotice> for the full explanation when one is selected.
 */

import { View } from "react-native"
import { useTranslation } from "react-i18next"
import type { RetentionInfo } from "@teros/shared"
import { Badge } from "../ui/ds"
import { RETENTION_VISUALS } from "./retentionStyle"

interface RetentionBadgeProps {
  info: RetentionInfo
  /** Smaller paddings/text for dense lists (dropdown rows, grid cards). */
  compact?: boolean
}

export function RetentionBadge({ info, compact = false }: RetentionBadgeProps) {
  const { t } = useTranslation()
  const visual = RETENTION_VISUALS[info.tier]

  return (
    <View testID={`retention-badge-${info.tier}`} style={{ alignSelf: "flex-start" }}>
      <Badge tone={visual.tint} icon={visual.icon} pill sm={compact}>
        {t(`dataRetention.tier.${info.tier}.label`)}
      </Badge>
    </View>
  )
}
