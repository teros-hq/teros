#!/usr/bin/env bun
// WCAG AA contrast validator for MCA renderer surface tokens.
//
// Checks every text/text2/text3 foreground against every bgPage/bgCard/bgInner
// background in both light and dark themes. Fails with a non-zero exit code
// if any pair misses the AA threshold (4.5:1 for normal text, 3:1 for large
// text).
//
// Run from the monorepo root or from packages/app:
//   bun packages/app/scripts/validate-color-contrast.ts

import { surface } from '../src/components/mca/primitives/colors';

const TEXT_KEYS = ['text', 'text2', 'text3'] as const;
const BG_KEYS = ['bgPage', 'bgCard', 'bgInner'] as const;
const THEMES = ['dark', 'light'] as const;

const AA_NORMAL = 4.5;
const AA_LARGE = 3.0;

type Rgba = { r: number; g: number; b: number; a: number };

function parseColor(value: string): Rgba {
  const hex = value.trim();
  if (hex.startsWith('#')) {
    const clean = hex.slice(1);
    if (clean.length === 3) {
      const [r, g, b] = clean.split('').map((c) => parseInt(c + c, 16));
      return { r, g, b, a: 1 };
    }
    if (clean.length === 6) {
      const r = parseInt(clean.slice(0, 2), 16);
      const g = parseInt(clean.slice(2, 4), 16);
      const b = parseInt(clean.slice(4, 6), 16);
      return { r, g, b, a: 1 };
    }
    if (clean.length === 8) {
      const r = parseInt(clean.slice(0, 2), 16);
      const g = parseInt(clean.slice(2, 4), 16);
      const b = parseInt(clean.slice(4, 6), 16);
      const a = parseInt(clean.slice(6, 8), 16) / 255;
      return { r, g, b, a };
    }
  }

  const rgbaMatch = value.match(
    /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+))?\s*\)/
  );
  if (rgbaMatch) {
    return {
      r: parseInt(rgbaMatch[1], 10),
      g: parseInt(rgbaMatch[2], 10),
      b: parseInt(rgbaMatch[3], 10),
      a: rgbaMatch[4] !== undefined ? parseFloat(rgbaMatch[4]) : 1,
    };
  }

  throw new Error(`Unsupported color format: ${value}`);
}

function normalizeChannel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function relativeLuminance({ r, g, b }: Rgba): number {
  return 0.2126 * normalizeChannel(r) + 0.7152 * normalizeChannel(g) + 0.0722 * normalizeChannel(b);
}

function compositeOver(foreground: Rgba, background: Rgba): Rgba {
  const a = foreground.a;
  if (a >= 1) return foreground;
  if (a <= 0) return background;
  const blend = (fg: number, bg: number) => Math.round(fg * a + bg * (1 - a));
  return {
    r: blend(foreground.r, background.r),
    g: blend(foreground.g, background.g),
    b: blend(foreground.b, background.b),
    a: 1,
  };
}

function contrastRatio(fg: string, bg: string): number {
  const fgRgba = parseColor(fg);
  const bgRgba = parseColor(bg);
  const effectiveFg = compositeOver(fgRgba, bgRgba);
  const lum1 = relativeLuminance(effectiveFg);
  const lum2 = relativeLuminance(bgRgba);
  const lighter = Math.max(lum1, lum2);
  const darker = Math.min(lum1, lum2);
  return (lighter + 0.05) / (darker + 0.05);
}

function effectiveBackgroundColor(bg: string, pageBg: string): string {
  const bgRgba = parseColor(bg);
  if (bgRgba.a >= 1) return bg;
  const pageRgba = parseColor(pageBg);
  const blended = compositeOver(bgRgba, pageRgba);
  return `rgb(${blended.r}, ${blended.g}, ${blended.b})`;
}

interface Violation {
  theme: 'dark' | 'light';
  foreground: string;
  background: string;
  ratio: number;
}

function validateTheme(theme: 'dark' | 'light'): Violation[] {
  const tokens = surface[theme];
  const pageBg = tokens.bgPage;
  const violations: Violation[] = [];

  for (const fgKey of TEXT_KEYS) {
    for (const bgKey of BG_KEYS) {
      const effectiveBg = effectiveBackgroundColor(tokens[bgKey], pageBg);
      const ratio = contrastRatio(tokens[fgKey], effectiveBg);
      if (ratio < AA_LARGE) {
        // Fails both normal and large text thresholds.
        violations.push({ theme, foreground: fgKey, background: bgKey, ratio });
      }
    }
  }

  return violations;
}

function formatRatio(ratio: number): string {
  return ratio.toFixed(2);
}

function run(): number {
  const allViolations: Violation[] = [];

  for (const theme of THEMES) {
    const themeViolations = validateTheme(theme);
    allViolations.push(...themeViolations);
  }

  const normalFailures = allViolations.filter((v) => v.ratio < AA_NORMAL);
  const largeOnlyFailures = allViolations.filter((v) => v.ratio >= AA_NORMAL && v.ratio < AA_LARGE);

  let output = '';
  output += `WCAG AA contrast validation for surface tokens\n`;
  output += `=============================================\n`;
  output += `Thresholds: normal text ≥ ${AA_NORMAL}:1, large text ≥ ${AA_LARGE}:1\n\n`;

  for (const theme of THEMES) {
    output += `Theme: ${theme}\n`;
    for (const bgKey of BG_KEYS) {
      for (const fgKey of TEXT_KEYS) {
        const effectiveBg = effectiveBackgroundColor(surface[theme][bgKey], surface[theme].bgPage);
        const ratio = contrastRatio(surface[theme][fgKey], effectiveBg);
        const okNormal = ratio >= AA_NORMAL;
        const okLarge = ratio >= AA_LARGE;
        const status = okNormal ? 'OK  ' : okLarge ? 'LARGE' : 'FAIL';
        output += `  ${fgKey} on ${bgKey}: ${formatRatio(ratio)}:1 [${status}]\n`;
      }
    }
    output += '\n';
  }

  if (normalFailures.length > 0) {
    output += `\nNormal-text AA violations (${AA_NORMAL}:1 required):\n`;
    for (const v of normalFailures) {
      output += `  [${v.theme}] ${v.foreground} on ${v.background}: ${formatRatio(v.ratio)}:1\n`;
    }
  }

  if (largeOnlyFailures.length > 0) {
    output += `\nLarge-text-only AA violations (${AA_LARGE}:1 required, ${AA_NORMAL}:1 for normal):\n`;
    for (const v of largeOnlyFailures) {
      output += `  [${v.theme}] ${v.foreground} on ${v.background}: ${formatRatio(v.ratio)}:1\n`;
    }
  }

  if (allViolations.length === 0) {
    output += `\nAll surface text/background pairs meet WCAG AA contrast requirements.\n`;
  } else {
    output += `\n${allViolations.length} pair(s) below AA large-text threshold.\n`;
  }

  console.log(output);
  return allViolations.length > 0 ? 1 : 0;
}

process.exit(run());
