/**
 * Surfaces and type of the Terminal window's chrome (spec "Superficies y
 * medidas"), per app theme. The dark set is the crew design's original
 * palette; the light set maps every role onto the design system's light
 * ramp (main100…main900, the To Do window's tokens) so the terminal looks
 * like one more Teros window in light mode (Pablo, 2026-10-31 — until then
 * the terminal stayed dark in both themes).
 *
 * Components read the active set with `useK()`; `crewTokens(theme)` is the
 * pure form for tests. `K` is the dark set, kept for callers that render
 * outside the app's theme tree.
 */

import { useMemo } from "react"
import type { Theme } from "../../../components/mca/primitives/colors"
import { FONT_MONO, FONT_SANS } from "../../../components/mca/primitives/fonts"
import { useMcaTheme } from "../../../components/mca/primitives/useColors"

export interface CrewTokens {
  // ── Surfaces ──
  rail: string
  canvas: string
  line: string
  line2: string
  slotHover: string
  card: string
  cardLine: string
  cardSep: string
  menuHover: string
  btn: string
  btnPri: string
  /** Ink on inverted surfaces (btnPri, tips, pills). */
  ink: string
  text: string
  textHi: string
  text2: string
  text3: string
  dim: string
  dim2: string
  faint: string
  needBg: string
  needBg2: string
  needLine: string
  clashBg: string
  clashBg2: string
  clashLine: string
  clashBtn: string
  // ── Accents (same in both themes unless noted) ──
  danger: string
  onDanger: string
  dangerText: string
  amber: string
  amberInk: string
  amberText: string
  success: string
  menuText: string
  menuChecked: string
  onAccent: string
  // ── Rail drag ──
  dropOver: string
  dropWash: string
  dropWashActive: string
  // ── Shadows (web box-shadow / filter strings) ──
  shadowCard: string
  shadowRail: string
  shadowTip: string
  shadowFace: string
  // ── Inputs ──
  inputBg: string
  inputText: string
  inputLine: string
  // ── Overlays ──
  scrim: string
  sheetScrim: string
  // ── Seats and faces ──
  seatDisc: string
  seatDiscIdle: string
  seatDiscNeed: string
  seatDiscClash: string
  seatWheelIdle: string
  avatarInk: string
  frozenMark: string
  // ── Extra keys bar (touch) ──
  keysBg: string
  keysLine: string
  keyBg: string
  keyPressed: string
  keyActive: string
  keyLine: string
  keyActiveLine: string
  keyText: string
  keyActiveText: string
  // ── Floating terminals ──
  floatBg: string
  floatHeaderBg: string
  floatHeaderLine: string
  floatNeedGrad: string
  floatNeedLine: string
  floatHandle: string
  floatPill: string
  floatSheetShadow: string
  floatRing: string
  floatRingKeyboard: string
  floatDrop: string
  gripInk: string
  ghostBg: string
  ghostText: string
  ghostShadow: string
  bubbleBg: string
  bubbleRing: string
  bubbleDrop: string
  bubbleLabelShadow: string
}

