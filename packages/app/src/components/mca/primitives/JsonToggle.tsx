/**
 * JsonToggle — the prototype's "Ver JSON" disclosure (`.tc-json-toggle` +
 * `.tc-json`): a small text3 toggle (accent on hover) that reveals the raw
 * value as mono 12 inside a step card (radius 10, hairline, max 240px).
 *
 * Collapsed by default: the key/value list above it is the readable view; the
 * JSON is the escape hatch for a reviewer who wants the exact payload.
 */
import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { Platform, Pressable, ScrollView } from "react-native"
import { YStack } from "tamagui"
import { T } from "../../ui/ds/Text"
import { Code } from "./icons"
import { useColors } from "./useColors"

export function JsonToggle({ value, testID }: { value: unknown; testID?: string }) {
  const c = useColors()
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [hover, setHover] = useState(false)

  const json = useMemo(() => {
    try {
      return JSON.stringify(value, null, 2) ?? ""
    } catch {
      return String(value)
    }
  }, [value])

  if (!json) return null
  const fg = hover ? c.accent : c.text3

  return (
    <YStack gap={8} alignSelf="stretch">
      <Pressable
        onPress={() => setOpen((prev) => !prev)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        testID={testID}
        {...(Platform.OS === "web"
          ? { onHoverIn: () => setHover(true), onHoverOut: () => setHover(false) }
          : {})}
        style={[
          { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start" },
          Platform.OS === "web" ? ({ cursor: "pointer" } as any) : null,
        ]}
      >
        <Code size={11} color={fg} />
        <T step="12" color={fg}>
          {open
            ? t("mca.toolCall.hideJson", { defaultValue: "Hide JSON" })
            : t("mca.toolCall.viewJson", { defaultValue: "View JSON" })}
        </T>
      </Pressable>
      {open ? (
        <ScrollView
          style={{
            maxHeight: 240,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: c.border,
            backgroundColor: c.bgStep,
          }}
          nestedScrollEnabled
        >
          <T
            step="code"
            tone="text2"
            selectable
            style={{ paddingVertical: 10, paddingHorizontal: 12, lineHeight: 18 }}
          >
            {json}
          </T>
        </ScrollView>
      ) : null}
    </YStack>
  )
}
