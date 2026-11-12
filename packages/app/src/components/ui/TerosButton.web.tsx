// TerosButton — web port of the DS button (design-system/components/TerosButton.jsx)
// by Relajaelcoco (DS) · ported for the Teros app
//
// The full hover engine: the wandering blur (seven stacked copies of the pill,
// each blurrier, revealed through radial masks over a drifting point) and, for
// secondary buttons, the smoke that enters diagonally and sets into a solid
// fill, with the label ink travelling with it (background-clip: text).
//
// Ported from the DS with window.DS replaced by imports from ./teros-tokens
// (the generated bridge — source of truth: teros-ui/design-system/tokens.js).
// ALL engine invariants are preserved verbatim; the comments that carry them
// travel with the code. If the DS component changes, re-port from it.
//
// Requires the Phosphor web font (public/fonts/phosphor) — icons are drawn with
// <i class="ph ph-*">, not with an SVG component.

import React, { useEffect, useRef } from "react";
import {
  palette,
  control,
  radius,
  ui,
  fonts,
  alpha,
  inkFor,
  buttonEngine,
  type ButtonSize,
} from "./teros-tokens";

// ─── Shared button base ────────────────────────────────────────────────────
const btnBase: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "8px",
  fontFamily: fonts.sans,
  fontWeight: 400,
  cursor: "pointer",
  border: "none",
  transition: "all 0.18s cubic-bezier(0.4,0,0.2,1)",
  textDecoration: "none",
  whiteSpace: "nowrap",
  // Required in flex rows: an icon-only button has no text holding it open
  // and collapses to the width of its glyph without it.
  flexShrink: 0,
};

// ─── Size scale ───────────────────────────────────────────────────────────
// HEIGHT IS THE TOKEN (DS.control): declared, never grown from padding, and
// the label is centred inside it — so a border can never push a button off
// its step. 28 / 36 / 44 / 48.
// ⚠️ A STEP TAKES THE WHOLE TEXT RECIPE, NOT JUST THE SIZE (DS.ui): size /
// tracking / transform travel together.
// ⚠️ `blob` / `blur` ARE PER STEP (buttonEngine.sizes): the smudge is sized
// against the pill it lives in, not against the page.
const txt = (k: keyof typeof ui) => ({
  size: ui[k].size,
  tracking: ui[k].tracking || "0",
  // Not every ui step declares a transform (only xs/xxs/codenote).
  transform: (ui[k] as { transform?: string }).transform || "none",
});

type Step = {
  size: string;
  tracking: string;
  transform: string;
  h: number;
  padX: number;
  icon: string;
  blob: number;
  blur: number;
  iconWeight?: string;
};

const SIZES: Record<ButtonSize, Step> = {
  // ⚠️ BOLD ICON, xs ONLY. Safe because Phosphor-Bold shares the regular's
  // metrics (both a square em); `light`, `thin` and `fill` do NOT and would
  // knock the icon off centre.
  xs: { ...txt("xs"), ...control.xs, icon: ui.sm.size, blob: 76, blur: 13, iconWeight: "bold" },
  sm: { ...txt("sm"), ...control.sm, icon: ui.base.size, blob: 98, blur: 16 },
  md: { ...txt("base"), ...control.md, icon: ui.lg.size, blob: 120, blur: 20 },
  lg: { ...txt("lg"), ...control.lg, icon: ui.xl.size, blob: 120, blur: 20 },
};

// ─── Colour and behaviour are independent ─────────────────────────────────
// ⚠️ Primary and Secondary are NOT "the violet one" and "the dark one".
// What separates them is BEHAVIOUR, and only that:
//   · primary   — SOLID. On hover it carries the wandering blur smudge and
//                 nothing else. It never fills.
//   · secondary — FILLS. Same smudge, plus smoke that enters diagonally and
//                 sets into a solid fill.
// Either behaviour can be dressed in any tone: a primary in mint is still a
// primary. Hence tone and fill are separate props.
// The three enums as literal unions - the DS contract values. Declared here
// so the Records below key by them without circularity.
export type ButtonVariant = "primary" | "secondary";
export type ButtonTone = "violet" | "mint" | "ink";
export type ButtonFill = "violet" | "mint";

const BEHAVIOUR = {
  primary: { fills: false },
  secondary: { fills: true },
} as const;

