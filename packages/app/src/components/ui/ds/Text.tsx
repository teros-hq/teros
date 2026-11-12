/**
 * T — the interface text steps of the OS prototype (design-testing), one
 * component. A step is size + leading + tracking + family TOGETHER (DS rule):
 *
 *   4xl 60 · 3xl 48 (34 compact) · 2xl 36 · xl 22 · hsm 18 · bserif 16   — Prody
 *   lg 18 · base 16 · sm 13 · 12 · xs 10 caps .18em · xxs 9 caps          — Saans
 *   codenote 10 mono caps · code 12 mono · code13 13 mono                 — Reddit Mono
 *
 * Tone maps to the theme text roles: text (default) · text2 · text3 · accent.
 * Weight is ALWAYS 400 — the hierarchy is the step, never bold.
 */
import React from "react"
import { Platform, Text as RNText, type TextProps, type TextStyle } from "react-native"
import { useColors } from "../../mca/primitives/useColors"
import { FONT_MONO, FONT_SANS, FONT_SERIF } from "../../mca/primitives/fonts"

export type TextStep =
  | "4xl"
  | "3xl"
  | "2xl"
  | "xl"
  | "hsm"
  | "bserif"
  | "lg"
  | "base"
  | "sm"
  | "12"
  | "xs"
  | "xxs"
  | "codenote"
  | "code"
  | "code13"

export type TextTone = "text" | "text2" | "text3" | "accent" | "inherit" | "danger" | "inkPill"

export const STEP_STYLES: Record<TextStep, TextStyle> = {
  "4xl": { fontFamily: FONT_SERIF, fontSize: 60, lineHeight: 63, letterSpacing: -0.6 },
  "3xl": { fontFamily: FONT_SERIF, fontSize: 34, lineHeight: 38, letterSpacing: -0.34 },
  "2xl": { fontFamily: FONT_SERIF, fontSize: 36, lineHeight: 40, letterSpacing: -0.36 },
  xl: { fontFamily: FONT_SERIF, fontSize: 22, lineHeight: 26, letterSpacing: 0.44 },
  hsm: { fontFamily: FONT_SERIF, fontSize: 18, lineHeight: 25, letterSpacing: 0.36 },
  bserif: { fontFamily: FONT_SERIF, fontSize: 16, lineHeight: 24 },
  lg: { fontFamily: FONT_SANS, fontSize: 18, lineHeight: 25 },
  base: { fontFamily: FONT_SANS, fontSize: 16, lineHeight: 24 },
  sm: { fontFamily: FONT_SANS, fontSize: 13, lineHeight: 18 },
  "12": { fontFamily: FONT_SANS, fontSize: 12, lineHeight: 16 },
  xs: {
    fontFamily: FONT_SANS,
    fontSize: 10,
    lineHeight: 12,
    letterSpacing: 1.8,
    textTransform: "uppercase",
  },
  xxs: {
    fontFamily: FONT_SANS,
    fontSize: 9,
    lineHeight: 9,
    letterSpacing: 0.9,
    textTransform: "uppercase",
  },
  codenote: {
    fontFamily: FONT_MONO,
    fontSize: 10,
    lineHeight: 12,
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  code: { fontFamily: FONT_MONO, fontSize: 12, lineHeight: 16 },
  code13: { fontFamily: FONT_MONO, fontSize: 13, lineHeight: 16 },
}

export interface TProps extends TextProps {
  step?: TextStep
  tone?: TextTone
  /** Override the colour directly (wins over `tone`). */
  color?: string
  /** Single-line ellipsis shortcut (`numberOfLines={1}`). */
  ellipsis?: boolean
  center?: boolean
  children?: React.ReactNode
}

export function T({ step = "sm", tone = "text", color, ellipsis, center, style, ...rest }: TProps) {
  const c = useColors()
  const toneColor =
    color ??
    (tone === "inherit"
      ? undefined
      : tone === "accent"
        ? c.accent
        : tone === "danger"
          ? c.tint.r.tx
          : tone === "inkPill"
            ? c.inkPillText
            : c[tone])
  return (
    <RNText
      {...rest}
      numberOfLines={ellipsis ? 1 : rest.numberOfLines}
      style={[
        STEP_STYLES[step],
        { fontWeight: "400" },
        toneColor ? { color: toneColor } : null,
        center ? { textAlign: "center" } : null,
        Platform.OS === "web" ? ({ wordBreak: "break-word" } as any) : null,
        style,
      ]}
    />
  )
}

/** Serif headline with the prototype's violet highlight on one word:
 *  `<Headline text="Todo lo que habéis hablado." accent="hablado." />` */
export function Headline({
  text,
  accent,
  step = "3xl",
}: {
  text: string
  accent?: string
  step?: TextStep
}) {
  if (!accent || !text.includes(accent)) return <T step={step}>{text}</T>
  const [before, after] = text.split(accent)
  return (
    <T step={step}>
      {before}
      <T step={step} tone="accent">
        {accent}
      </T>
      {after}
    </T>
  )
}
