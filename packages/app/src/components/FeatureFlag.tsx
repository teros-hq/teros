/**
 * FeatureFlag component — Conditional rendering based on a feature flag.
 *
 * Renders `children` when the resolved flag value is truthy.
 * Renders `fallback` (if provided) when the flag is falsy or not loaded.
 *
 * @example
 *   <FeatureFlag flag="voice.enabled">
 *     <VoiceButton />
 *   </FeatureFlag>
 *
 *   <FeatureFlag flag="files.max-size-mb" fallback={<FreeTierBanner />}>
 *     <FileUpload />
 *   </FeatureFlag>
 *

 */

import type { ReactNode } from "react"
import { useFeatureFlag } from "../hooks/useFeatureFlag"

interface FeatureFlagProps {
  /** The feature flag key */
  flag: string

  /** Content to render when the flag is truthy */
  children: ReactNode

  /** Optional content to render when the flag is falsy */
  fallback?: ReactNode
}

/**
 * Conditionally renders children based on a feature flag's resolved value.
 *
 * For boolean flags: renders children when true, fallback when false.
 * For number flags: renders children when non-zero, fallback when 0.
 * For string flags: renders children when non-empty, fallback when empty.
 */
export function FeatureFlag({ flag, children, fallback }: FeatureFlagProps): ReactNode {
  const value = useFeatureFlag<unknown>(flag)

  const isEnabled = isTruthy(value)

  if (isEnabled) {
    return children
  }

  return fallback ?? null
}

/**
 * Determine if a resolved flag value should be considered "enabled".
 *
 * - boolean: true
 * - number:  non-zero (including negative values)
 * - string:  non-empty
 * - array:   non-empty
 * - null/undefined: false
 */
function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined) return false

  if (typeof value === "boolean") return value

  if (typeof value === "number") {
    return !Number.isNaN(value) && value !== 0
  }

  if (typeof value === "string") return value.length > 0

  if (Array.isArray(value)) return value.length > 0

  return true
}
