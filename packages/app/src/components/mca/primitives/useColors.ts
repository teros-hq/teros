/**
 * Theme-adaptive token hooks for MCA renderers.
 *
 * `useMcaTheme()` returns the active theme name ('dark' | 'light').
 * `useColors()` returns the active set of surface + badge tokens.
 *
 * Semantic colors (`indigo`, `green`, `amber`, `red`, `violet`, `orange`)
 * are theme-agnostic and are imported directly from `colors.ts` — no hook
 * needed for them.
 *
 * ## Source of truth
 *
 * After follow-up M2, the runtime source of truth is **Tamagui** via
 * `useThemeName()`. The `uiPreferencesStore` is only the persistence
 * layer (it remembers the user's choice across sessions and seeds the
 * `<TamaguiProvider defaultTheme>` in `_layout.tsx`). Inside the tree
 * the active theme name comes straight from the Tamagui context, so
 * primitives nested inside a `<Theme name="…">` scope automatically
 * pick up the override.
 *
 * Why not read Zustand directly here:
 * - A nested `<Theme name="light">` (e.g. inside a `<Theme inverse>`
 *   block) wouldn't be seen — Zustand only knows the *root* choice.
 * - Two sources of truth eventually drift. Tamagui owns "what is
 *   currently rendered"; the store owns "what the user picked".
 *
 * Usage:
 *   const c = useColors();
 *   <YStack backgroundColor={c.bgCard} borderColor={c.border}>...</YStack>
 *
 * Renderers that haven't been migrated yet keep importing the legacy
 * `colors` object — it stays mapped to the dark set, so visuals don't
 * change for them until they opt in.
 */

import type { MCACategory } from '@teros/shared';
import { useMemo } from 'react';
import { useThemeName } from 'tamagui';
import {
  badges,
  categoryBadges,
  surface,
  type BadgePalette,
  type CategoryBadge,
  type SurfaceTokens,
  type Theme,
} from './colors';

/**
 * Active theme name as Tamagui sees it. Reactive to enclosing
 * `<Theme name="…">` scopes — `<Theme name="light">` inside a dark
 * tree returns `'light'` for the children of that block.
 *
 * Tamagui themes can be arbitrary strings (e.g. `'dark_blue'`). We only
 * care whether the user is in light or dark mode at the surface level,
 * so anything that doesn't start with `'light'` is treated as `'dark'`.
 */
export function useMcaTheme(): Theme {
  const name = useThemeName();
  // `name` may be `'dark'`, `'light'`, `'dark_blue'`, `'light_red'`, etc.
  return typeof name === 'string' && name.startsWith('light') ? 'light' : 'dark';
}

export interface AdaptiveColors extends SurfaceTokens {
  badges: BadgePalette;
  categoryBadges: Record<MCACategory, CategoryBadge>;
}

/**
 * Active theme-adaptive surface + badge tokens.
 *
 * Returns a memoized object — the reference is stable across renders
 * unless the active theme changes. Cheap to call in any component.
 *
 * For semantic colors that don't change across themes (`indigo`,
 * `green`, `amber`, `red`, `violet`, `orange`), import them directly
 * from `colors` — no hook needed.
 *
 * @example
 *   const c = useColors();
 *   <YStack backgroundColor={c.bgCard} borderColor={c.border}>
 *     <Text color={c.text}>theme-aware</Text>
 *     <Badge variant="info" />  {// uses c.badges.info under the hood }
 *   </YStack>
 *
 * Naming note: `useColors()` returns *theme-adaptive* tokens (surface
 * + badges). `useMcaTheme()` returns just the theme name string.
 * Separated so renderers that only need the name avoid recomputing
 * the full token object on every render.
 */
export function useColors(): AdaptiveColors {
  const theme = useMcaTheme();
  return useMemo<AdaptiveColors>(
    () => ({
      ...surface[theme],
      badges: badges[theme],
      categoryBadges: categoryBadges[theme],
    }),
    [theme],
  );
}
