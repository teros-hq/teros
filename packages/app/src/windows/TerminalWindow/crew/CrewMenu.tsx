/**
 * The header's ⋯ menu (dark, like the rest of the crew chrome): Float, Take
 * the wheel, the crew's side, terminal options, end the session.
 */

import { useEffect } from "react"
import { Platform, Pressable, Text, View } from "react-native"
import { Ph } from "../../../components/ui/ds"
import { css } from "./crewMotion"
import { SANS, useK } from "./tokens"

export type CrewMenuEntry =
  | "separator"
  | { header: string }
  | {
      key: string
      icon: string
      label: string
      kbd?: string
      checked?: boolean
      danger?: boolean
      disabled?: boolean
      /** Keep the menu open after the press (a confirm step). */
      keepOpen?: boolean
      onPress: () => void
    }

export function CrewMenu({
  entries,
  footer,
  onClose,
  anchor,
  testID = "crew-menu-panel",
}: {
  entries: CrewMenuEntry[]
  footer?: string
  onClose: () => void
  /** Where the panel sits (default: under the header's ⋯, top right). */
  anchor?: object
  testID?: string
}) {
  const K = useK()
  useEffect(() => {
    if (Platform.OS !== "web") return
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    window.addEventListener("keydown", esc)
    return () => window.removeEventListener("keydown", esc)
  }, [onClose])
  return (
    <>
      <Pressable
        onPress={onClose}
        style={[
          {
            position: (anchor ? "fixed" : "absolute") as "absolute",
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
            zIndex: 34,
          },
          css({ cursor: "default" }),
        ]}
        testID="crew-menu-scrim"
      />
      <View
        style={[
          {
            position: "absolute",
            ...(anchor ?? { right: 8, top: 40 }),
            zIndex: 35,
            width: 248,
            padding: 6,
            borderRadius: 12,
            backgroundColor: K.card,
          },
          css({
            boxShadow: `${K.shadowCard}, inset 0 0 0 1px ${K.cardLine}`,
            animation: "crew-pop-in 120ms ease-out",
          }),
        ]}
        testID={testID}
      >
        {entries.map((e, i) => {
          if (e === "separator")
            return (
              <View
                key={`s${i}`}
                style={{
                  height: 1,
                  backgroundColor: K.cardSep,
                  marginVertical: 5,
                  marginHorizontal: 2,
                }}
              />
            )
          if ("header" in e)
            return (
              <Text
                key={`h${i}`}
                style={{
                  fontFamily: SANS,
                  fontSize: 10,
                  letterSpacing: 1,
                  textTransform: "uppercase",
                  color: K.dim2,
                  fontWeight: "600",
                  paddingTop: 6,
                  paddingBottom: 3,
                  paddingHorizontal: 8,
                }}
              >
                {e.header}
              </Text>
            )
          const color = e.danger ? K.dangerText : e.checked ? K.menuChecked : K.menuText
          return (
            <Pressable
              key={e.key}
              disabled={e.disabled}
              onPress={() => {
                e.onPress()
                if (!e.keepOpen) onClose()
              }}
              style={({ hovered }: any) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 9,
                minHeight: 30,
                paddingHorizontal: 8,
                borderRadius: 7,
                backgroundColor: hovered ? K.menuHover : "transparent",
                opacity: e.disabled ? 0.45 : 1,
              })}
              testID={`crew-menu-${e.key}`}
            >
              <Ph name={e.icon} size={13} color={color} />
              <Text
                numberOfLines={1}
                style={{
                  flex: 1,
                  fontFamily: SANS,
                  fontSize: 12.5,
                  color,
                  fontWeight: e.checked ? "500" : "400",
                }}
              >
                {e.label}
              </Text>
              {e.checked ? (
                <Text style={{ color: K.success, fontWeight: "700", fontSize: 12 }}>✓</Text>
              ) : null}
              {e.kbd ? (
                <Text style={{ fontFamily: "Reddit Mono", fontSize: 10.5, color: K.dim2 }}>
                  {e.kbd}
                </Text>
              ) : null}
            </Pressable>
          )
        })}
        {footer ? (
          <Text
            numberOfLines={2}
            style={{
              fontFamily: SANS,
              fontSize: 11,
              color: K.dim2,
              paddingHorizontal: 8,
              paddingTop: 6,
              paddingBottom: 2,
            }}
          >
            {footer}
          </Text>
        ) : null}
      </View>
    </>
  )
}
