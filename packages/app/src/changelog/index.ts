/**
 * Changelog types and data loader
 *
 * The changelog source of truth is `changelog.json` in this directory.
 * Developers add a new entry with each release. The "What's New" modal
 * compares the user's `lastChangelogSeen` (stored in their profile) against
 * the entries here to decide whether to show itself.
 */

import changelogData from './changelog.json'

export type ChangelogCategory = 'feature' | 'fix' | 'improvement' | 'breaking'

export type Locale = 'en' | 'es' | 'ko'

/**
 * A string that may be translated into multiple languages.
 * `en` is required and serves as the fallback.
 */
export type LocalizedString = {
  en: string
  es?: string
  ko?: string
}

export interface ChangelogEntry {
  /** Unique, stable identifier (e.g. "2026-07-19-whats-new-modal") */
  id: string
  /** ISO date string (YYYY-MM-DD) */
  date: string
  /** Category — controls icon and color */
  category: ChangelogCategory
  /** Short headline shown in the card header */
  title: LocalizedString
  /** One-line description (for future list views) */
  description: string
  /** Markdown body — supports images, headers, lists, links, bold, code, etc. */
  content: LocalizedString
  /** Optional icon key override (defaults to category icon) */
  icon?: CategoryMeta['icon']
}

export interface ChangelogData {
  entries: ChangelogEntry[]
}

/**
 * All changelog entries, ordered oldest → newest.
 * The JSON file is the source of truth; we trust its ordering.
 */
export function getAllChangelogEntries(): ChangelogEntry[] {
  return (changelogData as ChangelogData).entries
}

/**
 * The ID of the most recent changelog entry, or null if there are no entries.
 */
export function getLatestChangelogId(): string | null {
  const entries = getAllChangelogEntries()
  if (entries.length === 0) return null
  return entries[entries.length - 1].id
}

/**
 * Returns entries the user has NOT seen yet (i.e. entries whose id is more
 * recent than `lastSeenId`). If `lastSeenId` is null/undefined, all entries
 * are considered unseen.
 *
 * Entries are returned oldest → newest so the carousel starts from the
 * oldest unseen update.
 */
export function getUnseenChangelogEntries(lastSeenId?: string | null): ChangelogEntry[] {
  const entries = getAllChangelogEntries()
  if (!lastSeenId) return entries

  const seenIndex = entries.findIndex((e) => e.id === lastSeenId)
  if (seenIndex === -1) return entries // id not found → show everything
  return entries.slice(seenIndex + 1)
}


// ─── Localization helpers ─────────────────────────────────────────────────────

/**
 * Returns the best available localized string for the given field.
 * Falls back to English if the requested locale is not available.
 */
export function getLocalized(field: LocalizedString, locale: string): string {
  const lang = locale.split('-')[0] as Locale
  return field[lang] ?? field.en
}

/**
 * Returns a ChangelogEntry with title and content resolved to strings
 * for the given locale. Useful for rendering.
 */
export function getLocalizedEntry(entry: ChangelogEntry, locale: string): Omit<ChangelogEntry, 'title' | 'content'> & { title: string; content: string } {
  return {
    ...entry,
    title: getLocalized(entry.title, locale),
    content: getLocalized(entry.content, locale),
  }
}

// ─── Category metadata (icons + colors) ──────────────────────────────────────

export interface CategoryMeta {
  /** Icon key — resolved to SVG by WhatsNewModal */
  icon: 'rocket' | 'trending-up' | 'wrench' | 'alert-triangle'
  /** Semantic color key — resolved against the design system */
  colorKey: 'green' | 'orange' | 'blue' | 'red'
}

export const CATEGORY_META: Record<ChangelogCategory, CategoryMeta> = {
  feature: { icon: 'rocket', colorKey: 'green' },
  improvement: { icon: 'trending-up', colorKey: 'blue' },
  fix: { icon: 'wrench', colorKey: 'orange' },
  breaking: { icon: 'alert-triangle', colorKey: 'red' },
}
