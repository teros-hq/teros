import { useTranslation } from "react-i18next"
import { View } from "react-native"
import { useColors } from "../mca/primitives/useColors"
import { Btn, Ph, T } from "../ui/ds"
import type { SharedKind } from "./sharedSpace"

interface Props {
  kind: SharedKind
  workspaceName?: string
  onDismiss: () => void
}

export function SharedSpaceNotice({ kind, workspaceName, onDismiss }: Props) {
  const { t } = useTranslation()
  const c = useColors()
  const workspace = workspaceName || t("sharing.thisWorkspace", { defaultValue: "this workspace" })
  return (
    <View
      testID="shared-space-notice"
      accessibilityRole="alert"
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 10,
        paddingHorizontal: 12,
        paddingVertical: 8,
        backgroundColor: c.tint.a.bg,
        borderBottomWidth: 1,
        borderBottomColor: c.border,
      }}
    >
      <Ph name="users" size={16} color={c.tint.a.tx} />
      <T step="sm" style={{ color: c.text, flex: 1, minWidth: 220 }}>
        {t(`sharing.notice.${kind}`, {
          defaultValue:
            "This is a shared terminal of {{workspace}}. Whatever you sign in to here, and every file in its home, is available to everybody in the workspace. Use a personal terminal for your own accounts.",
          workspace,
        })}
      </T>
      <Btn size="sm" onPress={onDismiss} testID="shared-space-notice-ok">
        {t("sharing.noticeOk", { defaultValue: "Got it" })}
      </Btn>
    </View>
  )
}
