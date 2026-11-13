import type { Space } from "@teros/shared"
import { useTranslation } from "react-i18next"
import { Pressable } from "react-native"
import { useColors } from "../mca/primitives/useColors"
import { Ph, T } from "../ui/ds"
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

export function tooltip(text: string | undefined) {
  return (el: unknown) => {
    const node = el as {
      setAttribute?: (name: string, value: string) => void
      removeAttribute?: (name: string) => void
    } | null
    if (text) node?.setAttribute?.("title", text)
    else node?.removeAttribute?.("title")
  }
}

export function SpaceChip({ space, detail, icon, short, hint: saidHint, onPress, testID }: Props) {
  const { t } = useTranslation()
  const c = useColors()
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
  const tint = space === "shared" ? c.tint.a : detail ? c.tint.i : null
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? "button" : "text"}
      accessibilityLabel={detail ? `${name} · ${detail}. ${hint}` : `${name}. ${hint}`}
      hitSlop={4}
      ref={tooltip(hint)}
      {...({ dataSet: { space } } as object)}
      style={{
        height: 30,
        paddingHorizontal: 8,
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        borderRadius: 8,
        flexShrink: 0,
        backgroundColor: tint ? tint.bg : "transparent",
        borderWidth: 1,
        borderColor: tint ? tint.bd : "transparent",
      }}
    >
      <Ph name={icon ?? SPACE_ICON[space]} size={16} color={tint ? tint.tx : c.text3} />
      <T step="codenote" style={{ color: tint ? tint.tx : c.text3 }}>
        {label}
      </T>
    </Pressable>
  )
}