// ⚠️ A TONE DECLARES ITS PILL AND NOTHING ELSE. The ink is not a choice made
// here — it is `inkFor`, the same rule the palette page puts on its swatches:
// the far end of the pill's OWN family. Declaring the ink beside the pill is
// how a component ends up disagreeing with the palette that documents it.
const withInk = (pill: string) => ({ pill, ink: inkFor(pill) });

type ToneEntry = { light: { pill: string; ink: string }; dark: { pill: string; ink: string } };
const TONE: Record<ButtonTone, ToneEntry> = {
  // Holds the same violet in both themes — it does not invert.
  violet: { light: withInk(palette.purple["300"]), dark: withInk(palette.purple["300"]) },
  // Does NOT invert either: Mint/200 holds on either page. Same pill the mint
  // FILL declares, so a secondary filling with mint lands on the colour a
  // mint primary already is — and now on the same ink too.
  mint: { light: withInk(palette.mint["200"]), dark: withInk(palette.mint["200"]) },
  // Inverts against the page: dark pill on a light page, bone on a dark one.
  ink: { light: withInk(palette.main["900"]), dark: withInk(palette.main["200"]) },
};

// What a filling button fills WITH — independent of the pill it starts from —
// and the ink the TEXT needs in order to still be readable on top of it.
// ⚠️ THE INK IS NOT DECORATION — it is what makes the fill usable. In dark the
// secondary's pill is bone with dark text; fill that with violet and the text
// stays dark on dark and disappears. Because the ink travels with the fill,
// the brand violet stays violet in both themes.
const FILL: Record<ButtonFill, { color: string; ink: string }> = {
  violet: { color: palette.purple["300"], ink: inkFor(palette.purple["300"]) },
  mint: { color: palette.mint["200"], ink: inkFor(palette.mint["200"]) },
};

// ─── The two states ───────────────────────────────────────────────────────
// Not two more tones: a state is what happens to WHATEVER tone the button is
// wearing. `loading` keeps its tone whole; only `disabled` replaces the pill.
//
// ⚠️ DISABLED IS THE ONE PLACE THE PAIR RULE IS WRONG: `inkFor` maximises
// contrast, and disabled means exactly the opposite — read me, do not reach
// for me. So the ink is Main/500, the system's own recessive text. The pill is
// ONE STEP OFF THE SURFACE the button sits on, measured, not counted off the
// light value. ⚠️ NO `opacity` — a disabled button is a colour.
const STATE = {
  disabled: {
    light: { pill: palette.main["300"], ink: palette.main["500"] },
    dark: { pill: palette.main["700"], ink: palette.main["500"] },
  },
} as const;

// The spinner's keyframe travels WITH the component (a component that leans
// on a keyframe it did not ship stops spinning the moment it is dropped
// anywhere else — silently). Reduced motion SLOWS it rather than stopping it:
// a frozen spinner reads as a hung request, which is the opposite of what it
// is there to say.
(function injectSpinnerCSS() {
  const ID = "teros-btn-spin-css";
  if (typeof document === "undefined" || document.getElementById(ID)) return;
  const el = document.createElement("style");
  el.id = ID;
  el.textContent =
    "@keyframes teros-btn-spin { to { transform: rotate(360deg); } }" +
    "@media (prefers-reduced-motion: reduce) { .teros-btn-spinner { animation-duration: 2.4s !important; } }";
  document.head.appendChild(el);
})();

// Blend two hex colours. The text crosses from its resting ink to the fill's
// ink while the smoke comes in, so it is never caught halfway unreadable.
const mix = (h1: string, h2: string, k: number): string => {
  const a = parseInt(h1.slice(1), 16), b = parseInt(h2.slice(1), 16);
  const ch = (sh: number) => Math.round(((a >> sh) & 255) + ((((b >> sh) & 255) - ((a >> sh) & 255)) * k));
  return "rgb(" + ch(16) + "," + ch(8) + "," + ch(0) + ")";
};

