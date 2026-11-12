/**
 * Relative-time formatting for the Automate grid ("2h ago", "just now").
 *
 * Local to the Automate window (BoardWindow ships its own Spanish-only
 * variant); i18n-aware via the injected `t` so en/es/ko all render naturally.
 * Falls back to a locale date string for anything older than 30 days.
 */

export type TranslateFn = (
  key: string,
  fallback: string,
  options?: Record<string, unknown>,
) => string

export function formatRelativeTime(iso: string | null | undefined, t: TranslateFn): string {
  if (!iso) return t('automate.never', 'never')

  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return t('automate.never', 'never')

  const seconds = Math.floor((Date.now() - then) / 1000)
  if (seconds < 60) return t('automate.time.justNow', 'just now')

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return t('automate.time.minutesAgo', '{{count}}m ago', { count: minutes })

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('automate.time.hoursAgo', '{{count}}h ago', { count: hours })

  const days = Math.floor(hours / 24)
  if (days < 30) return t('automate.time.daysAgo', '{{count}}d ago', { count: days })

  return new Date(iso).toLocaleDateString()
}
