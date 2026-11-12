/**
 * overlayPresence — the document-level "modal overlay open" signal the
 * desktop shell's native browser views hide behind (Teros Desktop F2 §4,
 * Overlay rule).
 *
 *   cd packages/app && npx vitest run src/services/overlayPresence.render.test.ts
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { isOverlayOpen, subscribeOverlayPresence } from "./overlayPresence"

function dialog(attrs: Record<string, string> = {}): HTMLElement {
  const el = document.createElement("div")
  el.setAttribute("aria-modal", "true")
  el.setAttribute("role", "dialog")
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  return el
}

/** Let the MutationObserver deliver its records (a microtask). */
const flush = () => new Promise<void>((r) => queueMicrotask(r))

afterEach(() => {
  document.body.innerHTML = ""
})

describe("overlayPresence · isOverlayOpen", () => {
  it("an aria-modal element in the document means open", () => {
    expect(isOverlayOpen()).toBe(false)
    const d = dialog()
    document.body.appendChild(d)
    expect(isOverlayOpen()).toBe(true)
    d.remove()
    expect(isOverlayOpen()).toBe(false)
  })

  it("a dialog animating out (data-state=closed) or aria-hidden is not open", () => {
    document.body.appendChild(dialog({ "data-state": "closed" }))
    expect(isOverlayOpen()).toBe(false)
    document.body.appendChild(dialog({ "aria-hidden": "true" }))
    expect(isOverlayOpen()).toBe(false)
    document.body.appendChild(dialog({ "data-state": "open" }))
    expect(isOverlayOpen()).toBe(true)
  })
})

describe("overlayPresence · subscribeOverlayPresence", () => {
  it("notifies when a modal mounts, unmounts, or flips data-state", async () => {
    const listener = vi.fn()
    const off = subscribeOverlayPresence(listener)

    // Nested inside a portal wrapper, like RNW/Tamagui render it.
    const portal = document.createElement("div")
    const sheet = dialog({ "data-state": "open" })
    portal.appendChild(sheet)
    document.body.appendChild(portal)
    await flush()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(isOverlayOpen()).toBe(true)

    sheet.setAttribute("data-state", "closed")
    await flush()
    expect(listener).toHaveBeenCalledTimes(2)
    expect(isOverlayOpen()).toBe(false)

    portal.remove()
    await flush()
    // Already "not open" — removing a closed dialog changes nothing.
    expect(listener).toHaveBeenCalledTimes(2)

    off()
  })

  it("unrelated DOM churn does not notify; the observer stops with the last subscriber", async () => {
    const listener = vi.fn()
    const off = subscribeOverlayPresence(listener)

    const p = document.createElement("p")
    p.textContent = "streaming…"
    document.body.appendChild(p)
    p.textContent = "streaming more…"
    p.remove()
    await flush()
    expect(listener).not.toHaveBeenCalled()

    off()
    document.body.appendChild(dialog())
    await flush()
    expect(listener).not.toHaveBeenCalled()
  })
})
