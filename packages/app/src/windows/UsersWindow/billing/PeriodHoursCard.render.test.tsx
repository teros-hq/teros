/**
 * PeriodHoursCard — the temporary period hour-boost control. Assertions that BITE:
 *   - the grant dialog's live preview recomputes `effective → effective + hours`
 *     as the admin types (mutation to the preview math fails the 82/100 cases),
 *   - Confirm sends the EXACT grant payload incl. the note and a stable
 *     idempotencyKey; invalid hours (0 / >10000 / fractional) disable Confirm and
 *     send NOTHING (money-adjacent: block before the call),
 *   - two rapid Confirm clicks fire a SINGLE grant (busy + in-flight guard), and a
 *     retry after a failure reuses the SAME idempotencyKey (mutation: a per-call
 *     key generator makes the two keys differ),
 *   - the active-boosts list renders from getBillingAudit with an origin badge
 *     derived from `source`; Revoke → confirm → revokeHourBoost exact args, then
 *     onChanged fires so the parent refetches.
 *
 *   cd packages/app && npx vitest run src/windows/UsersWindow/billing/PeriodHoursCard.render.test.tsx
 */
import { fireEvent, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import "../../../i18n"
import type { BillingAuditBoost, BillingInfo, UserSummary } from "../../../services/AdminApi"
import { renderWithTamagui } from "../../../test/renderWithTamagui"

const getBillingAudit = vi.hoisted(() => vi.fn())
const grantHourBoost = vi.hoisted(() => vi.fn())
const revokeHourBoost = vi.hoisted(() => vi.fn())
const clientMock = vi.hoisted(() => ({
  admin: {
    getBillingAudit: (...a: unknown[]) => getBillingAudit(...a),
    grantHourBoost: (...a: unknown[]) => grantHourBoost(...a),
    revokeHourBoost: (...a: unknown[]) => revokeHourBoost(...a),
  },
}))
vi.mock("../../../services/terosClientSingleton", () => ({ getTerosClient: () => clientMock }))

import { PeriodHoursCard } from "./PeriodHoursCard"

function mkBilling(over: Partial<BillingInfo> = {}): BillingInfo {
  return {
    planId: "plan_growth",
    planName: "Growth",
    status: "active",
    teamId: null,
    teamName: null,
    unmetered: false,
    effectiveLimit: 80,
    boostHours: 0,
    agentHoursUsed: 40,
    overageHours: 0,
    currentPeriodStart: "2026-06-01",
    currentPeriodEnd: "2026-07-01",
    ...over,
  } as BillingInfo
}

function mkUser(billing: BillingInfo | null): UserSummary {
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

function mkBoost(over: Partial<BillingAuditBoost> = {}): BillingAuditBoost {
  return {
    _id: "boost_1",
    hours: 30,
    periodStart: "2026-06-01",
    periodEnd: "2026-07-01",
    grantedBy: "admin_1",
    accessRequestId: null,
    purchaseId: null,
    source: "admin_grant",
    note: null,
    createdAt: "2026-06-15",
    ...over,
  }
}

function renderCard(opts: { billing?: BillingInfo; onChanged?: () => void } = {}) {
  const billing = opts.billing ?? mkBilling()
  return renderWithTamagui(
    <PeriodHoursCard user={mkUser(billing)} onChanged={opts.onChanged ?? (() => {})} />,
  )
}

beforeEach(() => {
  getBillingAudit.mockReset().mockResolvedValue({ activeBoosts: [] })
  grantHourBoost.mockReset().mockResolvedValue({
    targetUserId: "user_1",
    boostId: "b1",
    hours: 20,
    deduped: false,
    periodEnd: "2026-07-01",
  })
  revokeHourBoost
    .mockReset()
    .mockResolvedValue({ targetUserId: "user_1", boostId: "boost_1", status: "revoked", hours: 30 })
})

describe("PeriodHoursCard grant", () => {
  it("recomputes the live preview as hours are typed", async () => {
    const user = userEvent.setup()
    const { getByTestId } = renderCard()
    fireEvent.click(getByTestId("period-grant-cta"))

    await user.type(getByTestId("period-grant-hours"), "2")
    expect(getByTestId("period-grant-preview").textContent).toContain("82")

    await user.type(getByTestId("period-grant-hours"), "0") // now "20"
    const preview = getByTestId("period-grant-preview").textContent ?? ""
    expect(preview).toContain("80")
    expect(preview).toContain("100")
  })

  it("Confirm sends the exact grant payload incl. note and a string idempotencyKey", async () => {
    const user = userEvent.setup()
    const { getByTestId } = renderCard()
    fireEvent.click(getByTestId("period-grant-cta"))

    await user.type(getByTestId("period-grant-hours"), "20")
    await user.type(getByTestId("period-grant-note"), "launch overflow")
    fireEvent.click(getByTestId("confirm-dialog-confirm"))

    await waitFor(() =>
      expect(grantHourBoost).toHaveBeenCalledWith(
        expect.objectContaining({
          targetUserId: "user_1",
          hours: 20,
          note: "launch overflow",
          idempotencyKey: expect.any(String),
        }),
      ),
    )
    expect(grantHourBoost).toHaveBeenCalledTimes(1)
  })

  it.each([
    "0",
    "10001",
    "1.5",
  ])("invalid hours (%s) disable Confirm and send nothing", async (bad) => {
    const user = userEvent.setup()
    const { getByTestId } = renderCard()
    fireEvent.click(getByTestId("period-grant-cta"))

    await user.type(getByTestId("period-grant-hours"), bad)
    fireEvent.click(getByTestId("confirm-dialog-confirm"))

    expect(grantHourBoost).not.toHaveBeenCalled()
  })

  it("two rapid Confirm clicks fire a single grant (busy + in-flight guard)", async () => {
    // A pending grant keeps the dialog busy so the second click is blocked.
    grantHourBoost.mockReset().mockReturnValue(new Promise(() => {}))
    const user = userEvent.setup()
    const { getByTestId } = renderCard()
    fireEvent.click(getByTestId("period-grant-cta"))

    await user.type(getByTestId("period-grant-hours"), "20")
    fireEvent.click(getByTestId("confirm-dialog-confirm"))
    fireEvent.click(getByTestId("confirm-dialog-confirm"))

    expect(grantHourBoost).toHaveBeenCalledTimes(1)
  })

  it("a retry after a failure reuses the same idempotencyKey", async () => {
    grantHourBoost.mockReset().mockRejectedValueOnce(new Error("boom")).mockResolvedValue({
      targetUserId: "user_1",
      boostId: "b1",
      hours: 20,
      deduped: false,
      periodEnd: "2026-07-01",
    })
    const user = userEvent.setup()
    const { getByTestId, findByTestId } = renderCard()
    fireEvent.click(getByTestId("period-grant-cta"))

    await user.type(getByTestId("period-grant-hours"), "20")
    fireEvent.click(getByTestId("confirm-dialog-confirm")) // call #1 → rejects
    await findByTestId("period-grant-error")

    fireEvent.click(getByTestId("confirm-dialog-confirm")) // call #2 → resolves
    await waitFor(() => expect(grantHourBoost).toHaveBeenCalledTimes(2))

    const first = grantHourBoost.mock.calls[0][0] as { idempotencyKey: string }
    const second = grantHourBoost.mock.calls[1][0] as { idempotencyKey: string }
    expect(first.idempotencyKey).toBe(second.idempotencyKey)
  })

  it("fires onChanged after a successful grant so the parent refetches", async () => {
    const onChanged = vi.fn()
    const user = userEvent.setup()
    const { getByTestId } = renderCard({ onChanged })
    fireEvent.click(getByTestId("period-grant-cta"))

    await user.type(getByTestId("period-grant-hours"), "20")
    fireEvent.click(getByTestId("confirm-dialog-confirm"))

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
  })
})

describe("PeriodHoursCard boosts", () => {
  it("renders active boosts with the origin badge derived from source", async () => {
    getBillingAudit.mockResolvedValue({
      activeBoosts: [mkBoost({ hours: 30, source: "admin_grant" })],
    })
    const { findByText } = renderCard()

    expect(await findByText("+30 h")).toBeTruthy()
    expect(await findByText("admin grant")).toBeTruthy()
  })

  it("Revoke → confirm calls revokeHourBoost with exact args and fires onChanged", async () => {
    getBillingAudit.mockResolvedValue({ activeBoosts: [mkBoost()] })
    const onChanged = vi.fn()
    const { getByTestId, findByTestId } = renderCard({ onChanged })

    fireEvent.click(await findByTestId("period-revoke-boost_1"))
    fireEvent.click(getByTestId("confirm-dialog-confirm"))

    await waitFor(() =>
      expect(revokeHourBoost).toHaveBeenCalledWith({ targetUserId: "user_1", boostId: "boost_1" }),
    )
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
  })
})
