import type { Space } from "@teros/shared"
import { useTranslation } from "react-i18next"
import { Pressable } from "react-native"
import { Badge } from "../ui/ds"
import { SPACE_ICON } from "./sharedSpace"

interface Props {
  space: Space
  detail?: string
  icon?: string
  short?: boolean
  hint?: string
  onPress?: () => void
  testID?: string
}

export function SpaceBadge({ space, detail, icon, short, hint: saidHint, onPress, testID }: Props) {
  const { t } = useTranslation()
  const name =
    space === "shared"
      ? t("sharing.shared", { defaultValue: "Shared" })
      : t("sharing.personal", { defaultValue: "Personal" })
  const label = detail && !short ? `${name} · ${detail}` : name
  const hint =
    saidHint ??
    (space === "shared"
      ? t("sharing.sharedHint", {
          defaultValue: "The workspace's: every member with access sees it and uses it",
        })
      : t("sharing.personalHint", { defaultValue: "Yours: only you see it and use it" }))
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? "button" : "text"}
      accessibilityLabel={detail ? `${name} · ${detail}. ${hint}` : `${name}. ${hint}`}
      {...({ dataSet: { space }, title: hint } as object)}
      style={{ flexShrink: 0 }}
    >
      <Badge
        tone={space === "shared" ? "a" : detail ? "i" : "neutral"}
        icon={icon ?? SPACE_ICON[space]}
        style={{ alignSelf: "center" }}
      >
        {label}
      </Badge>
    </Pressable>
  )
}
