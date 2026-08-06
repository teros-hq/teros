/**
 * Pure-function tests for the MCA category badge palette — TER-523.
 *
 * The catalog card / detail header paints a per-category tint. These tests
 * guard the runtime shape: both themes expose the same set of categories, the
 * values are well-formed, none fall back to lazy Tailwind defaults, and unknown
 * categories degrade to the neutral `other` tint.
 *
 * The enum↔record completeness guard (every `MCACategory` has a tint) lives at
 * compile time: `categoryBadges` is typed `Record<MCACategory, CategoryBadge>`,
 * so a new category in the shared enum fails `tsc` until a tint is added. We
 * don't import the zod schema here to keep the test free of shared's runtime
 * deps (bun can't resolve `zod` through the shared source from app).
 */

import { describe, expect, it } from 'bun:test';
import { categoryBadgeProps, categoryBadges, type Theme } from '../colors';

const THEMES: Theme[] = ['dark', 'light'];
const HEX = /^#[0-9A-Fa-f]{6}$/;
const RGBA = /^rgba\([\d.,\s]+\)$/;

// Tailwind "default" hues the catalog mockups deliberately avoid — a category
// tint landing on one of these signals a lazy palette, not the vendor design.
const TAILWIND_DEFAULTS = new Set(['#3B82F6', '#EF4444', '#22C55E', '#F59E0B']);

describe('categoryBadgeProps — MCA catalog badge palette (TER-523)', () => {
  it('exposes the same category set in both themes', () => {
    const darkKeys = Object.keys(categoryBadges.dark).sort();
    const lightKeys = Object.keys(categoryBadges.light).sort();
    expect(lightKeys).toEqual(darkKeys);
    expect(darkKeys.length).toBeGreaterThanOrEqual(11);
  });

  it('returns well-formed tints for every category in both themes', () => {
    for (const theme of THEMES) {
      for (const cat of Object.keys(categoryBadges[theme])) {
        const b = categoryBadgeProps(cat, theme);
        expect(HEX.test(b.text)).toBe(true);
        expect(RGBA.test(b.bg)).toBe(true);
      }
    }
  });

  it('uses the vendor palette, not Tailwind defaults', () => {
    for (const theme of THEMES) {
      for (const cat of Object.keys(categoryBadges[theme])) {
        const { text } = categoryBadgeProps(cat, theme);
        expect(TAILWIND_DEFAULTS.has(text.toUpperCase())).toBe(false);
      }
    }
  });

  it('falls back to the neutral `other` tint for unknown categories', () => {
    for (const theme of THEMES) {
      expect(categoryBadgeProps('totally-unknown-category', theme)).toEqual(
        categoryBadges[theme].other,
      );
    }
  });
});
