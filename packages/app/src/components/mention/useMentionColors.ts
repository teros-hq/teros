/**
 * useMentionColors — `useColors()` for the mention surfaces.
 *
 * The mention dropdown / chips are plain-DOM pieces that also render in
 * harnesses without a `TamaguiProvider` (their render tests mount them
 * bare). Tamagui's `useThemeName` throws outside a provider, so this hook
 * reads the theme from Tamagui when it is there and falls back to the
 * persisted preference (the same choice that seeds the provider) when it
 * is not. Same tokens, same shape as `useColors()`.
 */
import { useMemo } from "react"
import { useMcaTheme, type AdaptiveColors } from "../mca/primitives/useColors"
import { badges, categoryBadges, surface, type Theme } from "../mca/primitives/colors"
import { useUiPreferencesStore } from "../../store/uiPreferencesStore"

export function useMentionColors(): AdaptiveColors {
  let theme: Theme
  try {
    theme = useMcaTheme()
  } catch {
    // No Tamagui tree above us (bare render) — the persisted choice is the
    // best available answer. Not reactive, by design: this only happens
    // outside the app shell.
    theme = useUiPreferencesStore.getState().theme === "dark" ? "dark" : "light"
  }
  return useMemo<AdaptiveColors>(
    () => ({
      ...surface[theme],
      badges: badges[theme],
      categoryBadges: categoryBadges[theme],
    }),
    [theme],
  )
}
