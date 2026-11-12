/**
 * Select — an accessible, cross-native select control (NO raw HTML `<select>`).
 *
 * A `SelectField`-looking trigger (36px, radius 10, field fill, caret) that
 * opens a popover card listing the options as `OptionRow`-like rows:
 * `role="button"` + `aria-haspopup="listbox"` / `aria-expanded` on the trigger,
 * `role="listbox"` on the panel and `role="option"` + `aria-selected` on each
 * row. Keyboard: Enter/Space toggle + select, Esc closes. Colours come from
 * `useColors()` (light + dark).
 *
 * The panel renders through a Tamagui Popover (same pattern as SharePopover):
 * it PORTALS above the window pane, so it can never be clipped by the pane's
 * `overflow:hidden` or buried under later siblings — an inline absolute panel
 * did exactly that inside the Automate form (its ScrollView + the tiling pane
 * clip everything that sticks out, whatever z-index the panel carries). The
 * popover anchors to the trigger, flips up when there is no room below,
 * clamps to the viewport and scrolls long lists.
 *
 * The trigger is wrapped in `Popover.Anchor` (NOT `Popover.Trigger`): the open
 * state is fully controlled here, and Tamagui's own trigger composes an extra
 * `onOpenToggle` that would double-toggle a controlled press. Outside presses
 * and Esc still reach us through `onOpenChange`.
 *
 * Shared by the Automate pickers AND the billing pickers (provider config /
 * team). testID contract (kept identical so the tests stay green): the
 * trigger is `testID`, each option `${testID}-opt-${key}`.
 */

import { useState } from "react"
import { Platform, Pressable } from "react-native"
import { Popover } from "tamagui"
import { useColors } from "../../components/mca/primitives/useColors"
import { Ph, T } from "../../components/ui/ds"

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

type KeyEvt = { key: string; preventDefault: () => void }

export function Select({
  testID,
  value,
  options,
  onChange,
  minWidth = 130,
  ariaLabel,
}: SelectProps) {
  const c = useColors()
  const [open, setOpen] = useState(false)
  const [hover, setHover] = useState(false)
  const current = options.find((o) => o.key === value) ?? options[0]

  const pick = (key: string) => {
    onChange(key)
    setOpen(false)
  }

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      placement="bottom-start"
      offset={6}
      allowFlip
      resize
    >
      <Popover.Anchor>
        <Pressable
          testID={testID}
          onPress={() => setOpen((o) => !o)}
          {...(Platform.OS === "web"
            ? { onHoverIn: () => setHover(true), onHoverOut: () => setHover(false) }
            : {})}
          {...({
            role: "button",
            tabIndex: 0,
            "aria-haspopup": "listbox",
            "aria-expanded": open,
            "aria-label": ariaLabel,
            onKeyDown: (e: KeyEvt) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault()
                setOpen((o) => !o)
              } else if (e.key === "Escape") {
                setOpen(false)
              }
            },
          } as Record<string, unknown>)}
          style={[
            {
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              height: 36,
              minWidth,
              paddingHorizontal: 14,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: open ? c.borderAccentStrong : hover ? c.borderStrong : c.border,
              backgroundColor: c.field,
            },
            Platform.OS === "web"
              ? ({ cursor: "pointer", transition: "border-color 0.2s" } as any)
              : null,
          ]}
        >
          <T step="sm" ellipsis style={{ flex: 1 }}>
            {current?.label ?? ""}
          </T>
          <Ph name={open ? "caret-up" : "caret-down"} size={13} color={c.text3} />
        </Pressable>
      </Popover.Anchor>
      <Popover.Content
        minWidth={minWidth}
        padding={4}
        borderRadius={12}
        borderWidth={1}
        borderColor={c.border}
        backgroundColor={c.bgStep}
        enterStyle={{ opacity: 0, y: -4, scale: 0.98 }}
        exitStyle={{ opacity: 0, y: -4, scale: 0.98 }}
        {...(Platform.OS === "web" ? ({ style: { boxShadow: c.elevRaised } } as any) : {})}
        {...({ role: "listbox", "aria-label": ariaLabel } as Record<string, unknown>)}
      >
        <Popover.ScrollView
          style={{ maxHeight: 320 }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {options.map((o) => (
            <Option
              key={o.key}
              testID={`${testID}-opt-${o.key}`}
              label={o.label}
              selected={o.key === value}
              onPick={() => pick(o.key)}
            />
          ))}
        </Popover.ScrollView>
      </Popover.Content>
    </Popover>
  )
}

function Option({
  testID,
  label,
  selected,
  onPick,
}: {
  testID: string
  label: string
  selected: boolean
  onPick: () => void
}) {
  const c = useColors()
  const [hover, setHover] = useState(false)
  return (
    <Pressable
      testID={testID}
      onPress={onPick}
      {...(Platform.OS === "web"
        ? { onHoverIn: () => setHover(true), onHoverOut: () => setHover(false) }
        : {})}
      {...({
        role: "option",
        tabIndex: 0,
        "aria-selected": selected,
        onKeyDown: (e: KeyEvt) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            onPick()
          }
        },
      } as Record<string, unknown>)}
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          paddingVertical: 8,
          paddingHorizontal: 10,
          borderRadius: 8,
          backgroundColor: selected ? c.navActive : hover ? c.wash : "transparent",
        },
        Platform.OS === "web" ? ({ cursor: "pointer", whiteSpace: "nowrap" } as any) : null,
      ]}
    >
      <T step="sm" color={selected ? c.accent : c.text} numberOfLines={1} style={{ flex: 1 }}>
        {label}
      </T>
      {selected ? <Ph name="check" size={12} color={c.accent} /> : null}
    </Pressable>
  )
}
