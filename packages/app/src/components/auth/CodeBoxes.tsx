/**
 * CodeBoxes — the emailed 6-digit code as six boxes.
 *
 * One real TextInput lies invisible over six drawn boxes, so the platform's
 * own typing, paste, autofill ("one-time-code") and Backspace all work the
 * way they do in any field; the boxes only render the digits. Whatever lands
 * in the input is reduced to its first six digits, so pasting "123 456" or a
 * whole sentence from the email still fills the boxes.
 *
 * `onComplete` fires once each time the sixth digit arrives.
 *
 * @spec PWR-REQ-7
 */
import React from "react"
import { Platform, TextInput, View } from "react-native"
import { colors as semantic } from "../mca/primitives/colors"
import { FONT_MONO } from "../mca/primitives/fonts"
import { useColors } from "../mca/primitives/useColors"
import { T } from "../ui/ds"
import { codeFromInput, RESET_CODE_LENGTH } from "../../services/passwordRules"

export interface CodeBoxesProps {
  value: string
  onChange: (code: string) => void
  /** Called with the full code when its last digit is entered or pasted. */
  onComplete?: (code: string) => void
  /** Red boxes (the server rejected the code). */
  error?: boolean
  /** Green boxes (the server accepted the code). */
  ok?: boolean
  disabled?: boolean
  autoFocus?: boolean
  inputRef?: React.Ref<TextInput>
  /** Accessible name of the field. */
  label: string
  testID?: string
}

const BOX_HEIGHT = 56

export function CodeBoxes({
  value,
  onChange,
  onComplete,
  error,
  ok,
  disabled,
  autoFocus,
  inputRef,
  label,
  testID,
}: CodeBoxesProps) {
  const c = useColors()
  const [focus, setFocus] = React.useState(false)

  // Password managers (1Password, LastPass, Bitwarden) draw their icon inside
  // any field they think they can fill; here it lands on top of the last box.
  // An emailed code is nothing they hold, so tell them to leave the field alone.
  const setInput = React.useCallback(
    (node: TextInput | null) => {
      if (Platform.OS === "web" && node) {
        const el = node as unknown as HTMLElement
        el.setAttribute?.("data-1p-ignore", "true")
        el.setAttribute?.("data-lpignore", "true")
        el.setAttribute?.("data-bwignore", "true")
        el.setAttribute?.("data-form-type", "other")
      }
      if (typeof inputRef === "function") inputRef(node)
      else if (inputRef) (inputRef as React.MutableRefObject<TextInput | null>).current = node
    },
    [inputRef],
  )
  // The box the next digit goes into (the last one when the code is full).
  const active = Math.min(value.length, RESET_CODE_LENGTH - 1)

  const handleChange = (text: string) => {
    const next = codeFromInput(text)
    if (next === value) return
    onChange(next)
    if (next.length === RESET_CODE_LENGTH) onComplete?.(next)
  }

  return (
    <View style={{ position: "relative", opacity: disabled ? 0.6 : 1 }}>
      <View style={{ flexDirection: "row", gap: 8 }} pointerEvents="none">
        {Array.from({ length: RESET_CODE_LENGTH }).map((_, i) => {
          const current = focus && i === active
          return (
            <View
              key={i}
              testID={testID ? `${testID}-box-${i}` : undefined}
              style={[
                {
                  flex: 1,
                  minWidth: 0,
                  height: BOX_HEIGHT,
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: 12,
                  borderWidth: 1.5,
                  borderColor: error
                    ? semantic.red
                    : ok
                      ? semantic.green
                      : current
                        ? "rgba(111,39,255,0.6)"
                        : c.border,
                  backgroundColor: c.field,
                },
                Platform.OS === "web"
                  ? ({
                      transition: "border-color 0.15s, box-shadow 0.15s",
                      boxShadow: current && !error ? "0 0 0 3px rgba(111,39,255,0.12)" : "none",
                    } as any)
                  : null,
              ]}
            >
              <T style={{ fontFamily: FONT_MONO, fontSize: 24, lineHeight: 30 }}>
                {value[i] ?? ""}
              </T>
            </View>
          )
        })}
      </View>

      <TextInput
        ref={setInput}
        value={value}
        onChangeText={handleChange}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        editable={!disabled}
        autoFocus={autoFocus}
        keyboardType="number-pad"
        inputMode="numeric"
        autoComplete="one-time-code"
        textContentType="oneTimeCode"
        autoCorrect={false}
        caretHidden
        accessibilityLabel={label}
        testID={testID}
        style={[
          {
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: BOX_HEIGHT,
            opacity: 0,
            // 16px keeps iOS Safari from zooming the page on focus.
            fontSize: 16,
          },
          Platform.OS === "web" ? ({ outlineStyle: "none", cursor: "text" } as any) : null,
        ]}
      />
    </View>
  )
}
