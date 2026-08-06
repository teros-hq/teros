/**
 * BillingEditForm — the admin edit form. Assertions that BITE:
 *   - the FULL catalogue (admin.list-plans) is the source, so a hidden internal
 *     tier (plan_unlimited, isPublic:false) is a SELECTABLE chip marked with the
 *     internal suffix, while a public tier is not (mutation: sourcing the public
 *     billing.list-plans would drop it),
 *   - boundary validation: a negative price / fractional limit shows an inline
 *     error and does NOT call updateBillingSubscription,
 *   - a valid save calls updateBillingSubscription with the EXACT payload and
 *     threads the returned subscription up via onSaved.
 *
 *   cd packages/app && npx vitest run src/windows/UsersWindow/billing/BillingEditForm.render.test.tsx
 */
import { fireEvent, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import i18n from "i18next"
import { beforeEach, describe, expect, it, vi } from "vitest"
import "../../../i18n"
import type { BillingInfo, UserSummary } from "../../../services/AdminApi"
import { renderWithTamagui } from "../../../test/renderWithTamagui"

const updateBillingSubscription = vi.hoisted(() =>
  vi.fn((..._a: unknown[]) =>
    Promise.resolve({
      userId: "user_1",
      subscription: { planId: "plan_growth", planName: "Growth", status: "active" },
    }),
  ),
)
const clientMock = vi.hoisted(() => ({
  admin: {
    // admin.list-plans → FULL catalogue incl. the hidden plan_unlimited tier.
    listPlans: vi.fn(() =>
      Promise.resolve({
        plans: [
          { planId: "plan_growth", displayName: "Growth", isPublic: true },
          { planId: "plan_unlimited", displayName: "Unlimited", isPublic: false },
        ],
      }),
    ),
    listTerosProviderConfigs: vi.fn(() => Promise.resolve({ configs: [] })),
    listBillingTeams: vi.fn(() => Promise.resolve({ teams: [] })),
    updateBillingSubscription: (...a: unknown[]) => updateBillingSubscription(...a),
  },
}))
vi.mock("../../../services/terosClientSingleton", () => ({ getTerosClient: () => clientMock }))

import { BillingEditForm } from "./BillingEditForm"

function mkBilling(over: Partial<BillingInfo> = {}): BillingInfo {
  return {
    planId: "plan_growth",
    planName: "Growth",
    status: "active",
    teamId: null,
    teamName: null,
    effectivePrice: 89,
    effectiveLimit: 80,
    agentHoursUsed: 40,
    billingStatus: "waived",
    billingNotes: "",
    customPrice: null,
    customPriceNote: null,
    customAgentHoursLimit: null,
    terosProviderConfigId: null,
    ...over,
  }
}

function mkUser(billing: BillingInfo): UserSummary {
  return {
    userId: "user_1",
    profile: { displayName: "Nora", email: "nora@x.io" },
    role: "user",
    status: "active",
    emailVerified: true,
    accessGranted: true,
    createdAt: "2026-06-01",
    updatedAt: "2026-06-01",
    providers: [],
    stats: { apps: 0, channels: 0 },
    activity: [],
    billing,
  } as UserSummary
}

function renderForm(opts: { onSaved?: (b: BillingInfo) => void } = {}) {
  const billing = mkBilling()
  return renderWithTamagui(
    <BillingEditForm
      user={mkUser(billing)}
      billing={billing}
      onCancel={() => {}}
      onSaved={opts.onSaved ?? (() => {})}
    />,
  )
}

beforeEach(() => {
  updateBillingSubscription.mockClear()
})

describe("BillingEditForm plan chips", () => {
  it("marks the hidden internal tier and leaves the public tier unmarked", async () => {
    const marker = i18n.t("windows.usersPanel.billing.internalTier")
    const { findByTestId, getByTestId } = renderForm()

    const hidden = await findByTestId("billing-plan-plan_unlimited")
    expect(hidden.textContent).toContain(marker)
    expect(getByTestId("billing-plan-plan_growth").textContent).not.toContain(marker)
  })
})

describe("BillingEditForm boundary validation", () => {
  it("blocks a negative price: inline error + no request", async () => {
    const user = userEvent.setup()
    const { getByTestId, findByTestId } = renderForm()
    await findByTestId("billing-plan-plan_growth") // let the mount loads settle

    await user.type(getByTestId("billing-custom-price"), "-5")
    fireEvent.click(getByTestId("billing-save"))

    expect(await findByTestId("billing-error")).toBeTruthy()
    expect(updateBillingSubscription).not.toHaveBeenCalled()
  })

  it("blocks a fractional hours limit: inline error + no request", async () => {
    const user = userEvent.setup()
    const { getByTestId, findByTestId } = renderForm()
    await findByTestId("billing-plan-plan_growth")

    await user.type(getByTestId("billing-custom-limit"), "1.5")
    fireEvent.click(getByTestId("billing-save"))

    expect(await findByTestId("billing-error")).toBeTruthy()
    expect(updateBillingSubscription).not.toHaveBeenCalled()
  })
})

describe("BillingEditForm save", () => {
  it("a valid save sends the exact payload and threads the subscription up", async () => {
    const onSaved = vi.fn()
    const { getByTestId, findByTestId } = renderForm({ onSaved })
    await findByTestId("billing-plan-plan_growth")

    fireEvent.click(getByTestId("billing-save"))

    await waitFor(() =>
      expect(updateBillingSubscription).toHaveBeenCalledWith({
        targetUserId: "user_1",
        planId: undefined,
        customPrice: null,
        customPriceNote: null,
        customAgentHoursLimit: null,
        billingNotes: undefined,
        status: undefined,
        terosProviderConfigId: null,
        teamId: null,
      }),
    )
    expect(updateBillingSubscription).toHaveBeenCalledTimes(1)
    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith({
        planId: "plan_growth",
        planName: "Growth",
        status: "active",
      }),
    )
  })
})
