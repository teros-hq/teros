/**
 * Extra keys bar (Termux-style) for touch devices: keys a phone keyboard
 * lacks, plus sticky Ctrl / Alt applied to the next key typed.
 */

import { useRef } from "react"
import { Platform, Pressable, ScrollView } from "react-native"
import { useColors } from "../../components/mca/primitives/useColors"
import { T } from "../../components/ui/ds"
import { isTouchPress } from "./terminalLayout"

interface ExtraKey {
  label: string
  /** Bytes sent to the terminal */
  seq: string
  /** Modifier toggle (applies to the next keystroke) instead of a key */
  modifier?: "ctrl" | "alt"
}

const EXTRA_KEYS: ExtraKey[] = [
  { label: "Esc", seq: "\x1b" },
  { label: "Tab", seq: "\t" },
  { label: "Ctrl", seq: "", modifier: "ctrl" },
  { label: "Alt", seq: "", modifier: "alt" },
  { label: "↑", seq: "\x1b[A" },
  { label: "↓", seq: "\x1b[B" },
  { label: "←", seq: "\x1b[D" },
  { label: "→", seq: "\x1b[C" },
  { label: "⇧⏎", seq: "\x1b[13;2u" },
  { label: "^C", seq: "\x03" },
  { label: "Home", seq: "\x1b[H" },
  { label: "End", seq: "\x1b[F" },
  { label: "PgUp", seq: "\x1b[5~" },
  { label: "PgDn", seq: "\x1b[6~" },
  { label: "|", seq: "|" },
  { label: "~", seq: "~" },
  { label: "/", seq: "/" },
  { label: "-", seq: "-" },
]

interface Props {
  ctrl: boolean
  alt: boolean
  bottomInset: number
  onKey: (seq: string) => void
  onModifier: (modifier: "ctrl" | "alt") => void
}

export function ExtraKeysBar({ ctrl, alt, bottomInset, onKey, onModifier }: Props) {
  const c = useColors()
  const sentOnTouch = useRef(false)
  const press = (key: ExtraKey) => (key.modifier ? onModifier(key.modifier) : onKey(key.seq))
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{
        flexGrow: 0,
        flexShrink: 0,
        borderTopWidth: 1,
        borderTopColor: c.border,
        backgroundColor: c.bgSheet,
        marginBottom: bottomInset,
      }}
      contentContainerStyle={{ paddingHorizontal: 4, paddingVertical: 4, gap: 4 }}
      keyboardShouldPersistTaps="always"
      testID="terminal-extra-keys"
    >
      {EXTRA_KEYS.map((key) => {
        const active = (key.modifier === "ctrl" && ctrl) || (key.modifier === "alt" && alt)
        return (
          <Pressable
            key={key.label}
            onPress={() => {
              if (sentOnTouch.current) {
                sentOnTouch.current = false
                return
              }
              press(key)
            }}
            // Keep focus (and the virtual keyboard) on the terminal.
            onPressIn={
              Platform.OS === "web"
                ? (e: any) => {
                    e.preventDefault()
                    sentOnTouch.current = isTouchPress(e?.nativeEvent)
                    if (sentOnTouch.current) press(key)
                  }
                : undefined
            }
            tabIndex={-1}
            focusable={false}
            style={({ pressed }) => ({
              paddingHorizontal: 10,
              paddingVertical: 6,
              borderRadius: 6,
              backgroundColor: active ? c.navActive : pressed ? c.nestHover : c.field,
              borderWidth: 1,
              borderColor: active ? c.borderAccent : c.border,
              userSelect: "none",
            })}
          >
            <T step="code" style={{ color: active ? c.accent : c.text2, fontSize: 12 }}>
              {key.label}
            </T>
          </Pressable>
        )
      })}
    </ScrollView>
  )
}
