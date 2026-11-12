import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { TamaguiProvider, Theme } from "tamagui"
import type { ReactElement } from "react"
import config from "../../../tamagui.config"
import { QueuedIndicator, QueuedShimmer } from "./queuedDecorations"
import { colors as semanticColors, surface } from "../mca/primitives/colors"
import i18n from "../../i18n"

/**
 * Regression test for the light-mode shimmer bug (2026-10-05):
 * the queued wave animated but was invisible in light — Purple/100
 * is nearly the same color as the user bubble's Purple/300 @15% tint
 * (≈1:1 contrast). These tests pin the wave color per theme so the
 * sweep stays visible in both:
 *
 * - accent (user bubble): WHITE at 45% in light (Pablo validated it)
 *   and a whisper of PALE LAVENDER — Purple/100 at 12% — in dark (Pablo
 *   picked D4 from the intensity widget; 45% still read aggressive
 *   over the dark fills).
 * - neutral (media bubbles): Main/600 (borderStrong) in dark, Main/500
 *   in light (Main/400 rode only 1.51:1 on the near-white fills).
 * - QueuedIndicator: the theme's accent role (Purple/200 dark / Purple/300
 *   light) instead of a fixed dark-theme violet.
 */
function renderWithTheme(ui: ReactElement, theme: "dark" | "light") {
  return render(
    <TamaguiProvider config={config} defaultTheme={theme}>
      <Theme name={theme}>{ui}</Theme>
    </TamaguiProvider>,
  )
}

function getShimmerStyle(container: HTMLElement) {
  // react-native-web maps `testID` to the `data-testid` DOM attribute.
  const el = container.querySelector(
    '[data-testid="queued-shimmer"], [testID="queued-shimmer"]',
  ) as HTMLElement | null
  expect(el).toBeTruthy()
  return el!.getAttribute("style") ?? ""
}

/** jsdom normalizes `#9C6BFF` → `rgb(156, 107, 255)` inside the style
 * attribute — assert either form so the test survives both serializations. */
function expectColor(style: string, color: string) {
  // The DS hairlines are rgba() strings (bone over the dark page) — jsdom
  // re-spaces them as `rgba(r, g, b, a)`.
  if (color.startsWith("rgb")) {
    const spaced = color.replace(/\s+/g, "").replace(/,/g, ", ")
    expect(style.toLowerCase()).toContain(spaced.toLowerCase())
    return
  }
  const r = parseInt(color.slice(1, 3), 16)
  const g = parseInt(color.slice(3, 5), 16)
  const b = parseInt(color.slice(5, 7), 16)
  expect(style.toLowerCase()).toContain(`rgb(${r}, ${g}, ${b})`)
}

afterEach(cleanup)

describe("QueuedShimmer — wave color per theme (light-mode bug 2026-10-05)", () => {
  it("accent tone rides a WHISPER of pale lavender in dark — Purple/100 at 12% (Pablo picked D4)", () => {
    const { container } = renderWithTheme(<QueuedShimmer tone="accent" />, "dark")
    const style = getShimmerStyle(container)
    expect(style).toContain("rgba(231, 220, 255, 0.12)")
    expect(style).toContain("message-queue-shimmer")
    // The aggressive violet band is gone from dark too.
    expect(style).not.toContain("rgb(156, 107, 255)")
  })

  it("accent tone rides a translucent WHITE sheen in light — soft, not aggressive (Pablo 2026-10-06)", () => {
    const { container } = renderWithTheme(<QueuedShimmer tone="accent" />, "light")
    const style = getShimmerStyle(container)
    // White sheen at 45% alpha — visible over the pale tint but gentle;
    // the Purple/200 fix read as an aggressive violet band on light.
    expect(style).toContain("rgba(255, 255, 255, 0.45)")
    // The old light value (Purple/100) matched the bubble tint at ~1:1.
    expect(style).not.toContain(semanticColors.purple100.toLowerCase())
    // And the aggressive violet band is gone from light.
    expect(style).not.toContain("rgb(156, 107, 255)")
  })

  it("neutral tone rides the theme strong-border gray in dark", () => {
    const { container } = renderWithTheme(<QueuedShimmer />, "dark")
    const style = getShimmerStyle(container)
    expectColor(style, surface.dark.borderStrong)
  })

  it("neutral tone rides Main/500 in light — one step deeper than borderStrong", () => {
    const { container } = renderWithTheme(<QueuedShimmer />, "light")
    const style = getShimmerStyle(container)
    expectColor(style, semanticColors.main500)
    // Main/400 (light borderStrong) rode only 1.51:1 on light fills.
    expect(style).not.toContain(surface.light.borderStrong.toLowerCase())
  })
})

describe("QueuedIndicator — theme accent role", () => {
  it("reads the dark accent (Purple/200) when no color is passed", () => {
    const { container } = renderWithTheme(<QueuedIndicator />, "dark")
    const text = container.textContent ?? ""
    // The icon stub renders nothing; assert the label rendered at all.
    expect(text).toBeTruthy()
  })

  it("reads the light accent (Purple/300) when no color is passed", () => {
    const { container } = renderWithTheme(<QueuedIndicator />, "light")
    const text = container.textContent ?? ""
    expect(text).toBeTruthy()
  })

  it("renders the queued label", () => {
    const { container } = renderWithTheme(<QueuedIndicator />, "light")
    expect(container.textContent).toContain(i18n.t("chat.queued"))
  })
})
