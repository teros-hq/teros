/**
 * Web drag-and-drop plumbing shared by the tree and the day plan. Only the
 * 6-dot handle (`data-tdx~="hd"`) starts a drag; the whole row is the drag
 * image; rows are found by `data-tdid`; drop indicators are `data-dz` marks
 * styled in todoFx; the pill tooltip says where the row will land.
 */
export function domOf(ref: { current: unknown }): HTMLElement | null {
  const el = ref.current as HTMLElement | null
  return el && typeof (el as HTMLElement).addEventListener === "function" ? el : null
}

let tipEl: HTMLDivElement | null = null

export function showTip(text: string, x: number, y: number): void {
  if (typeof document === "undefined") return
  if (!tipEl) {
    tipEl = document.createElement("div")
    tipEl.className = "tdx-tip"
    document.body.appendChild(tipEl)
  }
  tipEl.textContent = text
  tipEl.style.left = `${x}px`
  tipEl.style.top = `${y}px`
  tipEl.classList.add("on")
}

export function hideTip(): void {
  tipEl?.classList.remove("on")
}

/** Make every handle under `root` draggable (RN-web does not forward the attribute). */
export function armHandles(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('[data-tdx~="hd"]').forEach((h) => {
    if (h.getAttribute("draggable") !== "true") h.setAttribute("draggable", "true")
  })
}

export function clearMarks(root: ParentNode = document): void {
  root.querySelectorAll("[data-dz]").forEach((r) => r.removeAttribute("data-dz"))
  root.querySelectorAll('[data-dragging="1"]').forEach((r) => r.removeAttribute("data-dragging"))
  root.querySelectorAll('[data-over="1"]').forEach((r) => r.removeAttribute("data-over"))
}

export function rowOf(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? (target.closest("[data-tdid]") as HTMLElement | null) : null
}

export function handleRowOf(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null
  const h = target.closest('[data-tdx~="hd"]')
  return h ? (h.closest("[data-tdid]") as HTMLElement | null) : null
}
