import { createAnimations } from "@tamagui/animations-css"
import { config } from "@tamagui/config"
import { createFont, createTamagui } from "tamagui"

// Teros Design System — Fonts (aligned with DS v0.2.6 tokens.js, relaja)
// Saans: UI / body text. Prody: display / serif. Reddit Mono: code.
// Saans/Prody are self-hosted (public/fonts/); Reddit Mono via Google Fonts.
const terosFonts = {
  ...config.fonts,
  body: createFont({
    family: "'Saans', system-ui, -apple-system, sans-serif",
    size: {
      1: 11,
      2: 12,
      3: 13,
      4: 14,
      5: 15,
      6: 16,
      7: 18,
      8: 20,
      9: 24,
      10: 28,
      11: 32,
      12: 36,
    },
    weight: {
      1: "400",
      2: "400",
      3: "400",
      4: "400",
      5: "500",
      6: "600",
    },
    letterSpacing: {
      1: 0,
      2: 0,
      3: 0,
      4: -0.01,
      5: -0.015,
      6: -0.02,
    },
    face: { 400: { normal: "Saans" }, 500: { normal: "Saans" } },
  }),
  serif: createFont({
    family: "'Prody', Georgia, serif",
    size: {
      1: 14,
      2: 18,
      3: 24,
      4: 32,
      5: 48,
      6: 64,
      7: 80,
    },
    weight: { 1: "400", 2: "400", 3: "400", 4: "400" },
    letterSpacing: { 1: -0.02, 2: -0.02, 3: -0.02 },
    face: { 400: { normal: "Prody" } },
  }),
  mono: createFont({
    family: "'Reddit Mono', 'JetBrains Mono', 'Fira Code', monospace",
    size: {
      1: 11,
      2: 12,
      3: 13,
      4: 14,
      5: 15,
      6: 16,
    },
    weight: { 1: "400", 2: "400" },
    letterSpacing: { 1: 0, 2: 0 },
    face: { 400: { normal: "Reddit Mono" } },
  }),
}

// CSS-based transitions for web (Teros runs as a PWA — Expo web target).
// Each preset is a CSS shorthand: '<easing> <duration>'. The CSS driver
// compiles them to real `transition: <prop> <easing> <duration>` decls —
// predictable, GPU-accelerated, no JS bridge involved.
const animations = createAnimations({
  // ─ Card expand/collapse — Teros signature motion.
  //   Cubic-bezier (0.34, 1.2, 0.5, 1) is a "soft overshoot" curve: it
  //   accelerates fast, slightly overshoots target (~3%), then settles.
  //   Combined with `scale` + `opacity` in enterStyle/exitStyle, it gives
  //   a perceptible "pop" without any translate that would shift layout.
  //   240ms is the threshold where motion reads as intentional design,
  //   not as lag.
  card: "cubic-bezier(0.34, 1.2, 0.5, 1) 240ms",
  // ─ Faster variant for badges, status chips, dot indicators.
  quick: "cubic-bezier(0.34, 1.2, 0.5, 1) 180ms",
  // ─ Slow ease-out-expo, no overshoot — for modals, sheets.
  medium: "cubic-bezier(0.16, 1, 0.3, 1) 320ms",
  slow: "cubic-bezier(0.16, 1, 0.3, 1) 480ms",
  // ─ Pronounced spring-like overshoot for playful entries.
  bouncy: "cubic-bezier(0.34, 1.56, 0.64, 1) 320ms",
})

// Teros Custom Themes — DS v0.2.6 (relaja): the Main ramp is the neutral
// spine, Purple is the accent (300 light / 200 dark). Surface values are
// theme-adaptive; status accents stay constant across themes.
const appConfig = createTamagui({
  ...config,
  fonts: terosFonts,
  animations,
  themes: {
    ...config.themes,
    // ── Dark — Main/900 page, Main/800 surfaces, Main/700 edges ──
    dark: {
      ...config.themes.dark,
      // OS prototype (design-testing, Oct 2026): Main/900 sheet, Main/850
      // cards one step off it, hairline borders of bone — fills separate
      // surfaces, the line only hints.
      background: "#201C27",
      backgroundHover: "#2C2836",
      backgroundPress: "#342F3D",
      backgroundFocus: "#2C2836",
      backgroundSoft: "#2C2836",
      backgroundStrong: "#342F3D",
      backgroundTransparent: "rgba(32, 28, 39, 0.85)",
      color: "#FAF9FC",
      colorHover: "#F2F0F7",
      colorPress: "#F2F0F7",
      colorFocus: "#F2F0F7",
      borderColor: "rgba(250,249,252,0.06)",
      borderColorHover: "rgba(250,249,252,0.12)",
      borderColorFocus: "#9C6BFF",
      placeholderColor: "#968FA7",

      // Accent — Purple/200 in dark (4.74:1 on Main/900)
      blue: "#9C6BFF",
      blue1: "#9C6BFF",
      blue2: "#6F27FF",
      blue3: "#6F27FF",

      // Errors — status red/300
      red: "#EF4444",
      red1: "#EF4444",
      red2: "#F87171",
      red3: "#DC2626",

      // Neutrals — Main ramp mid steps
      gray: "#968FA7",
      gray1: "#968FA7",
      gray2: "#797386",
      gray3: "#575263",
    },
    // ── Light — Main/200 page, White cards, Main/300 edges ──
    light: {
      ...config.themes.light,
      // OS prototype (design-testing, Oct 2026): Main/100 sheet, white cards
      // lifted by a violet-tinted shadow, Main/300 hairline at 55%.
      background: "#FAF9FC",
      backgroundHover: "#FFFFFF",
      backgroundPress: "#F2F0F7",
      backgroundFocus: "#FFFFFF",
      backgroundSoft: "#FFFFFF",
      backgroundStrong: "#F2F0F7",
      backgroundTransparent: "rgba(250, 249, 252, 0.85)",
      color: "#342F3D",
      colorHover: "#201C27",
      colorPress: "#201C27",
      colorFocus: "#201C27",
      borderColor: "rgba(229,223,239,0.55)",
      borderColorHover: "#E5DFEF",
      borderColorFocus: "#6F27FF",
      placeholderColor: "#968FA7",

      // Accent — Purple/300 in light (6.16:1 on White)
      blue: "#6F27FF",
      blue1: "#6F27FF",
      blue2: "#6F27FF",
      blue3: "#6F27FF",

      // Errors
      red: "#EF4444",
      red1: "#EF4444",
      red2: "#DC2626",
      red3: "#B91C1C",

      // Neutrals — Main ramp mid steps
      gray: "#968FA7",
      gray1: "#968FA7",
      gray2: "#797386",
      gray3: "#575263",
    },
  },
})

export type AppConfig = typeof appConfig

declare module "tamagui" {
  interface TamaguiCustomConfig extends AppConfig {}
}

export default appConfig
