/**
 * ConfirmDialog — the "are you sure" step before a permanent permission
 * decision (Always allow/deny, Allow/Deny all). Shared by `ControlsBar` and
 * the batch footer (`PermissionGroupFooter`) so the two cannot drift.
 *
 * OS prototype look: a step card (radius 16, violet lift), serif title, sans
 * message, pill actions — Cancel (ghost) and Confirm (primary violet for an
 * allow, red for a deny).
 */
import { useTranslation } from "react-i18next"
import { Modal, Platform, Pressable, View } from "react-native"
import { XStack } from "tamagui"
import { T } from "../../ui/ds/Text"
import { ShieldCheck, ShieldOff } from "./icons"
import { PillBtn } from "./Pill"
import { useColors } from "./useColors"

export interface ConfirmDialogProps {
  visible: boolean
  title: string
  message: string
  variant: "deny" | "allow"
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  visible,
  title,
  message,
  variant,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const c = useColors()
  const { t } = useTranslation()
  const Icon = variant === "deny" ? ShieldOff : ShieldCheck
  const tint = variant === "deny" ? c.tint.r : c.tint.i

  return (
    <Modal
      visible={visible}
      transparent
      animationType={Platform.OS === "web" ? "fade" : "slide"}
      onRequestClose={onCancel}
    >
      <Pressable
        style={{
          flex: 1,
          backgroundColor: "rgba(32,28,39,0.55)",
          justifyContent: "center",
          alignItems: "center",
          padding: 20,
        }}
        onPress={onCancel}
        accessibilityViewIsModal
      >
        <Pressable
          onPress={(e) => e.stopPropagation()}
          style={[
            {
              backgroundColor: c.bgStep,
              borderRadius: 16,
              width: "100%",
              maxWidth: 380,
              padding: 20,
              gap: 14,
            },
            Platform.OS === "web" ? ({ boxShadow: c.elevRaised, cursor: "default" } as any) : null,
          ]}
        >
          <XStack alignItems="center" gap={12}>
            <View
              style={{
                width: 36,
                height: 36,
                borderRadius: 10,
                backgroundColor: tint.bg,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Icon size={18} color={tint.tx} />
            </View>
            <T step="hsm" style={{ flex: 1 }}>
              {title}
            </T>
          </XStack>

          <T step="sm" tone="text2">
            {message}
          </T>

          <XStack justifyContent="flex-end" gap={8} marginTop={4}>
            <PillBtn
              variant="ghost"
              size="md"
              label={t("mca.permission.cancel")}
              onPress={onCancel}
            />
            <PillBtn
              variant={variant === "deny" ? "danger" : "primary"}
              size="md"
              icon={Icon}
              label={t("mca.permission.confirm")}
              onPress={onConfirm}
            />
          </XStack>
        </Pressable>
      </Pressable>
    </Modal>
  )
}