// ─── The hover ───────────────────────────────────────────────────────────
// Two effects stacked:
//   · The wandering blur. Seven copies of the pill, each blurrier than the
//     last, revealed through radial masks centred on a point that drifts.
//   · The smoke (secondary only). Two clouds enter diagonally at staggered
//     speeds, breathing, their soft edge WIDENING as they advance, and only
//     in the last stretch do they set into solid fill. Ease-out.
//
// Load-bearing, easy to break:
//   1) The loop SLEEPS at rest and the layers go display:none — otherwise
//      every button on the page recomputes seven blurred masks 60x/second.
//   2) On waking, the blob is reborn at a RANDOM point. The unpredictability
//      is a quality of the effect, not an accident.
//   3) The smoke is painted as background-image ON the pill, never as a
//      child — a child leaves an antialiasing ring on the rounded edge.
// fillSpeed 0.7 fills in ~1.2s; drainSpeed 0.25 drains in ~3.4s.
// Deliberately different: the fill should land quickly, the retreat not.
// ⚠️ `blurPeak` and `blobSize` here are only the FALLBACK. The live values
// come from the size step (SIZES[size].blur / .blob).
const FX = { ...buttonEngine.fx };

// Painting the label with the smoke's own clouds, clipped to the glyphs, is
// what makes the ink travel WITH the colour. Needs background-clip:text.
const CLIP_OK =
  typeof CSS !== "undefined" &&
  !!CSS.supports &&
  (CSS.supports("-webkit-background-clip", "text") || CSS.supports("background-clip", "text"));

const smooth = (u: number) => {
  u = u < 0 ? 0 : u > 1 ? 1 : u;
  return u * u * (3 - 2 * u);
};

// ─── Props ────────────────────────────────────────────────────────────────
export type ButtonTheme = "light" | "dark";
export type ButtonFx = Partial<typeof FX>;

export interface TerosButtonProps {
  theme?: ButtonTheme;
  variant?: ButtonVariant;
  tone?: ButtonTone;
  fill?: ButtonFill;
  size?: ButtonSize;
  label?: string;
  /** Phosphor icon name (kebab-case), drawn with the web font. */
  icon?: string;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  /**
   * Cross-platform alias: native callers (and cross-platform files like
   * StepFooter) pass onPress. Resolved as onClick when both are given.
   */
  onPress?: () => void;
  fx?: ButtonFx;
  ariaLabel?: string;
  disabled?: boolean;
  loading?: boolean;
  /**
   * App extension (not in the DS contract): stretch to fill the parent row.
   * The onboarding CTA is a full-width bar, which the DS never needs.
   */
  block?: boolean;
  /** Test id, forwarded to the <button> (the app's test convention). */
  testID?: string;
}

