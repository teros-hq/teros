// GENERATED FILE — DO NOT EDIT BY HAND.
// Source of truth: teros-ui/design-system/tokens.js (DS v0.2.6, August 2026).
// Regenerate: node design-system/scripts/export-tokens-ts.mjs   (DS repo)
//             node scripts/regen-teros-tokens.mjs                 (monorepo)
//
// The token bridge the Teros app reads: palette, theme roles, control
// scale, radius, motion, interface text steps, fonts, and the ink rule
// (inkFor) — ported verbatim from tokens.js, comments included.
//
// Scope: colors.ts (mca/primitives) is NOT replaced by this file. It stays
// as the renderer-facing layer; this bridge is what new DS-aligned
// components (TerosButton and friends) read.

// ─── Provenance ─────────────────────────────────────────────────────────────
export const DS_VERSION = "0.2.6" as const;
export const DS_RELEASE = "August 2026" as const;

// ─── Palette (DS.colors.<family>[step]) ─────────────────────────────────────
// The glow sits on its family like in the DS: purple.glow, mint.glow.
export const palette = {
  "main": {
    "100": "#FAF9FC",
    "200": "#F2F0F7",
    "300": "#E5DFEF",
    "400": "#CFC5E2",
    "500": "#968FA7",
    "600": "#797386",
    "700": "#575263",
    "800": "#342F3D",
    "900": "#201C27"
  },
  "purple": {
    "100": "#E7DCFF",
    "200": "#9C6BFF",
    "300": "#6F27FF",
    "500": "#1C0252",
    "glow": "rgba(111,39,255,0.15)"
  },
  "mint": {
    "100": "#B9FFF0",
    "200": "#1EFFCE",
    "300": "#00D1A3",
    "400": "#096A55",
    "500": "#003E31",
    "glow": "rgba(30,255,206,0.15)"
  },
  "yellow": {
    "200": "#FFFFB0",
    "300": "#E8E863",
    "400": "#747449"
  },
  "pink": {
    "200": "#FFD2D2",
    "300": "#FF8181",
    "400": "#944343"
  },
  "white": "#FFFFFF"
} as const;
export type PaletteFamily = keyof typeof palette;

// The five ramp families - white is a single string, not a ramp; inkFor borrows Main for it.
export type RampFamily = "main" | "purple" | "mint" | "yellow" | "pink";

// ─── Status ramps (off-palette on purpose — see tokens.js) ───────────────────
export const status = {
  "borderAlpha": 0.2,
  "green": {
    "100": "#DCFCE7",
    "300": "#1CA24D",
    "border": "rgba(28,162,77,0.2)"
  },
  "amber": {
    "100": "#FEF3C7",
    "300": "#F59E0B",
    "border": "rgba(245,158,11,0.35)"
  },
  "red": {
    "100": "#FEE2E2",
    "300": "#EF4444",
    "border": "rgba(239,68,68,0.2)"
  },
  "info": {
    "100": "#E7DCFF",
    "300": "#6F27FF",
    "border": "rgba(111,39,255,0.2)",
    "dark": "#9C6BFF"
  }
} as const;

// ─── Surface roles per theme (DS.light / DS.dark) ────────────────────────────
export const themes = {
  light: {
  "bgPage": "#F2F0F7",
  "bgSurface": "#FAF9FC",
  "bgCard": "#FFFFFF",
  "bgCardHover": "#FAF9FC",
  "bgElevated": "#FFFFFF",
  "bgItem": "#F2F0F7",
  "border": "#E5DFEF",
  "borderStrong": "#CFC5E2",
  "text": "#342F3D",
  "text2": "#575263",
  "text3": "#968FA7",
  "accent": "#6F27FF"
},
  dark: {
  "bgPage": "#201C27",
  "bgSurface": "#342F3D",
  "bgCard": "#342F3D",
  "bgCardHover": "#575263",
  "bgElevated": "#575263",
  "bgItem": "#3E3849",
  "border": "#575263",
  "borderStrong": "#797386",
  "text": "#FAF9FC",
  "text2": "#CFC5E2",
  "text3": "#968FA7",
  "accent": "#9C6BFF"
},
} as const;
export type DsTheme = keyof typeof themes;
export type SurfaceRole = keyof typeof themes.light;

// ─── Control scale (DS.control) — h and padX per step ────────────────────────
// HEIGHT IS THE TOKEN: declared, never grown from padding. padX = h / 2,
// which IS the pill radius, so the label starts where the pill stops curving.
export const control = {
  "xs": {
    "h": 28,
    "padX": 14
  },
  "sm": {
    "h": 36,
    "padX": 18
  },
  "md": {
    "h": 44,
    "padX": 22
  },
  "lg": {
    "h": 48,
    "padX": 25
  }
} as const;
export type ControlStep = keyof typeof control;

