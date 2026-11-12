/**
 * RetentionConfirmModal — blocking confirmation dialog shown when the user
 * picks a 🔴 model/provider (trains on your data by default, or opaque policy).
 *
 * Makes the data-retention choice a conscious one: the user must either back
 * out ("choose another") or explicitly accept ("use anyway"). Paired with
 * useRetentionGuard, which decides when to open it and remembers the choice.
 */

import { useTranslation } from "react-i18next"
import { Platform, View } from "react-native"
import { Dialog } from "tamagui"
import { RETENTION_VERIFIED_AT, type RetentionInfo } from "@teros/shared"
import { useColors } from "../mca/primitives/useColors"
import { colors as semantic } from "../mca/primitives/colors"
import { FONT_SERIF } from "../mca/primitives/fonts"
import { Btn, T, Tile } from "../ui/ds"
import { useRetentionVisual } from "./retentionStyle"

interface RetentionConfirmModalProps {
  open: boolean
  /** Posture of the model being confirmed (null when closed). */
  info: RetentionInfo | null
  /** Display name of the model/provider, shown under the title. */
  modelName?: string
  onConfirm: () => void
  onCancel: () => void
}

export function RetentionConfirmModal({
  open,
  info,
  modelName,
  onConfirm,
  onCancel,
}: RetentionConfirmModalProps) {
  const { t } = useTranslation()
  const c = useColors()
  const visual = useRetentionVisual(info?.tier ?? "trains")

  return (
    <Dialog modal open={open} onOpenChange={(o) => (!o ? onCancel() : null)}>
      <Dialog.Portal>
        <Dialog.Overlay
          key="overlay"
          animation="card"
          opacity={0.6}
          backgroundColor={semantic.main900}
          enterStyle={{ opacity: 0 }}
          exitStyle={{ opacity: 0 }}
        />
        <Dialog.Content
          key="content"
          testID="retention-confirm-modal"
          animation="card"
          enterStyle={{ opacity: 0, scale: 0.96 }}
          exitStyle={{ opacity: 0, scale: 0.96 }}
          transformOrigin="top"
          width={460}
          maxWidth="90%"
          padding={24}
          gap={16}
          borderRadius={16}
          borderWidth={0}
          backgroundColor={c.bgStep}
          {...(Platform.OS === "web" ? ({ style: { boxShadow: c.elevRaised } } as any) : {})}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <Tile tone={visual.tile} size="sm" icon={visual.icon} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Dialog.Title
                fontFamily={FONT_SERIF}
                fontWeight="400"
                fontSize={22}
                lineHeight={26}
                color={c.text}
              >
                {t("dataRetention.modal.title")}
              </Dialog.Title>
              {modelName ? (
                <T step="sm" tone="text2">
                  {modelName}
                </T>
              ) : null}
            </View>
          </View>
          <View
            style={{
              paddingVertical: 10,
              paddingHorizontal: 12,
              borderRadius: 10,
              backgroundColor: visual.bg,
              borderWidth: 1,
              borderColor: visual.border,
            }}
          >
            <T step="sm" color={visual.fg}>
              {info ? t(`dataRetention.notice.${info.noticeSlug}`) : ""}
            </T>
          </View>
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
            {/* Not wrapped in Dialog.Close: onCancel already closes via state,
                and the Close wrapper would fire onOpenChange → onCancel twice. */}
            <Btn testID="retention-confirm-cancel" variant="sec" onPress={onCancel}>
              {t("dataRetention.modal.cancel")}
            </Btn>
            <Btn
              testID="retention-confirm-accept"
              variant="dangerSoft"
              icon="shield-warning"
              onPress={onConfirm}
            >
              {t("dataRetention.modal.confirm")}
            </Btn>
          </View>
          <T step="12" tone="text3">
            {t("dataRetention.modal.verifiedAt", { date: RETENTION_VERIFIED_AT })}
          </T>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog>
  )
}