export function TerosButton({
  theme = "dark",
  variant = "primary",
  tone = "violet",
  fill = "violet",
  size = "md",
  label,
  icon,
  onClick,
    onPress,
  fx,
  ariaLabel,
  disabled = false,
  loading = false,
    block = false,
  testID,
}: TerosButtonProps) {
  const s = SIZES[size];
  // Defaults, then the step's smudge values, then this button's overrides.
  // `fx` must stay last: a caller relies on beating the step.
  const F = { ...FX, blobSize: s.blob, blurPeak: s.blur, ...(fx || {}) };
  // ⚠️ BOTH STATES KILL THE HOVER, and for the same reason from two sides: a
  // button you cannot press must not answer the pointer, and one that is
  // already working has nothing left to promise. `inert` is what the effect
  // and the render both ask — one flag, so the two cannot disagree.
  const inert = disabled || loading;
  const c = disabled
    ? STATE.disabled[theme]
    : TONE[tone][theme];
  // The behaviour decides IF it fills; the fill prop decides with what.
  const filling = !inert && BEHAVIOUR[variant].fills ? FILL[fill] : null;
  const smokeColor = filling ? filling.color : null;
  const smoke = !!smokeColor;
  // Icon with no label: the pill collapses into a circle of the step's own
  // height, so an icon button and a text button side by side line up.
  const iconOnly = !!icon && !label;

  const rootRef = useRef<HTMLButtonElement>(null);
  const fxRef = useRef<HTMLDivElement>(null);
  const layerRefs = useRef<(HTMLDivElement | null)[]>([]);
  const pillRefs = useRef<(HTMLDivElement | null)[]>([]);
  const hover = useRef(false);
  // The colour lives in a ref so the loop always reads the current theme
  // without restarting (and without closing over the stale value).
  const smokeRef = useRef<string | null>(smokeColor);
  smokeRef.current = smokeColor;
  // Resting ink and filled ink, in refs for the same reason as the colour:
  // the loop must read the current theme without restarting.
  const inkRef = useRef(c.ink);
  inkRef.current = c.ink;
  const inkFilledRef = useRef(filling ? filling.ink : c.ink);
  inkFilledRef.current = filling ? filling.ink : c.ink;
  const textRef = useRef<HTMLSpanElement>(null);
  const clipping = smoke && CLIP_OK;

  const pad = F.blurPeak * 2.5; // room for the blur to bleed uncropped
  const layers: { blur: number; r: number }[] = [];
  for (let i = 0; i < F.N; i++) {
    const f = i / (F.N - 1);
    const r = i === 0 ? 0 : F.blobSize * (1 - 0.8 * (i - 1) / (F.N - 2));
    layers.push({ blur: F.blurPeak * f, r });
  }

  useEffect(() => {
    const root = rootRef.current, fxBox = fxRef.current;
    // Inert buttons do not render the effect box at all, so there is nothing
    // to drive and no listener to attach — the seven blurred layers never
    // reach the DOM either.
    if (inert || !root || !fxBox) return;
    // Narrow once for the closures below: TS does not carry the guard into
    // nested function declarations, so bind non-null locals here.
    const rootEl = root;
    const fxBoxEl = fxBox;
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let o = 0; // opacity of the blur smudge (0 = at rest)
    let p = 0; // smoke progress 0..1
    let raf = 0, running = false;
    let cx = Math.random(), cy = Math.random(), th = Math.random() * Math.PI * 2;
    const lo = -0.15, hi = 1.15;
    const ph1 = Math.random() * 6.283, ph2 = Math.random() * 6.283; // own phase each cloud

    function show(on: boolean) {
      fxBoxEl.style.display = on ? "block" : "none";
      // ⚠️ THE CSS TRANSITION HAS TO GET OUT OF THE WAY WHILE THE LOOP RUNS.
      // The button carries `transition: color` so the ink eases on a THEME
      // change. But the loop rewrites the colour every frame, and each
      // rewrite restarts that transition from scratch — the computed colour
      // then never reaches the value being set.
      if (smoke) rootEl.style.transitionProperty = on ? "background-color" : "background-color, color";
      for (let i = 1; i < F.N; i++) {
        const w = layerRefs.current[i];
        if (w) w.style.willChange = on ? "mask" : "auto";
      }
    }
    function clearSmoke() {
      rootEl.style.backgroundImage = "none";
      rootEl.style.color = inkRef.current;
      // ⚠️ Never leave the clipped label without a gradient: it is painted in
      // transparent and the gradient IS its colour. No gradient, no text.
      if (clipping && textRef.current) {
        textRef.current.style.backgroundImage = "linear-gradient(" + inkRef.current + ", " + inkRef.current + ")";
      }
      for (let i = 1; i < F.N; i++) {
        const pd = pillRefs.current[i];
        if (pd) pd.style.backgroundImage = "none";
      }
    }
    show(false);
    if (smoke) clearSmoke();

    function frame(ts: number) {
      const target = hover.current ? 1 : 0;
      o += (target - o) * 0.12;
      if (smoke) {
        // Ease-out: the multiplier falls from ~2.4x at p=0 to ~0.5x at the end.
        const mult = 2.4 - 1.9 * p;
        // ⚠️ FILLING AND DRAINING RUN AT DIFFERENT SPEEDS, on purpose. A
        // single speed for both puts the fill around 3.4s: fine where the
        // pointer rests, too slow for a page you skim. The retreat keeps the
        // slower value.
        if (p < target) p = Math.min(target, p + 0.016 * F.fillSpeed * mult);
        else if (p > target) p = Math.max(target, p - 0.016 * F.drainSpeed * mult);
      }
      // Going to sleep. The smoke must have FINISHED retreating (p <= 0):
      // sleeping on hover alone would freeze the colour halfway.
      if (!hover.current && o < F.IDLE && p <= 0) {
        o = 0; running = false; raf = 0;
        show(false);
        if (smoke) clearSmoke();
        return;
      }
      raf = requestAnimationFrame(frame);

      // No DOM measuring in the loop: offsetWidth/Height do not force the
      // reflow getBoundingClientRect does, and the blob is placed in % over
      // the effect box (the button + pad on each side) — hence the reframe.
      const a = o.toFixed(3);
      const bw = rootEl.offsetWidth || 1, bh = rootEl.offsetHeight || 1;

      if (!reduce) {
        th += (Math.random() - 0.5) * 0.2 * F.driftSpeed;
        // ⚠️ NORMALISED AGAINST THE BUTTON WIDTH. The original step is in
        // units OF THE BUTTON, so the smudge crawls slower the narrower the
        // button. Referring the step to REF_W holds the on-screen speed
        // steady across the scale.
        const st = 0.0022 * F.driftSpeed * (F.REF_W / bw);
        cx += Math.cos(th) * st; cy += Math.sin(th) * st;
        if (cx < lo) { cx = lo; th = Math.PI - th; } else if (cx > hi) { cx = hi; th = Math.PI - th; }
        if (cy < lo) { cy = lo; th = -th; } else if (cy > hi) { cy = hi; th = -th; }
      } else { cx = 0.7; cy = 0.5; }
      const mx = ((pad + cx * bw) / (2 * pad + bw)) * 100;
      const my = ((pad + cy * bh) / (2 * pad + bh)) * 100;

      let bgImage = "none";
      let inkK = 0; // how far the ink has crossed, 0..1 (icons, fallback)
      let textBg: string | null = null; // the label's own gradient, when clipping
      if (smoke && p > 0.004) {
        const col = smokeRef.current as string;
        const e1 = smooth(Math.min(1, p / 0.9));
        const e2 = smooth((p - 0.12) / 0.88);
        const sat = smooth((p - 0.72) / 0.28); // the setting phase
        const wob1 = (1 - 0.7 * e1) * 0.05 * bw, wob2 = (1 - 0.7 * e2) * 0.05 * bw;
        const w1x = Math.sin(ts * 0.0016 + ph1) * wob1, w1y = Math.cos(ts * 0.0013 + ph1) * wob1 * 0.6;
        const w2x = Math.sin(ts * 0.0019 + ph2) * wob2, w2y = Math.cos(ts * 0.0011 + ph2) * wob2 * 0.6;
        // Cloud 1: diagonal from bottom left. Cloud 2: from top left, later.
        const c1x = (-0.25 + 0.65 * e1) * bw + w1x, c1y = (1.3 - 0.75 * e1) * bh + w1y;
        const r1 = (0.3 + 1.15 * e1) * bw, s1 = 18 + 10 * e1 + 54 * sat;
        const c2x = (-0.15 + 0.9 * e2) * bw + w2x, c2y = (-0.4 + 0.85 * e2) * bh + w2y;
        const r2 = (0.25 + 1.05 * e2) * bw, s2 = 15 + 10 * e2 + 57 * sat;
        bgImage =
          "radial-gradient(circle " + r1.toFixed(1) + "px at " + c1x.toFixed(1) + "px " + c1y.toFixed(1) + "px, " + col + " 0%, " + col + " " + s1.toFixed(1) + "%, transparent 100%), " +
          "radial-gradient(circle " + r2.toFixed(1) + "px at " + c2x.toFixed(1) + "px " + c2y.toFixed(1) + "px, " + col + " 0%, " + col + " " + s2.toFixed(1) + "%, transparent 100%)";

        // Has the colour actually REACHED the text yet? Measured, not timed.
        // The clouds come in diagonally from outside, so the moment they
        // cover the middle — where the label sits — is not a fixed fraction
        // of the fill. Distance from the centre to each cloud, against the
        // radius where that cloud is still solid colour. Halfway between
        // solid and fully transparent is where the colour actually starts
        // covering, and that is what the eye reads.
        const reach1 = r1 * ((s1 + 100) / 200), reach2 = r2 * ((s2 + 100) / 200);
        const d1 = Math.hypot(bw / 2 - c1x, bh / 2 - c1y) / (reach1 || 1);
        const d2 = Math.hypot(bw / 2 - c2x, bh / 2 - c2y) / (reach2 || 1);
        // 0 when the nearest solid edge is just touching the centre, 1 once
        // it is well past it. The ink crosses inside that window, so it
        // travels WITH the colour instead of trailing behind a timer.
        inkK = smooth((1 - Math.min(d1, d2)) / 0.5);

        // The label repainted with the SAME two clouds, shifted into its own
        // box: where the fill has already passed, the filled ink; where it
        // has not, the resting one. Clipped to the glyphs, so the change
        // sweeps across the word with the colour — letter by letter.
        if (clipping && textRef.current) {
          const ox = textRef.current.offsetLeft, oy = textRef.current.offsetTop;
          const IF = inkFilledRef.current, IR = inkRef.current;
          textBg =
            "radial-gradient(circle " + r1.toFixed(1) + "px at " + (c1x - ox).toFixed(1) + "px " + (c1y - oy).toFixed(1) + "px, " + IF + " 0%, " + IF + " " + s1.toFixed(1) + "%, transparent 100%), " +
            "radial-gradient(circle " + r2.toFixed(1) + "px at " + (c2x - ox).toFixed(1) + "px " + (c2y - oy).toFixed(1) + "px, " + IF + " 0%, " + IF + " " + s2.toFixed(1) + "%, transparent 100%), " +
            "linear-gradient(" + IR + ", " + IR + ")";
        }
      }

      if (smoke) {
        rootEl.style.backgroundImage = bgImage;
        // Applied on the button, not on the label, so an icon riding on
        // currentColor crosses with the text.
        rootEl.style.color = inkK <= 0 ? inkRef.current : mix(inkRef.current, inkFilledRef.current, inkK);
        if (clipping && textRef.current) {
          textRef.current.style.backgroundImage = textBg || "linear-gradient(" + inkRef.current + ", " + inkRef.current + ")";
        }
      }
      for (let i = 1; i < F.N; i++) {
        const w = layerRefs.current[i];
        if (!w) continue;
        if (smoke) { const pd = pillRefs.current[i]; if (pd) pd.style.backgroundImage = bgImage; }
        const m = "radial-gradient(circle " + layers[i].r.toFixed(1) + "px at " + mx.toFixed(2) + "% " + my.toFixed(2) + "%, rgba(0,0,0," + a + ") 0%, rgba(0,0,0," + a + ") 45%, rgba(0,0,0,0) 100%)";
        w.style.setProperty("-webkit-mask-image", m);
        w.style.setProperty("mask-image", m);
      }
    }

    function wake() {
      if (running) return;
      running = true;
      // The blob is reborn somewhere new every time the effect wakes from
      // cold. Without this the halo reappears pinned where you left it.
      if (!reduce) { cx = Math.random(); cy = Math.random(); th = Math.random() * Math.PI * 2; }
      show(true);
      raf = requestAnimationFrame(frame);
    }

    const onEnter = () => { hover.current = true; wake(); };
    const onLeave = () => { hover.current = false; wake(); }; // let it fade; the loop sleeps itself
    const onVisibility = () => {
      if (!document.hidden) return;
      hover.current = false; o = 0; p = 0; running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0; show(false);
      if (smoke) clearSmoke();
    };
    rootEl.addEventListener("pointerenter", onEnter);
    rootEl.addEventListener("pointerleave", onLeave);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      rootEl.removeEventListener("pointerenter", onEnter);
      rootEl.removeEventListener("pointerleave", onLeave);
      document.removeEventListener("visibilitychange", onVisibility);
      if (raf) cancelAnimationFrame(raf);
    };
    // The effect re-runs when smoke/inert flip; `pad` changes only with the
    // size step's blur, which changes the layers — the DS kept it in deps for
    // the same reason.
  }, [smoke, pad, inert]);

  return (
    <button
      ref={rootRef}
      // ⚠️ ONLY `disabled` TAKES THE ATTRIBUTE. A loading button must not fire
      // either, but the attribute makes the element ignore pointer events
      // entirely — and with it goes the `wait` cursor, which is the whole
      // feedback. So loading is refused in the handler and announced with
      // aria instead: busy, not unavailable.
      disabled={disabled}
      aria-disabled={inert || undefined}
      aria-busy={loading || undefined}
      onClick={inert ? undefined : (onClick ?? onPress)}
      aria-label={ariaLabel || (iconOnly && icon ? icon.replace(/-/g, " ") : undefined)}
      data-testid={testID}
      style={{
        ...btnBase,
        cursor: disabled ? "not-allowed" : loading ? "wait" : "pointer",
        position: "relative",
        overflow: "visible", // the blur has to bleed past the pill
        fontSize: s.size,
        // ⚠️ LEADING 1, FORCED, whatever the step says. Inside a pill of fixed
        // height the step's running-text leading pushes the label off centre.
        lineHeight: 1,
        height: s.h + "px",
        boxSizing: "border-box",
        ...(iconOnly
          ? { width: s.h + "px", padding: 0 }
          : { padding: "0 " + s.padX + "px" }),
        ...(block ? { width: "100%" } : {}),
        borderRadius: radius.full,
        // backgroundColor, not the `background` shorthand: the loop writes
        // backgroundImage on top and the shorthand would reset it to none on
        // every theme render.
        backgroundColor: c.pill,
        color: c.ink,
        transition: "background-color 0.4s ease, color 0.4s ease",
      }}
    >
      <div ref={fxRef} aria-hidden="true" style={{ position: "absolute", inset: -pad, pointerEvents: "none", display: "none" }}>
        {inert ? null : layers.map((L, i) => (i === 0 ? null : (
          <div
            key={i}
            ref={(el) => { layerRefs.current[i] = el; }}
            style={{ position: "absolute", inset: 0, filter: "blur(" + L.blur.toFixed(2) + "px)", pointerEvents: "none" }}
          >
            <div
              ref={(el) => { pillRefs.current[i] = el; }}
              style={{ position: "absolute", inset: pad, borderRadius: radius.full, backgroundColor: c.pill }}
            />
          </div>
        )))}
      </div>
      {/* ⚠️ THE SPINNER TAKES THE ICON'S SLOT — it does not join the row. A
          button that grows when it starts working shoves whatever is beside
          it, and it happens exactly when the page is least able to absorb
          it. With an icon this is a straight swap and nothing moves; without
          one the button does widen by a slot, which is the argument for a
          loading button carrying an icon in the first place.
          Sized off the step like the icon, and its ring is proportional too:
          a 2px stroke reads as a hoop at lg and as a blob at xs. */}
      {loading ? (
        <span
          className="teros-btn-spinner"
          aria-hidden="true"
          style={{
            position: "relative", zIndex: 1, flexShrink: 0,
            width: s.icon, height: s.icon, borderRadius: "50%",
            borderStyle: "solid",
            borderWidth: Math.max(1.5, parseFloat(s.icon) / 6.5).toFixed(2) + "px",
            // The track is the ink turned down, so the spinner belongs to
            // whatever tone the button is wearing instead of being a white
            // hoop that only works on the violet one.
            borderColor: alpha(c.ink, 0.3),
            borderTopColor: c.ink,
            animation: "teros-btn-spin 0.7s linear infinite",
          }}
        />
      ) : icon ? (
        <i
          // Phosphor picks the weight from the class family: `ph` is regular,
          // `ph-bold` the heavy cut. The step decides, so no call site has to.
          className={(s.iconWeight ? "ph-" + s.iconWeight : "ph") + " ph-" + icon}
          aria-hidden="true"
          style={{ position: "relative", zIndex: 1, fontSize: s.icon, lineHeight: 1 }}
        />
      ) : null}
      {label ? (
        <span
          ref={textRef}
          style={{
            position: "relative", zIndex: 1, whiteSpace: "pre",
            letterSpacing: s.tracking,
            textTransform: s.transform as React.CSSProperties["textTransform"],
            // ⚠️ Tracking is added after the LAST letter too, so the box is one
            // gap wider than the word looks and centring it leaves the word
            // left of centre. Pull that gap back off the right edge.
            ...(s.tracking !== "0" ? { marginRight: "-" + s.tracking } : null),
            ...(clipping ? {
              backgroundImage: "linear-gradient(" + c.ink + ", " + c.ink + ")",
              WebkitBackgroundClip: "text",
              backgroundClip: "text",
              WebkitTextFillColor: "transparent",
              color: "transparent",
              // ⚠️ AIR FOR THE DESCENDERS. The gradient IS the text's
              // colour, and a gradient only exists inside the box — with
              // leading 1 the box is shorter than the glyphs, so the tail of
              // a "g" goes unpainted and reads as a crop. In em so it scales;
              // harmless because the button's height is a fixed token.
              padding: "0.25em 0",
            } : null),
          }}
        >
          {label}
        </span>
      ) : null}
    </button>
  );
}

export default TerosButton;