// ─── Radius ramp (DS.radius) ────────────────────────────────────────────────
export const radius = {
  "sm": "4px",
  "md": "8px",
  "lg": "16px",
  "xl": "24px",
  "full": "100px"
} as const;

// ─── Motion (DS.motion) ─────────────────────────────────────────────────────
export const motion = {
  "durationFast": "120ms",
  "durationBase": "200ms",
  "durationSlow": "400ms",
  "durationLazy": "600ms",
  "easingDefault": "cubic-bezier(0.4, 0, 0.2, 1)",
  "easingEmphasized": "cubic-bezier(0.2, 0, 0, 1)",
  "easingSpring": "cubic-bezier(0.34, 1.56, 0.64, 1)",
  "durationDot": "900ms",
  "durationBreathe": "3200ms",
  "durationSpin": "2400ms"
} as const;

// ─── Interface text steps (DS.ui) ───────────────────────────────────────────
// A step is size + leading + tracking + transform TOGETHER; cherry-picking
// size documents a style the system does not have.
export const ui = {
  "4xl": {
    "font": "serif",
    "size": "60px",
    "leading": 1.05,
    "tracking": "-0.02em",
    "tag": "h2",
    "mirrors": "land-h2"
  },
  "3xl": {
    "font": "serif",
    "size": "48px",
    "leading": 1.1,
    "tracking": "-0.02em",
    "tag": "h3",
    "mirrors": "land-h3 (40px)"
  },
  "2xl": {
    "font": "serif",
    "size": "36px",
    "leading": 1.1,
    "tracking": "-0.02em",
    "tag": "h3",
    "mirrors": "land-h3 (40px)"
  },
  "xl": {
    "font": "serif",
    "size": "22px",
    "leading": 1.15,
    "tracking": "0.01em",
    "tag": "h4",
    "mirrors": "land-h4"
  },
  "heading-sm": {
    "font": "serif",
    "size": "18px",
    "leading": 1.4,
    "tracking": "0.01em",
    "tag": "h5",
    "mirrors": "land-h5"
  },
  "body-serif": {
    "font": "serif",
    "size": "16px",
    "leading": 1.5,
    "tracking": "0",
    "tag": "p",
    "mirrors": "land-h6 (leading differs: 1.2)"
  },
  "lg": {
    "font": "sans",
    "size": "18px",
    "leading": 1.4,
    "tracking": "0",
    "tag": "p"
  },
  "base": {
    "font": "sans",
    "size": "16px",
    "leading": 1.5,
    "tracking": "0",
    "tag": "p",
    "mirrors": "land-body (leading differs: 1.4)"
  },
  "sm": {
    "font": "sans",
    "size": "13px",
    "leading": 1.4,
    "tracking": "0",
    "tag": "p",
    "mirrors": "land-bodysmall"
  },
  "xs": {
    "font": "sans",
    "size": "10px",
    "leading": 1.2,
    "tracking": "0.18em",
    "tag": "p",
    "transform": "uppercase",
    "mirrors": "land-smallnote"
  },
  "xxs": {
    "font": "sans",
    "size": "9px",
    "leading": 1,
    "tracking": "0.1em",
    "tag": "p",
    "transform": "uppercase",
    "mirrors": "land-tagchips"
  },
  "codenote": {
    "font": "mono",
    "size": "10px",
    "leading": 1.2,
    "tracking": "0.05em",
    "tag": "p",
    "transform": "uppercase",
    "mirrors": "land-codenote"
  },
  "bodycode": {
    "font": "mono",
    "size": "13px",
    "leading": 1.2,
    "tracking": "0",
    "tag": "p",
    "mirrors": "land-bodycode"
  }
} as const;
export type UiStep = keyof typeof ui;

// ─── Font stacks (DS.fonts) ─────────────────────────────────────────────────
export const fonts = {
  "sans": "'Saans', system-ui, sans-serif",
  "serif": "'Prody', Georgia, serif",
  "mono": "'Reddit Mono', ui-monospace, SFMono-Regular, monospace"
} as const;

// ─── Helpers ────────────────────────────────────────────────────────────────
// A palette colour at a given alpha. Always feed it a token, never a literal.
export function alpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
}

// Is this colour light or dark? — the DS own test, verbatim.
// WCAG coefficients on the raw sRGB channels, NO gamma linearisation. This is
// not the contrast-ratio formula. Linearising moves three mid tones across
// the 0.5 threshold and the inks stop matching the brand own. Do not fix it.
export function lum(h: string): number {
  return [1, 3, 5]
    .map((i) => parseInt(h.substr(i, 2), 16) / 255)
    .reduce((acc, v, i) => acc + v * [0.2126, 0.7152, 0.0722][i], 0);
}

