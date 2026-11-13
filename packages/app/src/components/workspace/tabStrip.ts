export const TAB_SNAP_LEAD = 20
export const TAB_TITLE_KEEP = 40
export const TAB_MARKS_YIELD = 1000

export function tabStripEndPad(
  starts: readonly number[],
  contentWidth: number,
  viewWidth: number,
  lead: number = TAB_SNAP_LEAD,
): number {
  const overflow = contentWidth - viewWidth
  if (overflow <= 0) return 0
  const rest = starts.map((start) => Math.max(0, start - lead)).find((at) => at >= overflow)
  return rest === undefined ? 0 : Math.round(rest - overflow)
}

export function measureTabStrip(
  el: HTMLElement,
  pad: number,
): { starts: number[]; contentWidth: number; viewWidth: number } {
  const left = el.getBoundingClientRect().left
  const starts = Array.from(el.querySelectorAll<HTMLElement>("[data-tab]")).map(
    (tab) => tab.getBoundingClientRect().left - left + el.scrollLeft,
  )
  return { starts, contentWidth: el.scrollWidth - pad, viewWidth: el.clientWidth }
}

export const TAB_FADE = 24

export function tabStripReveal(
  starts: readonly number[],
  tabStart: number,
  tabEnd: number,
  viewWidth: number,
  scrollLeft: number,
  lead: number = TAB_SNAP_LEAD,
  fade: number = TAB_FADE,
): number | null {
  if (tabStart >= scrollLeft && tabEnd + fade <= scrollLeft + viewWidth) return null
  const own = Math.max(0, tabStart - lead)
  if (tabStart < scrollLeft) return own
  const rest = starts
    .map((start) => Math.max(0, start - lead))
    .filter((at) => at <= own)
    .find((at) => at + viewWidth >= tabEnd + fade)
  return rest ?? own
}

export function measureTab(
  el: HTMLElement,
  windowId: string,
): { start: number; end: number } | null {
  const tab = Array.from(el.querySelectorAll<HTMLElement>("[data-tab]")).find(
    (candidate) => candidate.getAttribute("data-window-id") === windowId,
  )
  if (!tab) return null
  const rect = tab.getBoundingClientRect()
  const start = rect.left - el.getBoundingClientRect().left + el.scrollLeft
  return { start, end: start + rect.width }
}
