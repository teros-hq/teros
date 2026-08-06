/**
 * Select — an accessible, cross-native select control (NO raw HTML `<select>`).
 *
 * A button that toggles a listbox popover: `role="button"` +
 * `aria-haspopup="listbox"` / `aria-expanded` on the trigger, `role="listbox"`
 * on the panel and `role="option"` + `aria-selected` on each row. Keyboard:
 * Enter/Space toggle + select, Esc closes. Colours are monitoring tokens only.
 *
 * Extracted from `UsersWindowContent`'s filter dropdown (TER-683 · PR2) so the
 * list filters AND the billing pickers (provider config / team, PR4) share ONE
 * implementation instead of a raw `<select>`. testID contract (kept identical so
 * PR2 tests stay green): the trigger is `testID`, each option `${testID}-opt-${key}`.
 */

import { useState } from "react"
import { Text, XStack, YStack } from "tamagui"
import { tokens } from "../../components/monitoring/colors"

export interface SelectOption {
  key: string
  label: string
}

export interface SelectProps {
  testID: string
  value: string
  options: SelectOption[]
  onChange: (key: string) => void
  /** Trigger min width (default 130). Billing pickers pass a wider value. */
  minWidth?: number
  /** Accessible name for the trigger (screen readers). */
  ariaLabel?: string
}

export function Select({
  testID,
  value,
  options,
  onChange,
  minWidth = 130,
  ariaLabel,
}: SelectProps) {
  const [open, setOpen] = useState(false)
  const current = options.find((o) => o.key === value) ?? options[0]

  return (
    <YStack position="relative">
      <XStack
        testID={testID}
        ai="center"
        gap={8}
        paddingVertical={7}
        paddingHorizontal={11}
        borderRadius={8}
        borderWidth={1}
        borderColor={open ? tokens.borderHover : tokens.border}
        backgroundColor={tokens.bgInner}
        cursor="pointer"
        minWidth={minWidth}
        hoverStyle={{ backgroundColor: tokens.bgHover }}
        onPress={() => setOpen((o) => !o)}
        {...({
          role: "button",
          tabIndex: 0,
          "aria-haspopup": "listbox",
          "aria-expanded": open,
          "aria-label": ariaLabel,
          onKeyDown: (e: { key: string; preventDefault: () => void }) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault()
              setOpen((o) => !o)
            } else if (e.key === "Escape") {
              setOpen(false)
            }
          },
        } as Record<string, unknown>)}
      >
        <Text flex={1} fontSize={13} color={tokens.textSecondary} numberOfLines={1}>
          {current?.label ?? ""}
        </Text>
        <Text fontSize={9} color={tokens.textTertiary} aria-hidden>
          ▾
        </Text>
      </XStack>
      {open ? (
        <YStack
          position="absolute"
          top={40}
          left={0}
          minWidth="100%"
          zIndex={1000}
          borderRadius={8}
          borderWidth={1}
          borderColor={tokens.borderHover}
          backgroundColor={tokens.bgPress}
          paddingVertical={4}
          {...({ role: "listbox" } as Record<string, unknown>)}
        >
          {options.map((o) => {
            const selected = o.key === value
            return (
              <XStack
                key={o.key}
                testID={`${testID}-opt-${o.key}`}
                paddingVertical={7}
                paddingHorizontal={11}
                cursor="pointer"
                backgroundColor={selected ? tokens.bgHover : "transparent"}
                hoverStyle={{ backgroundColor: tokens.bgHover }}
                onPress={() => {
                  onChange(o.key)
                  setOpen(false)
                }}
                {...({
                  role: "option",
                  tabIndex: 0,
                  "aria-selected": selected,
                  onKeyDown: (e: { key: string; preventDefault: () => void }) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault()
                      onChange(o.key)
                      setOpen(false)
                    }
                  },
                } as Record<string, unknown>)}
              >
                <Text
                  fontSize={13}
                  color={selected ? tokens.text : tokens.textSecondary}
                  numberOfLines={1}
                >
                  {o.label}
                </Text>
              </XStack>
            )
          })}
        </YStack>
      ) : null}
    </YStack>
  )
}
