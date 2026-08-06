/**
 * ProviderErrorWidget (TER-699) — the honest, warm per-class error card for
 * Teros LLM-provider failures. The assertions that BITE the design:
 *   - transient (rate_limited/overloaded) → Retry primary + Change model, countdown;
 *   - persistent (spend_gate/model_unavailable/auth) → NO Retry, Change model only;
 *   - the precise cause is NEVER in the body — the literal upstreamMessage stays
 *     inside the collapsed technical disclosure;
 *   - isProviderErrorClass gates exactly the five provider classes.
 *
 * react-i18next is mocked with a deterministic `t` (returns the key) so we assert
 * the i18n KEY, not a locale string. Mutation: flip a CLASS_CONFIG entry
 * (e.g. spend_gate → transient) and the "no Retry when persistent" test goes red.
 *
 *   cd packages/app && npx vitest run src/components/ProviderErrorWidget.render.test.tsx
 */
import { render } from "@testing-library/react"
import { TamaguiProvider } from "tamagui"
import { describe, expect, it, vi } from "vitest"
import config from "../../tamagui.config"

// Partial mock: keep initReactI18next (the app's ../i18n init needs it) but force
// a deterministic `t` so we assert i18n KEYS, locale-independent.
vi.mock("react-i18next", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})

// Avoid react-native Animated timing in jsdom — the dot's opacity is presentational.
vi.mock("../hooks/usePulseAnimation", () => ({ usePulseAnimation: () => 1 }))

vi.mock("@tamagui/lucide-icons", async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>
  const StubIcon = () => null
  return { ...real, AlertTriangle: StubIcon, Lock: StubIcon, Repeat: StubIcon, RefreshCw: StubIcon }
})

import { isProviderErrorClass, ProviderErrorWidget } from "./ProviderErrorWidget"

function renderWidget(
  props: Partial<Parameters<typeof ProviderErrorWidget>[0]> & { errorClass: string },
) {
  const onRetry = vi.fn()
  const onChangeModel = vi.fn()
  const utils = render(
    <TamaguiProvider config={config} defaultTheme="dark">
      <ProviderErrorWidget onRetry={onRetry} onChangeModel={onChangeModel} {...props} />
    </TamaguiProvider>,
  )
  return { ...utils, onRetry, onChangeModel }
}

describe("ProviderErrorWidget — transient (recovers on its own)", () => {
  it("rate_limited → capacity copy + Retry primary + Change model + countdown", () => {
    const { getByText, queryByText } = renderWidget({
      errorClass: "rate_limited",
      retryAfterSecs: 30,
    })
    expect(getByText("errors.provider.capacity.title")).toBeTruthy()
    expect(getByText("errors.provider.capacity.hint")).toBeTruthy()
    // Both actions present; Retry is only offered for transient.
    expect(getByText("common.retry")).toBeTruthy()
    expect(getByText("errors.changeModel")).toBeTruthy()
    // Countdown line appears when retry-after is known.
    expect(queryByText(/errors\.remaining/)).toBeTruthy()
  })

  it("overloaded → overloaded copy, still transient (Retry offered)", () => {
    const { getByText } = renderWidget({ errorClass: "overloaded" })
    expect(getByText("errors.provider.overloaded.title")).toBeTruthy()
    expect(getByText("common.retry")).toBeTruthy()
  })
})

describe("ProviderErrorWidget — persistent (needs a decision)", () => {
  it("spend_gate → billing copy, NO Retry, Change model primary", () => {
    const { getByText, queryByText } = renderWidget({ errorClass: "spend_gate" })
    expect(getByText("errors.provider.billing.title")).toBeTruthy()
    // Persistent never offers Retry — a retry would not help.
    expect(queryByText("common.retry")).toBeNull()
    expect(getByText("errors.changeModel")).toBeTruthy()
    // And no countdown.
    expect(queryByText(/errors\.remaining/)).toBeNull()
  })

  it("not_found → model-unavailable copy, no Retry", () => {
    const { getByText, queryByText } = renderWidget({ errorClass: "not_found" })
    expect(getByText("errors.provider.modelUnavailable.title")).toBeTruthy()
    expect(queryByText("common.retry")).toBeNull()
  })

  it("auth → reconnect-your-credentials copy", () => {
    const { getByText } = renderWidget({ errorClass: "auth" })
    expect(getByText("errors.provider.auth.title")).toBeTruthy()
  })
})

describe("ProviderErrorWidget — the literal upstream text is ops/support only", () => {
  it("keeps upstreamMessage OUT of the body until the technical disclosure is opened", () => {
    const upstream = "429 rate limit exceeded, please try again later"
    const { getByText, queryByText } = renderWidget({
      errorClass: "rate_limited",
      upstreamMessage: upstream,
    })
    // The warm hint is shown; the raw provider text is NOT in the collapsed card.
    expect(getByText("errors.provider.capacity.hint")).toBeTruthy()
    expect(queryByText(upstream)).toBeNull()
    // Only the toggle affordance is visible.
    expect(getByText("errors.showTechnicalDetails")).toBeTruthy()
  })

  it("renders no content for an unknown class (defensive)", () => {
    // ErrorBlock only routes provider classes here, but the widget must no-op on
    // anything unmapped rather than crash — no title, no actions.
    const { queryByText } = renderWidget({ errorClass: "server_error" })
    expect(queryByText("errors.changeModel")).toBeNull()
    expect(queryByText("common.retry")).toBeNull()
    expect(queryByText(/errors\.provider\./)).toBeNull()
  })
})

describe("isProviderErrorClass", () => {
  it("matches exactly the five provider classes, nothing else", () => {
    for (const c of ["rate_limited", "overloaded", "spend_gate", "not_found", "auth"]) {
      expect(isProviderErrorClass(c)).toBe(true)
    }
    for (const c of ["server_error", "connection", "validation", undefined, ""]) {
      expect(isProviderErrorClass(c)).toBe(false)
    }
  })
})