const DARK: CrewTokens = {
  rail: "#121017",
  canvas: "#0E0C12",
  line: "#221E2A",
  line2: "#2A2633",
  slotHover: "#1A1721",
  card: "#211D29",
  cardLine: "#3A3546",
  cardSep: "#322D3C",
  menuHover: "#2E2938",
  btn: "#2A2633",
  btnPri: "#F3EFF9",
  ink: "#1E1A26",
  text: "#E9E4F1",
  textHi: "#F3EFF9",
  text2: "#B8B1C6",
  text3: "#9C95AB",
  dim: "#8D879A",
  dim2: "#7E778C",
  faint: "#5E576E",
  needBg: "#2A1E08",
  needBg2: "#211806",
  needLine: "#4A3510",
  clashBg: "#2A1012",
  clashBg2: "#200C0E",
  clashLine: "#5A1F1F",
  clashBtn: "#3A2026",
  danger: "#E5534B",
  onDanger: "#fff",
  dangerText: "#FF8A80",
  amber: "#F2A93B",
  amberInk: "#2A1600",
  amberText: "#FFD593",
  success: "#B7F0CF",
  menuText: "#D9D2E6",
  menuChecked: "#fff",
  onAccent: "#fff",
  dropOver: "#1E1A26",
  dropWash: "rgba(233,228,241,.06)",
  dropWashActive: "rgba(233,228,241,.14)",
  shadowCard: "0 18px 40px rgba(0,0,0,.5)",
  shadowRail: "0 20px 50px rgba(0,0,0,.6)",
  shadowTip: "0 8px 20px rgba(0,0,0,.4)",
  shadowFace: "drop-shadow(0 4px 10px rgba(0,0,0,.35))",
  inputBg: "#14111A",
  inputText: "#CFC6DE",
  inputLine: "#4A4258",
  scrim: "rgba(8,6,12,.55)",
  sheetScrim: "rgba(10,8,16,.45)",
  seatDisc: "#17141D",
  seatDiscIdle: "#1A1721",
  seatDiscNeed: "#2A1E08",
  seatDiscClash: "#2A0E0E",
  seatWheelIdle: "#5E576E",
  avatarInk: "#14111A",
  frozenMark: "#A5D8FF",
  keysBg: "#16181d",
  keysLine: "rgba(255,255,255,0.08)",
  keyBg: "#262a33",
  keyPressed: "#3a3f4b",
  keyActive: "#4a6fa5",
  keyLine: "#343944",
  keyActiveLine: "#6a8fc5",
  keyText: "#c4c9d2",
  keyActiveText: "#c4c9d2",
  floatBg: "#1e2127",
  floatHeaderBg: "#1A1721",
  floatHeaderLine: "#221E2A",
  floatNeedGrad: "linear-gradient(#3A2A0C,#2A1E08)",
  floatNeedLine: "#4A3510",
  floatHandle: "#4A4258",
  floatPill: "rgba(233,228,241,.12)",
  floatSheetShadow: "0 -20px 50px rgba(10,6,30,.55)",
  floatRing:
    "0 0 0 1px rgba(255,255,255,.06) inset,0 30px 60px -18px rgba(20,8,60,.6),0 0 0 1px rgba(20,10,40,.6)",
  floatRingKeyboard:
    "0 0 0 1px rgba(255,255,255,.08) inset,0 36px 70px -18px rgba(20,8,60,.7),0 0 0 2px #E9E4F1,0 0 0 6px rgba(233,228,241,.22)",
  floatDrop: "0 30px 60px -18px rgba(20,8,60,.6)",
  gripInk: "rgba(255,255,255,.28)",
  ghostBg: "#1E1A26",
  ghostText: "#fff",
  ghostShadow: "drop-shadow(0 14px 22px rgba(20,8,60,.45))",
  bubbleBg: "#17141D",
  bubbleRing: "#2A2633",
  bubbleDrop: "0 14px 30px -6px rgba(20,8,60,.55)",
  bubbleLabelShadow: "0 8px 20px rgba(20,8,60,.3)",
}

