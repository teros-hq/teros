import { createAnimations } from '@tamagui/animations-css';
import { config } from '@tamagui/config';
import { createFont, createTamagui } from 'tamagui';

// Teros Design System — Fonts (aligned with DS v0.1.0 tokens.js)
// DM Sans: UI / body text. Newsreader: display / serif. JetBrains Mono: code.
const terosFonts = {
  ...config.fonts,
  body: createFont({
    family: "'DM Sans', system-ui, -apple-system, sans-serif",
    size: {
      1: 11, 2: 12, 3: 13, 4: 14, 5: 15, 6: 16, 7: 18, 8: 20,
      9: 24, 10: 28, 11: 32, 12: 36,
    },
    weight: {
      1: '300', 2: '400', 3: '400', 4: '400', 5: '500', 6: '600',
    },
    letterSpacing: {
      1: 0, 2: 0, 3: 0, 4: -0.01, 5: -0.015, 6: -0.02,
    },
    face: { 400: { normal: 'DM Sans' }, 500: { normal: 'DM Sans' } },
  }),
  serif: createFont({
    family: "'Newsreader', Georgia, serif",
    size: {
      1: 14, 2: 18, 3: 24, 4: 32, 5: 48, 6: 64, 7: 80,
    },
    weight: { 1: '300', 2: '300', 3: '300', 4: '300' },
    letterSpacing: { 1: -0.02, 2: -0.02, 3: -0.02 },
    face: { 300: { normal: 'Newsreader' } },
  }),
  mono: createFont({
    family: "'JetBrains Mono', 'Fira Code', monospace",
    size: {
      1: 11, 2: 12, 3: 13, 4: 14, 5: 15, 6: 16,
    },
    weight: { 1: '400', 2: '400' },
    letterSpacing: { 1: 0, 2: 0 },
    face: { 400: { normal: 'JetBrains Mono' } },
  }),
};

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
  card: 'cubic-bezier(0.34, 1.2, 0.5, 1) 240ms',
  // ─ Faster variant for badges, status chips, dot indicators.
  quick: 'cubic-bezier(0.34, 1.2, 0.5, 1) 180ms',
  // ─ Slow ease-out-expo, no overshoot — for modals, sheets.
  medium: 'cubic-bezier(0.16, 1, 0.3, 1) 320ms',
  slow: 'cubic-bezier(0.16, 1, 0.3, 1) 480ms',
  // ─ Pronounced spring-like overshoot for playful entries.
  bouncy: 'cubic-bezier(0.34, 1.56, 0.64, 1) 320ms',
});

// Teros Custom Themes — dark + light, both following the v2 Renderer UX
// Guide token set (renderer-ux-guide.html). Surface values are theme-
// adaptive; semantic accents (indigo, red, etc.) stay constant across
// themes for brand recognition.
const appConfig = createTamagui({
  ...config,
  fonts: terosFonts,
  animations,
  themes: {
    ...config.themes,
    // ── Dark — editorial near-black with cool-tinted neutrals ──
    dark: {
      ...config.themes.dark,
      background: '#0A0A0F',
      backgroundHover: '#16161D',
      backgroundPress: '#1D1D26',
      backgroundFocus: '#1D1D26',
      backgroundSoft: '#16161D',
      backgroundStrong: '#1D1D26',
      backgroundTransparent: 'rgba(10, 10, 15, 0.85)',
      color: '#E4E4E7',
      colorHover: '#D4D4D8',
      colorPress: '#D4D4D8',
      colorFocus: '#D4D4D8',
      borderColor: 'rgba(228, 228, 231, 0.07)',
      borderColorHover: 'rgba(228, 228, 231, 0.13)',
      borderColorFocus: '#5E6AD2',
      placeholderColor: '#71717A',

      // Brand indigo
      blue: '#5E6AD2',
      blue1: '#5E6AD2',
      blue2: '#4F5BB8',
      blue3: '#3F4A9E',

      // Errors
      red: '#EF4444',
      red1: '#EF4444',
      red2: '#F87171',
      red3: '#DC2626',

      // Neutrals (cool-tinted)
      gray: '#71717A',
      gray1: '#71717A',
      gray2: '#A1A1AA',
      gray3: '#52525B',
    },
    // ── Light — editorial cream surface, never pure white ──
    light: {
      ...config.themes.light,
      background: '#EFE9DB',
      backgroundHover: 'rgba(252,251,248,0.85)',
      backgroundPress: 'rgba(252,251,248,0.98)',
      backgroundFocus: 'rgba(252,251,248,0.98)',
      backgroundSoft: 'rgba(252,251,248,0.85)',
      backgroundStrong: 'rgba(252,251,248,0.98)',
      backgroundTransparent: 'rgba(239, 233, 219, 0.85)',
      color: '#1A1A1F',
      colorHover: '#0F0F14',
      colorPress: '#0F0F14',
      colorFocus: '#0F0F14',
      borderColor: 'rgba(10,10,15,0.08)',
      borderColorHover: 'rgba(10,10,15,0.14)',
      borderColorFocus: '#5E6AD2',
      placeholderColor: '#8A8A9A',

      // Brand indigo (same hex as dark — semantic stays stable)
      blue: '#5E6AD2',
      blue1: '#5E6AD2',
      blue2: '#4338CA',
      blue3: '#3730A3',

      // Errors
      red: '#EF4444',
      red1: '#EF4444',
      red2: '#DC2626',
      red3: '#B91C1C',

      // Neutrals (warm-tinted to harmonize with cream surface)
      gray: '#8A8A9A',
      gray1: '#8A8A9A',
      gray2: '#4A4A5A',
      gray3: '#52525B',
    },
  },
});

export type AppConfig = typeof appConfig;

declare module 'tamagui' {
  interface TamaguiCustomConfig extends AppConfig {}
}

export default appConfig;
