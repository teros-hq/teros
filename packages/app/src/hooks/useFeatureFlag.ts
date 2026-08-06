/**
 * useFeatureFlag<T>(key) — React hook for typed feature flag consumption.
 *
 * Returns the resolved value for the current user's context.
 * Falls back to the registry default when the flag is null, missing,
 * or has not yet loaded.
 *
 * @example
 *   const isVoiceEnabled = useFeatureFlag<boolean>('voice.enabled')
 *   const maxFileSize = useFeatureFlag<number>('files.max-size-mb')
 *   const onboardingFlow = useFeatureFlag<string>('onboarding.flow')
 *

 */

import { useMemo } from "react"
import { useFeatureFlagsStore, getResolvedFlag } from "../store/featureFlagsStore"

/**
 * Hook that returns the resolved value of a feature flag.
 *
 * @param key  The flag key (must exist in the registry)
 * @returns    The resolved value, typed as T
 */
export function useFeatureFlag<T>(key: string): T {
  const flags = useFeatureFlagsStore((state) => state.flags)

  return useMemo(() => {
    return getResolvedFlag<T>({ flags }, key)
  }, [flags, key])
}

/**
 * Hook that returns the raw resolved entry (value + source + type).
 * Useful when you need to know the source level for debugging.
 */
export function useFeatureFlagEntry(key: string) {
  return useFeatureFlagsStore((state) => state.flags[key])
}

/**
 * Hook that returns whether the feature flags store is currently loading.
 */
export function useFeatureFlagsLoading(): boolean {
  return useFeatureFlagsStore((state) => state.isLoading)
}

/**
 * Hook that returns the full flags cache.
 * Use sparingly — prefer useFeatureFlag(key) for individual flags.
 */
export function useFeatureFlagsCache() {
  return useFeatureFlagsStore((state) => state.flags)
}