/** Light: the design system's main ramp, same roles. */
const LIGHT: CrewTokens = {
  rail: "#F2F0F7",
  canvas: "#FAF9FC",
  line: "#E5DFEF",
  line2: "#CFC5E2",
  slotHover: "#E9E4F1",
  card: "#FFFFFF",
  cardLine: "#E5DFEF",
  cardSep: "#F2F0F7",
  menuHover: "#F2F0F7",
  btn: "#E5DFEF",
  btnPri: "#342F3D",
  ink: "#FAF9FC",
  text: "#342F3D",
  textHi: "#201C27",
  text2: "#575263",
  text3: "#797386",
  dim: "#968FA7",
  dim2: "#797386",
  faint: "#CFC5E2",
  needBg: "#FFF4DF",
  needBg2: "#FFEBC2",
  needLine: "#F2C879",
  clashBg: "#FEE2E2",
  clashBg2: "#FECACA",
  clashLine: "#F5A3A3",
  clashBtn: "#FECACA",
  danger: "#E5534B",
  onDanger: "#fff",
  dangerText: "#C2413B",
  amber: "#F2A93B",
  amberInk: "#2A1600",
  amberText: "#8A5A00",
  success: "#1CA24D",
  menuText: "#575263",
  menuChecked: "#342F3D",
  onAccent: "#fff",
  dropOver: "#E5DFEF",
  dropWash: "rgba(52,47,61,.05)",
  dropWashActive: "rgba(52,47,61,.12)",
  shadowCard: "0 18px 40px rgba(52,47,61,.18)",
  shadowRail: "0 20px 50px rgba(52,47,61,.22)",
  shadowTip: "0 8px 20px rgba(52,47,61,.18)",
  shadowFace: "drop-shadow(0 4px 10px rgba(52,47,61,.2))",
  inputBg: "#FFFFFF",
  inputText: "#342F3D",
  inputLine: "#CFC5E2",
  scrim: "rgba(52,47,61,.35)",
  sheetScrim: "rgba(52,47,61,.3)",
  seatDisc: "#FFFFFF",
  seatDiscIdle: "#F2F0F7",
  seatDiscNeed: "#FFF1D6",
  seatDiscClash: "#FEE2E2",
  seatWheelIdle: "#968FA7",
  avatarInk: "#14111A",
  frozenMark: "#3B82F6",
  keysBg: "#F2F0F7",
  keysLine: "#E5DFEF",
  keyBg: "#FFFFFF",
  keyPressed: "#E5DFEF",
  keyActive: "#6F27FF",
  keyLine: "#CFC5E2",
  keyActiveLine: "#9C6BFF",
  keyText: "#342F3D",
  keyActiveText: "#FFFFFF",
  floatBg: "#FAF9FC",
  floatHeaderBg: "#F2F0F7",
  floatHeaderLine: "#E5DFEF",
  floatNeedGrad: "linear-gradient(#FFF4DF,#FFEBC2)",
  floatNeedLine: "#F2C879",
  floatHandle: "#CFC5E2",
  floatPill: "rgba(52,47,61,.08)",
  floatSheetShadow: "0 -20px 50px rgba(52,47,61,.2)",
  floatRing:
    "0 0 0 1px rgba(52,47,61,.1) inset,0 30px 60px -18px rgba(52,47,61,.3),0 0 0 1px rgba(52,47,61,.15)",
  floatRingKeyboard:
    "0 0 0 1px rgba(52,47,61,.1) inset,0 36px 70px -18px rgba(52,47,61,.35),0 0 0 2px #342F3D,0 0 0 6px rgba(52,47,61,.18)",
  floatDrop: "0 30px 60px -18px rgba(52,47,61,.3)",
  gripInk: "rgba(52,47,61,.35)",
  ghostBg: "#342F3D",
  ghostText: "#FAF9FC",
  ghostShadow: "drop-shadow(0 14px 22px rgba(52,47,61,.3))",
  bubbleBg: "#FFFFFF",
  bubbleRing: "#E5DFEF",
  bubbleDrop: "0 14px 30px -6px rgba(52,47,61,.3)",
  bubbleLabelShadow: "0 8px 20px rgba(52,47,61,.2)",
}

/** The crew tokens of a theme (pure; what `useK()` returns). */
export function crewTokens(theme: Theme): CrewTokens {
  return theme === "light" ? LIGHT : DARK
}

/** The active theme's crew tokens. Reactive to the app theme (Tamagui). */
export function useK(): CrewTokens {
  const theme = useMcaTheme()
  return useMemo(() => crewTokens(theme), [theme])
}

/** The dark set — for code that renders outside the theme tree (and tests). */
export const K: CrewTokens = DARK

export const SANS = FONT_SANS
export const MONO = FONT_MONO

/** Rail widths and face / seat sizes, wide and narrow. */
export const RAIL = {
  wide: { w: 76, face: 40, seat: 20, gap: 4 },
  narrow: { w: 56, face: 36, seat: 18, gap: 6 },
} as const

/** Below this Terminal width the rail keeps faces only (spec "Estrecho"). */
export const NARROW_PX = 560
