/**
 * RetentionNotice — inline banner explaining what happens to the user's data
 * for the selected model/provider, with the concrete action when one exists
 * (opt out of training, move to the paid tier, enable a ZDR filter…).
 *
 * Non-blocking by design: it informs, it does not gate the choice. Render it
 * for the currently selected provider/model. Safe to render for the `zdr` tier
 * too — it then reads as reassurance ("nothing is stored").
 */

import { View } from "react-native"
import { useTranslation } from "react-i18next"
import type { RetentionInfo } from "@teros/shared"
import { Ph, T } from "../ui/ds"
import { useRetentionVisual } from "./retentionStyle"

interface RetentionNoticeProps {
  info: RetentionInfo
}

export function RetentionNotice({ info }: RetentionNoticeProps) {
  const { t } = useTranslation()
  const visual = useRetentionVisual(info.tier)

  return (
    <View
      testID={`retention-notice-${info.tier}`}
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 10,
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderRadius: 10,
        backgroundColor: visual.bg,
        borderWidth: 1,
        borderColor: visual.border,
      }}
    >
      <Ph name={visual.icon} size={14} color={visual.fg} style={{ marginTop: 1 }} />
      <T step="12" color={visual.fg} style={{ flex: 1 }}>
        {t(`dataRetention.notice.${info.noticeSlug}`)}
      </T>
    </View>
  )
}
