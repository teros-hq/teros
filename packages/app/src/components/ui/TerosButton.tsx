/**
 * TerosButton - Native fallback (iOS/Android).
 *
 * The DS engine (wandering blur, smoke, travelling ink) is pure DOM -
 * filter: blur(), radial masks, background-clip: text - none of it exists
 * in RN native. This fallback keeps the DS GEOMETRY (control scale heights,
 * pill radius, inkFor contrast rule) via the token bridge, and trades the
 * hover effects for a simple press tint.
 *
 * Same props as the web port so callers never branch on Platform. Native
 * callers pass onPress; the web port takes onClick.
 */

import React from 'react'
import { Button, Text } from 'tamagui'
import { palette, control, inkFor, buttonEngine } from './teros-tokens'

export type ButtonTheme = 'light' | 'dark'
export type ButtonVariant = 'primary' | 'secondary'
export type ButtonTone = 'violet' | 'mint' | 'ink'
export type ButtonFill = 'violet' | 'mint'
export type ButtonSize = keyof typeof buttonEngine.sizes

export interface TerosButtonProps {
  theme?: ButtonTheme
  variant?: ButtonVariant
  tone?: ButtonTone
  fill?: ButtonFill
  size?: ButtonSize
  label?: string
  /** Phosphor icon name - drawn with the web font on web; unused on native. */
  icon?: string
  onPress?: () => void
  fx?: unknown
  ariaLabel?: string
  disabled?: boolean
  loading?: boolean
  /** App extension: stretch to fill the parent row (onboarding CTA). */
  block?: boolean
  /** Test id, forwarded to the Tamagui Button (the app test convention). */
  testID?: string
}

// Pill + ink per tone, mirroring the web port tables (TONE/FILL/STATE).
// The ink is never chosen here - it is inkFor, the far end of the pill's own
// family, the same rule the palette page puts on its swatches.
const withInk = (pill: string) => ({ pill, ink: inkFor(pill) })

type ToneEntry = { light: { pill: string; ink: string }; dark: { pill: string; ink: string } }
const TONE: Record<ButtonTone, ToneEntry> = {
  // Holds the same violet in both themes - it does not invert.
  violet: { light: withInk(palette.purple['300']), dark: withInk(palette.purple['300']) },
  // Does NOT invert either: Mint/200 holds on either page.
  mint: { light: withInk(palette.mint['200']), dark: withInk(palette.mint['200']) },
  // Inverts against the page: dark pill on a light page, bone on a dark one.
  ink: { light: withInk(palette.main['900']), dark: withInk(palette.main['200']) },
}

// What a filling button fills WITH - independent of the pill it starts from.
// The ink travels with the fill so the text stays readable on top of it.
const FILL: Record<ButtonFill, { color: string; ink: string }> = {
  violet: { color: palette.purple['300'], ink: inkFor(palette.purple['300']) },
  mint: { color: palette.mint['200'], ink: inkFor(palette.mint['200']) },
}

// Disabled: the one place the pair rule is wrong (read me, do not reach for
// me). Pill ONE STEP OFF THE SURFACE, per theme. No opacity - a disabled
// button is a colour.
const STATE = {
  disabled: {
    light: { pill: palette.main['300'], ink: palette.main['500'] },
    dark: { pill: palette.main['700'], ink: palette.main['500'] },
  },
} as const

// Text step per size (buttonEngine.sizes[size].text -> ui step size in px).
const TEXT_PX: Record<ButtonSize, number> = { xs: 11, sm: 13, md: 16, lg: 18 }

export function TerosButton({
  theme = 'light',
  variant = 'primary',
  tone = 'violet',
  fill,
  size = 'md',
  label,
  icon,
  onPress,
  disabled = false,
  loading = false,
  block = false,
  ariaLabel,
  testID,
}: TerosButtonProps) {
  const s = control[size]
  const iconOnly = !label

  // Pill + ink: disabled replaces the pill (one step off the surface);
  // otherwise the tone decides, and a secondary shows the fill's colour
  // only once filled - on native there is no fill, so a secondary keeps
  // its tone pill and the fill only contributes the ink it WOULD land on.
  const t = disabled ? STATE.disabled[theme] : TONE[tone][theme]
  const pill = t.pill
  const ink = disabled ? t.ink : variant === 'secondary' && fill ? FILL[fill].ink : t.ink

  // Press = tint: one step deeper into the pill's own family. Simple,
  // honest, and the only feedback touch has.
  const pressPill = inkFor(pill)

  return (
    <Button
      testID={testID}
      aria-label={ariaLabel ?? (iconOnly && icon ? icon.replace(/-/g, ' ') : undefined)}
      height={s.h}
      width={block ? '100%' : iconOnly ? s.h : undefined}
      paddingHorizontal={iconOnly ? 0 : s.padX}
      borderRadius={s.h / 2}
      backgroundColor={pill}
      color={ink}
      fontWeight="400"
      fontSize={TEXT_PX[size]}
      pressStyle={{ backgroundColor: pressPill, scale: 0.97 }}
      disabled={disabled || loading}
      onPress={disabled || loading ? undefined : onPress}
    >
      {loading ? (
        <Text color={ink} fontSize={TEXT_PX[size]}>
          ...
        </Text>
      ) : (
        label
      )}
    </Button>
  )
}

export default TerosButton
