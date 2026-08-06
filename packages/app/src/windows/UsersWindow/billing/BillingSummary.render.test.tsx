/**
 * BillingSummary — the read view. Assertions ported from the old
 * billing-panel render test that still bite:
 *   - the "limit reached" badge shows AT and OVER the effective limit and is
 *     absent below it (mutation: flipping `used >= limit` to `>` fails the "at"
 *     case),
 *   - "Ver auditoría" opens the billing-audit window SCOPED to this user
 *     (userId + resolved userName), via the tiling store.
 *
 *   cd packages/app && npx vitest run src/windows/UsersWindow/billing/BillingSummary.render.test.tsx
 */
import { fireEvent } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import "../../../i18n"
import type { BillingInfo, UserSummary } from "../../../services/AdminApi"
import { renderWithTamagui } from "../../../test/renderWithTamagui"

const openWindowSpy = vi.hoisted(() => vi.fn())
vi.mock("../../../store/tilingStore", () => ({
  useTilingStore: (sel: (s: { openWindow: unknown }) => unknown) =>
    sel({ openWindow: openWindowSpy }),
}))

// The nested PeriodHoursCard fetches getBillingAudit on mount — stub the client so
// this read view test stays deterministic (empty active boosts).
const clientMock = vi.hoisted(() => ({
  admin: { getBillingAudit: vi.fn(() => Promise.resolve({ activeBoosts: [] })) },
}))
vi.mock("../../../services/terosClientSingleton", () => ({ getTerosClient: () => clientMock }))

import { BillingSummary } from "./BillingSummary"

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
    overageHours: 0,
    boostHours: 0,
    billingStatus: "waived",
    billingNotes: "",
    customPrice: null,
    customPriceNote: null,
    customAgentHoursLimit: null,
    terosProviderConfigId: null,
    currentPeriodStart: "2026-06-01",
    currentPeriodEnd: "2026-07-01",
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
    stats: { apps: 0, channels: 0, agents: 0, workspaces: 0, totalCost: 0, totalTokens: 0 },
    activity: [],
    billing,
  } as UserSummary
}

function renderSummary(billing: BillingInfo) {
  return renderWithTamagui(
    <BillingSummary user={mkUser(billing)} billing={billing} onEdit={() => {}} />,
  )
}

beforeEach(() => {
  openWindowSpy.mockClear()
})

describe("BillingSummary", () => {
  it("shows the limit badge when hours reach the effective limit", () => {
    const { getByTestId } = renderSummary(mkBilling({ agentHoursUsed: 80, effectiveLimit: 80 }))
    expect(getByTestId("billing-limit-badge")).toBeTruthy()
  })

  it("shows the limit badge when hours exceed the limit", () => {
    const { getByTestId } = renderSummary(mkBilling({ agentHoursUsed: 95, effectiveLimit: 80 }))
    expect(getByTestId("billing-limit-badge")).toBeTruthy()
  })

  it("hides the limit badge below the limit", () => {
    const { queryByTestId } = renderSummary(mkBilling({ agentHoursUsed: 40, effectiveLimit: 80 }))
    expect(queryByTestId("billing-limit-badge")).toBeNull()
  })

  it("opens the billing-audit window scoped to the user", () => {
    const { getByTestId } = renderSummary(mkBilling())
    fireEvent.click(getByTestId("billing-audit-btn"))
    expect(openWindowSpy).toHaveBeenCalledWith("billing-audit", {
      userId: "user_1",
      userName: "Nora",
    })
  })
})
