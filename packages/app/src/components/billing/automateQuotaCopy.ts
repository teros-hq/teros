/**
 * Shared copy helpers for the Automate daily-quota surfaces (chat widget,
 * global banner, Automate window strip): one way to say when the budget
 * resets, in the viewer's locale and timezone.
 */

import { getDateLocale } from "../../i18n"

/** "00:00" / "02:00" in the viewer's timezone, from the ISO reset instant (next 00:00 UTC). */
export function formatResetTime(resetsAt?: string | null): string | null {
  if (!resetsAt) return null
  const d = new Date(resetsAt)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleTimeString(getDateLocale(), { hour: "2-digit", minute: "2-digit" })
}
