import { act, render } from "@testing-library/react"
import { TamaguiProvider } from "tamagui"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import config from "../../../tamagui.config"
import { CONSENT_MOTION_MS, ConsentToggle, splitLabels } from "./BrowserToolbar"

const original = window.matchMedia
const prefers = (reduced: boolean) => {
  window.matchMedia = ((query: string) => ({
    matches: reduced && query.includes("prefers-reduced-motion: reduce"),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
}
const ui = (consent: boolean, disabled = false) => (
  <TamaguiProvider config={config} defaultTheme="light">
    <ConsentToggle consent={consent} disabled={disabled} onToggle={() => {}} />
  </TamaguiProvider>
)
const mount = (consent: boolean, disabled = false) => {
  const view = render(ui(consent, disabled))
  const toggle = view.getByTestId("nbw-consent")
  return { view, toggle, set: (next: boolean) => view.rerender(ui(next, disabled)) }
}
const rest = (el: HTMLElement) => {
  const s = getComputedStyle(el)
  return {
    text: el.textContent,
    label: el.getAttribute("aria-label"),
    checked: el.getAttribute("aria-checked"),
    height: s.height,
    radius: s.borderTopLeftRadius,
    background: s.backgroundColor,
    border: s.borderTopColor,
    borderWidth: s.borderTopWidth,
    opacity: s.opacity,
    paddingLeft: s.paddingLeft,
    paddingRight: s.paddingRight,
  }
}
const transitions = (el: HTMLElement) =>
  [el, ...Array.from(el.querySelectorAll<HTMLElement>("*"))]
    .map((node) => getComputedStyle(node))
    .filter((s) => (s.transitionProperty && s.transitionProperty !== "all") || s.animationName)
    .filter((s) => s.transitionDuration !== "0s" || (s.animationName && s.animationName !== "none"))

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  window.matchMedia = original
})

describe("the Agent switch animates its change, and stands still for whoever asks for less motion", () => {
  it("[DBAC-AC-8] the two labels share their stem, so only the tail moves", () => {
    expect(splitLabels({ on: "Agent", off: "Agent off" })).toEqual({
      stem: "Agent",
      on: "",
      off: " off",
    })
    expect(splitLabels({ on: "Yes", off: "No" })).toEqual({ stem: "", on: "Yes", off: "No" })
  })

  it("[DBAC-AC-8] with reduced motion nothing transitions and nothing lingers after a switch", () => {
    prefers(true)
    const { toggle, set } = mount(false)
    expect(toggle.getAttribute("data-motion")).toBe("off")
    expect(transitions(toggle)).toEqual([])
    expect(toggle.textContent).toBe("Agent off")
    set(true)
    expect(toggle.textContent).toBe("Agent")
    expect(transitions(toggle)).toEqual([])
    set(false)
    expect(toggle.textContent).toBe("Agent off")
    expect(toggle.querySelector('[data-testid="nbw-consent-tail"]')).toBeNull()
  })

  it("[DBAC-AC-8] with motion the switch transitions its look and its width for about 200 ms", () => {
    prefers(false)
    const { toggle } = mount(false)
    expect(toggle.getAttribute("data-motion")).toBe("on")
    expect(CONSENT_MOTION_MS).toBeGreaterThanOrEqual(180)
    expect(CONSENT_MOTION_MS).toBeLessThanOrEqual(220)
    const own = getComputedStyle(toggle)
    expect(own.transitionProperty).toContain("background-color")
    expect(own.transitionProperty).toContain("border-color")
    expect(own.transitionDuration).toBe(`${CONSENT_MOTION_MS}ms`)
    const tail = getComputedStyle(
      toggle.querySelector('[data-testid="nbw-consent-tail"]') as HTMLElement,
    )
    expect(tail.transitionProperty).toBe("width")
    expect(tail.overflowX).toBe("hidden")
  })

  it("[DBAC-AC-8] the leaving words are hidden from readers and gone once the switch has settled", () => {
    prefers(false)
    const { toggle, set } = mount(false)
    expect(toggle.textContent).toBe("Agent off")
    set(true)
    const leaving = toggle.querySelector('[aria-hidden="true"][dir]') as HTMLElement
    expect(leaving.textContent).toBe(" off")
    expect(getComputedStyle(leaving).opacity).toBe("0")
    expect(getComputedStyle(leaving).position).toBe("absolute")
    expect(getComputedStyle(leaving.parentElement as HTMLElement).minHeight).toBe("12px")
    act(() => {
      vi.advanceTimersByTime(CONSENT_MOTION_MS)
    })
    expect(toggle.textContent).toBe("Agent")
    set(false)
    expect(toggle.textContent).toBe("Agent off")
  })

  it("[DBAC-AC-8] at rest the switch is the same with and without motion, off, on and disabled", () => {
    for (const [consent, disabled] of [
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ] as const) {
      prefers(true)
      const still = mount(consent, disabled)
      const expected = rest(still.toggle)
      still.view.unmount()
      prefers(false)
      const moving = mount(consent, disabled)
      expect(rest(moving.toggle)).toEqual(expected)
      moving.view.unmount()
    }
    prefers(true)
    const settled = mount(false)
    settled.set(true)
    const after = rest(settled.toggle)
    settled.view.unmount()
    expect(after).toEqual(rest(mount(true).toggle))
  })
})
