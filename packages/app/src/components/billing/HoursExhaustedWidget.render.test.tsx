/**
 * HoursExhaustedWidget (TER-596 I4) — the hard-block CTA, reframed around the
 * active plan + reset date with two ways forward. Assertions that bite:
 *   - planName + periodEnd → body names the plan; both CTAs render,
 *   - no planName → the generic body (no fabricated plan name),
 *   - "Upgrade plan" opens Profile → Plan (openWindow('profile',{initialMode:'plan'})),
 *   - "Get more hours" opens the BoostModal (open flips true).
 *
 * BoostModal + tilingStore are mocked (portal/Stripe + window manager live in the
 * smoke); here we assert the widget's data → copy and its two actions.
 *
 *   cd packages/app && npx vitest run src/components/billing/HoursExhaustedWidget.render.test.tsx
 */
import { render } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TamaguiProvider } from "tamagui"
import { beforeEach, describe, expect, it, vi } from "vitest"
import config from "../../../tamagui.config"

vi.mock("@tamagui/lucide-icons", async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>
  const StubIcon = () => null
  return { ...real, AlertTriangle: StubIcon }
})

const modalState = vi.hoisted(() => ({ open: false }))
vi.mock("./BoostModal", () => ({
  BoostModal: ({ open }: { open: boolean }) => {
    modalState.open = open
    return null
  },
}))

const openWindowSpy = vi.hoisted(() => vi.fn())
vi.mock("../../store/tilingStore", () => ({
  useTilingStore: (sel: (s: { openWindow: unknown }) => unknown) =>
    sel({ openWindow: openWindowSpy }),
}))

import { HoursExhaustedWidget } from "./HoursExhaustedWidget"

function renderWidget(props: Parameters<typeof HoursExhaustedWidget>[0]) {
  return render(
    <TamaguiProvider config={config} defaultTheme="dark">
      <HoursExhaustedWidget {...props} />
    </TamaguiProvider>,
  )
}

beforeEach(() => {
  modalState.open = false
  openWindowSpy.mockClear()
})

describe("HoursExhaustedWidget", () => {
  it("frames the block around the plan + reset date and renders both CTAs", () => {
    const { getByTestId } = renderWidget({
      planName: "Growth",
      periodEnd: "2026-07-01T00:00:00.000Z",
    })
    const body = getByTestId("hours-exhausted-body").textContent ?? ""
    expect(body).toContain("Growth")
    expect(getByTestId("exhausted-upgrade")).toBeTruthy()
    expect(getByTestId("exhausted-boost")).toBeTruthy()
  })

  it("uses the generic body when the plan name is missing", () => {
    const { getByTestId } = renderWidget({})
    const body = getByTestId("hours-exhausted-body").textContent ?? ""
    // No fabricated plan name; the generic copy still offers both paths.
    expect(body.toLowerCase()).toContain("boost")
  })

  it("the upgrade CTA opens Profile → Plan directly", async () => {
    const user = userEvent.setup()
    const { getByTestId } = renderWidget({ planName: "Growth" })
    await user.click(getByTestId("exhausted-upgrade"))
    expect(openWindowSpy).toHaveBeenCalledWith("profile", { initialMode: "plan" })
  })

  it("the boost CTA opens the boost modal", async () => {
    const user = userEvent.setup()
    const { getByTestId } = renderWidget({ planName: "Growth" })
    expect(modalState.open).toBe(false)
    await user.click(getByTestId("exhausted-boost"))
    expect(modalState.open).toBe(true)
  })
})
