import type { Space } from "@teros/shared"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { View } from "react-native"
import { useColors } from "../mca/primitives/useColors"
import { Btn, OptionRow, T } from "../ui/ds"
import type { SharedKind } from "./sharedSpace"

interface Props {
  kind: SharedKind
  workspaceName?: string
  sharedNote?: string
  sharedDisabled?: boolean
  onPick: (space: Space) => void
}

export function SpaceChoice({ kind, workspaceName, sharedNote, sharedDisabled, onPick }: Props) {
  const { t } = useTranslation()
  const c = useColors()
  const [space, setSpace] = useState<Space>("personal")
  const workspace = workspaceName || t("sharing.thisWorkspace", { defaultValue: "this workspace" })
  const sharedSub = t(`sharing.choice.${kind}.shared`, {
    defaultValue:
      "The machine of {{workspace}}. Everyone with write access sees it and types in it; what you sign in to there is everybody's.",
    workspace,
  })
  return (
    <View
      testID="space-choice"
      style={{ width: "100%", maxWidth: 440, alignSelf: "center", gap: 12, padding: 16 }}
    >
      <T step="base" style={{ color: c.text }}>
        {t(`sharing.choice.${kind}.title`, { defaultValue: "Where should this terminal run?" })}
      </T>
      <View
        accessibilityRole="radiogroup"
        style={{ gap: 4, padding: 4, borderRadius: 12, borderWidth: 1, borderColor: c.border }}
      >
        <View testID="space-choice-personal" accessibilityRole="radio" aria-checked={space === "personal"}>
          <OptionRow
            on={space === "personal"}
            title={t("sharing.personal", { defaultValue: "Personal" })}
            sub={t(`sharing.choice.${kind}.personal`, {
              defaultValue: "Your own machine and home: your logins stay yours. Only you see this terminal.",
            })}
            onPress={() => setSpace("personal")}
          />
        </View>
        <View
          testID="space-choice-shared"
          accessibilityRole="radio"
          aria-checked={space === "shared"}
          aria-disabled={sharedDisabled ? true : undefined}
          style={{ opacity: sharedDisabled ? 0.6 : 1 }}
        >
          <OptionRow
            on={space === "shared"}
            title={t("sharing.shared", { defaultValue: "Shared" })}
            sub={sharedNote ? `${sharedSub} ${sharedNote}.` : sharedSub}
            onPress={sharedDisabled ? undefined : () => setSpace("shared")}
          />
        </View>
      </View>
      <Btn
        variant="primary"
        icon="terminal-window"
        onPress={() => onPick(space)}
        testID="space-choice-open"
      >
        {space === "shared"
          ? t(`sharing.choice.${kind}.openShared`, { defaultValue: "Open shared terminal" })
          : t(`sharing.choice.${kind}.openPersonal`, { defaultValue: "Open personal terminal" })}
      </Btn>
    </View>
  )
}
