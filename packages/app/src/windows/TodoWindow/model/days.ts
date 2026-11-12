/**
 * Calendar days as 'YYYY-MM-DD' strings in the user's LOCAL calendar (the
 * backend stores them verbatim and never converts time zones).
 */

const pad = (n: number) => String(n).padStart(2, "0")

export function isoDay(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function parseDay(day: string): Date {
  const [y, m, d] = day.split("-").map(Number)
  return new Date(y, (m || 1) - 1, d || 1)
}

export function todayIso(now: Date = new Date()): string {
  return isoDay(now)
}

export function addDays(day: string, k: number): string {
  const d = parseDay(day)
  d.setDate(d.getDate() + k)
  return isoDay(d)
}

/** Whole days from `today` to `day` (negative = past). */
export function dayDiff(day: string, today: string): number {
  return Math.round((parseDay(day).getTime() - parseDay(today).getTime()) / 864e5)
}

/** "jue 22 oct" / "Thu 22 Oct" — short weekday, day, short month, no punctuation. */
export function shortDay(day: string, locale: string): string {
  const d = parseDay(day)
  const wd = new Intl.DateTimeFormat(locale, { weekday: "short" }).format(d).replace(/[.,]/g, "")
  const mo = new Intl.DateTimeFormat(locale, { month: "short" }).format(d).replace(/[.,]/g, "")
  return locale.startsWith("ko") ? `${mo} ${d.getDate()}일 ${wd}` : `${wd} ${d.getDate()} ${mo}`
}

/** "sábado, 24 de octubre" */
export function longDay(day: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long" }).format(parseDay(day))
}

/** "domingo" */
export function weekdayLong(day: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: "long" }).format(parseDay(day))
}

/**
 * Relative label: today / tomorrow / yesterday via the given words, else the
 * short day.
 */
export function relativeDay(
  day: string,
  today: string,
  locale: string,
  words: { today: string; tomorrow: string; yesterday: string },
): string {
  const k = dayDiff(day, today)
  if (k === 0) return words.today
  if (k === 1) return words.tomorrow
  if (k === -1) return words.yesterday
  return shortDay(day, locale)
}

/** Clock "09:06" for a timestamp of today, `yesterday` for yesterday, else a short date. */
export function stamp(ts: number, locale: string, yesterday: string, now: Date = new Date()): string {
  const d = new Date(ts)
  if (isoDay(d) === isoDay(now)) return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const y = new Date(now)
  y.setDate(now.getDate() - 1)
  if (isoDay(d) === isoDay(y)) return yesterday
  return shortDay(isoDay(d), locale)
}