export function isLight(h: string): boolean {
  return typeof h === "string" && h[0] === "#" && lum(h) > 0.5;
}

// ─── inkFor — the ink a palette colour takes ─────────────────────────────────
// THE PAIR IS THE RULE: ink on a colour is the FAR END OF ITS OWN FAMILY —
// the family lightest step on a dark colour, its darkest on a light one.
// Purple/300 writes in Purple/100, Mint/200 in Mint/500. Never a mid tone on
// a mid tone, and not a neutral either: a bone label on a violet pill is the
// same ink the whole system uses, so the pill stops reading as violet-tinted.
//
// THE FAMILY IS FOUND FROM THE HEX, so a call site cannot name the wrong one.
// Pass group only for a colour that is not in the palette.
//
// Two exceptions, and both are about the bottom of a ramp being unusable:
//   Main writes in Main/800, the system text colour, not the near-black 900.
//   Purple writes in Purple/300 — the 500 is nearly black.
// One override: Purple/200 takes Purple/100, not the Purple/300 the rule
// gives it. The deeper violet fights the swatch.
//
// A family with a single step (White) borrows Main, and so does the case
// where the rule would return the colour itself.
export function inkFor(hex: string, group?: RampFamily): string {
  const RAMPS: Record<RampFamily, Record<string, string>> = {
    main: palette.main,
    purple: palette.purple,
    mint: palette.mint,
    yellow: palette.yellow,
    pink: palette.pink,
  };
  // Numeric steps only — a ramp may carry non-step keys (glow, border, ink).
  const stepsOf = (ramp: Record<string, string>) =>
    Object.entries(ramp)
      .filter(([k]) => /^\d+$/.test(k))
      .map(([, v]) => v);

  const G: Record<string, { n: number; light: string; dark: string }> = {};
  (Object.keys(RAMPS) as RampFamily[]).forEach((name) => {
    const steps = stepsOf(RAMPS[name]);
    G[name] = {
      n: steps.length,
      light: steps.reduce((a, b) => (lum(b) > lum(a) ? b : a)),
      dark: steps.reduce((a, b) => (lum(b) < lum(a) ? b : a)),
    };
  });
  G.main.dark = palette.main["800"];
  G.purple.dark = palette.purple["300"];
  const OVERRIDE: Record<string, string> = {
    [palette.purple["200"].toUpperCase()]: palette.purple["100"],
  };
  // Which ramp a hex belongs to. Reverse lookup so the rule is asked with the
  // colour alone — the way a component holds it.
  const OWNER: Record<string, RampFamily> = {};
  (Object.keys(RAMPS) as RampFamily[]).forEach((name) => {
    stepsOf(RAMPS[name]).forEach((hex0) => {
      OWNER[hex0.toUpperCase()] = name;
    });
  });

  const key = String(hex).toUpperCase();
  if (OVERRIDE[key]) return OVERRIDE[key];
  const fam = group || OWNER[key];
  const src = G[fam] && G[fam].n > 1 ? G[fam] : G.main;
  const isL = isLight(hex);
  let ink = isL ? src.dark : src.light;
  if (ink.toUpperCase() === key) ink = isL ? G.main.dark : G.main.light;
  return ink;
}

// ─── TerosButton engine constants (components/TerosButton.jsx) ───────────────
// NOT tokens — they are that component engine parameters, kept beside the
// bridge so the app port and the DS source stay in sync. If the DS component
// changes these, regenerate. blob/blur are PER STEP (sized against the pill,
// not the page); the geometry (h/padX) lives in control above.
export const buttonEngine = {
  // fx defaults; blurPeak/blobSize are the FALLBACK — the live values come
  // from the size step (sizes[size].blob / .blur).
  fx: { N: 7, IDLE: 0.002, blurPeak: 20, blobSize: 120, driftSpeed: 1, fillSpeed: 0.7, drainSpeed: 0.25, REF_W: 167 },
  // Per step: text recipe key (ui), icon size key, blob, blur, iconWeight.
  sizes: {
    xs: { text: "xs", icon: "sm", blob: 76, blur: 13, iconWeight: "bold" },
    sm: { text: "sm", icon: "base", blob: 98, blur: 16 },
    md: { text: "base", icon: "lg", blob: 120, blur: 20 },
    lg: { text: "lg", icon: "xl", blob: 120, blur: 20 },
  },
  // The disabled state pill and ink — the one place the pair rule is wrong
  // (read me, do not reach for me). Pill ONE STEP OFF THE SURFACE, per theme.
  disabled: {
    light: { pill: "#E5DFEF", ink: "#968FA7" },
    dark:  { pill: "#575263", ink: "#968FA7" },
  },
} as const;
export type ButtonSize = keyof typeof buttonEngine.sizes;

