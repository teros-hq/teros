/**
 * To Do palette — the approved mock's tokens (design-testing/proto-arbol/
 * todo-window, v3) per theme. Most equal the app's `useColors()` roles; the
 * few the app lacks (a card one step above the dark sheet, the light "step"
 * fill, progress washes, status text tints) live here so the windows match
 * the mock exactly in light AND dark.
 */
import { useMemo } from "react"
import { useMcaTheme } from "../../../components/mca/primitives/useColors"
import { FONT_MONO, FONT_SANS, FONT_SERIF } from "../../../components/mca/primitives/fonts"

export const F = { serif: FONT_SERIF, sans: FONT_SANS, mono: FONT_MONO }

/** Task state colours (dots, bars, legends, chips). Same in both themes (Pablo, 2026-10-24). */
const STATE_LIGHT = {
  planning: "#A9A3B8",
  pending: "#3B82F6",
  working: "#F59E0B",
  blocked: "#EF4444",
  review: "#9C6BFF",
  done: "#1CA24D",
  // cancelled (Pablo, 2026-10-30): the grey twin of done — same treatment
  // (dot + dimmed text) with the design system's quiet grey (text3).
  cancelled: "#968FA7",
}

/** The two token sets, exported for tests (TODORF-AC-1). */
export const light = {
  dark: false,
  st: STATE_LIGHT as Record<"planning" | "pending" | "working" | "blocked" | "review" | "done" | "cancelled", string>,
  sheet: "#FAF9FC",
  card: "#FFFFFF",
  step: "#F2F0F7",
  wash: "rgba(207,197,226,0.18)",
  wash2: "rgba(207,197,226,0.32)",
  navActive: "rgba(111,39,255,0.09)",
  tile: "rgba(111,39,255,0.12)",
  border: "rgba(229,223,239,0.7)",
  borderStrong: "#E5DFEF",
  controlBg: "#CFC5E2",
  text: "#342F3D",
  text2: "#575263",
  text3: "#968FA7",
  txs: "#797386",
  doneTx: "#B0ABB9",
  accent: "#6F27FF",
  priBg: "#6F27FF",
  purple200: "#9C6BFF",
  mint: "#1EFFCE",
  mintInk: "#003E31",
  green: "#1CA24D",
  progBg: "rgba(28,162,77,0.10)",
  progWorking: "rgba(245,158,11,0.10)",
  progPending: "rgba(59,130,246,0.10)",
  progBlocked: "rgba(239,68,68,0.10)",
  progFull: "rgba(28,162,77,0.15)",
  progRev: "rgba(156,107,255,0.16)",
  gTx: "#1CA24D",
  rBg: "#FEE2E2",
  rTx: "#D92D20",
  iBg: "#E7DCFF",
  iTx: "#6F27FF",
  ring: "rgba(156,107,255,0.28)",
  ringFocus: "rgba(111,39,255,0.35)",
  ringGlow: "rgba(156,107,255,0.12)",
  cardShadow: "0 1px 2px rgba(52,47,61,.04), 0 12px 24px -16px rgba(111,39,255,.18)",
  sheetShadow: "0 1px 2px rgba(52,47,61,.04), 0 0 0 1px rgba(229,223,239,.6)",
  liftSm: "0 12px 24px -16px rgba(111,39,255,.30)",
  elevRaised: "0 0 10px -7px rgba(52,47,61,.16), 0 24px 56px -12px rgba(52,47,61,.26)",
  cloud: "color-mix(in srgb,#968FA7 70%,#6F27FF)",
  cloudBlur: 40,
  cloudOpacity: 0.2,
  scrim: "rgba(23,19,30,0.66)",
  onScrim: "#FAF9FC",
  paper: "#FFFFFF",
  paperInk: "#201C27",
}

export type TodoTokens = typeof light

export const dark: TodoTokens = {
  ...light,
  dark: true,
  st: { ...STATE_LIGHT },
  sheet: "#17131E",
  card: "#1C1823",
  step: "#221E2A",
  wash: "rgba(250,249,252,0.04)",
  wash2: "rgba(250,249,252,0.07)",
  navActive: "rgba(156,107,255,0.13)",
  tile: "rgba(156,107,255,0.14)",
  border: "rgba(250,249,252,0.05)",
  borderStrong: "rgba(250,249,252,0.09)",
  controlBg: "#575263",
  text: "#FAF9FC",
  text2: "#CFC5E2",
  text3: "#968FA7",
  txs: "#968FA7",
  doneTx: "#656076",
  accent: "#9C6BFF",
  progBg: "rgba(28,162,77,0.13)",
  progWorking: "rgba(245,158,11,0.13)",
  progPending: "rgba(59,130,246,0.13)",
  progBlocked: "rgba(239,68,68,0.14)",
  progFull: "rgba(28,162,77,0.15)",
  progRev: "rgba(156,107,255,0.2)",
  gTx: "#86E0A5",
  rBg: "rgba(239,68,68,0.10)",
  rTx: "#FFB4B4",
  iBg: "rgba(156,107,255,0.18)",
  iTx: "#E7DCFF",
  ring: "rgba(111,39,255,0.28)",
  ringGlow: "rgba(111,39,255,0.12)",
  cardShadow: "0 1px 2px rgba(0,0,0,.2), 0 12px 24px -16px rgba(0,0,0,.4)",
  sheetShadow: "0 0 0 1px rgba(250,249,252,.045)",
  liftSm: "0 12px 26px -16px rgba(111,39,255,.4)",
  elevRaised: "0 0 10px -7px rgba(0,0,0,.4), 0 24px 56px -12px rgba(0,0,0,.6)",
  cloud: "#6F27FF",
  cloudBlur: 60,
  cloudOpacity: 0.375,
}

export function useTd(): TodoTokens {
  const theme = useMcaTheme()
  return useMemo(() => (theme === "light" ? light : dark), [theme])
}
