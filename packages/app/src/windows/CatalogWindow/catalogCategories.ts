/**
 * Unified catalog category system — single source of truth for category order,
 * i18n keys, and icons. Imported by both CatalogWindowContent (the marketplace)
 * and mcaHealth.utils (the health dashboard) so the two views stay synchronised.
 *
 * To add a new category group (e.g. "microsoft"), add it to CAT_ORDER, CAT_I18N,
 * and CAT_ICONS here, then add the corresponding i18n keys.
 */

import type { TFunction } from "i18next"

/**
 * Fixed semantic category order. Category headers always render in this sequence,
 * never alphabetical or by-count. Any catalog category not in this list buckets
 * into "other" (via bucketCategory in mcaHealth.utils).
 *
 * "google" and "microsoft" are curated suite groups that always sit first/second.
 */
export const CAT_ORDER = [
  "google", // Google Suite — always first
  "microsoft", // Microsoft Suite — second
  "communication",
  "productivity",
  "development",
  "ai",
  "media",
  "design",
  "storage",
  "system",
  "data",
  "utility",
  "other",
] as const

export type CategoryKey = (typeof CAT_ORDER)[number]

/**
 * Category → i18n key. Labels are resolved at render time via `t()` so they
 * follow the active locale (es/en/ko). `ai` and `media` share one label because
 * the catalog presents them as a single "AI & Media" group (see CAT_ICONS).
 */
export const CAT_I18N: Record<string, string> = {
  google: "catalog.categoryGoogleSuite",
  microsoft: "catalog.categoryMicrosoftSuite",
  communication: "catalog.categoryCommunication",
  productivity: "catalog.categoryProductivity",
  development: "catalog.categoryDevelopment",
  ai: "catalog.categoryAiMedia",
  media: "catalog.categoryAiMedia",
  design: "catalog.categoryDesign",
  storage: "catalog.categoryStorage",
  system: "catalog.categorySystem",
  data: "catalog.categoryData",
  utility: "catalog.categoryUtility",
  other: "catalog.categoryOther",
}

/** Category → Phosphor icon name (kebab-case, drawn with `Ph`). */
export const CAT_ICONS: Record<string, string> = {
  google: "google-logo",
  microsoft: "microsoft-outlook-logo",
  communication: "chat-circle",
  productivity: "check-square",
  development: "code",
  ai: "sparkle",
  media: "sparkle",
  design: "palette",
  storage: "hard-drives",
  system: "gear-six",
  data: "database",
  utility: "wrench",
  other: "dots-three",
}

/** Localised label for a category key, falling back to the raw key. */
export function categoryLabel(cat: string, t: TFunction): string {
  const key = CAT_I18N[cat]
  return key ? t(key) : cat
}
