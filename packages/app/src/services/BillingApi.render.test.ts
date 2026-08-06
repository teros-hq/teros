/**
 * BillingApi — the assertions that bite: every method hits the EXACT WS action
 * with the EXACT payload. A typo in the action string or a renamed field would
 * silently route to the wrong (or no) handler, so we pin both.
 *
 *   cd packages/app && npx vitest run src/services/BillingApi.render.test.ts
 */
import { describe, expect, it, vi } from "vitest"
import { BillingApi } from "./BillingApi"
import type { Transport } from "./transport/types"

function makeApi() {
  const request = vi.fn().mockResolvedValue({})
  const transport = { request } as unknown as Transport
  return { api: new BillingApi(transport), request }
}

describe("BillingApi", () => {
  it("listPlans hits billing.list-plans with an empty payload", async () => {
    const { api, request } = makeApi()
    await api.listPlans()
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith("billing.list-plans", {})
  })

  it("getSubscription hits billing.get-subscription with an empty payload", async () => {
    const { api, request } = makeApi()
    await api.getSubscription()
    expect(request).toHaveBeenCalledWith("billing.get-subscription", {})
  })

  it("changePlan sends the exact planId payload", async () => {
    const { api, request } = makeApi()
    await api.changePlan("plan_growth")
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith("billing.change-plan", { planId: "plan_growth" })
  })

  it("previewPlanChange sends the exact planId payload", async () => {
    const { api, request } = makeApi()
    await api.previewPlanChange("plan_pro")
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith("billing.preview-plan-change", { planId: "plan_pro" })
  })

  it("getInvoices with no limit sends an empty payload (backend default)", async () => {
    const { api, request } = makeApi()
    await api.getInvoices()
    expect(request).toHaveBeenCalledTimes(1)
    // No limit key — an explicit {limit: undefined} would serialize and override
    // the backend's DEFAULT_LIMIT, so the empty payload must stay empty.
    expect(request).toHaveBeenCalledWith("billing.get-invoices", {})
  })

  it("getInvoices forwards an explicit limit", async () => {
    const { api, request } = makeApi()
    await api.getInvoices(50)
    expect(request).toHaveBeenCalledWith("billing.get-invoices", { limit: 50 })
  })

  it("createSetupIntent hits billing.create-setup-intent with an empty payload", async () => {
    const { api, request } = makeApi()
    await api.createSetupIntent()
    expect(request).toHaveBeenCalledWith("billing.create-setup-intent", {})
  })

  it("setPaymentMethod sends the exact paymentMethodId payload", async () => {
    const { api, request } = makeApi()
    await api.setPaymentMethod("pm_abc123")
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith("billing.set-payment-method", {
      paymentMethodId: "pm_abc123",
    })
  })

  it("purchaseBoost sends the exact hours + idempotency reqId payload", async () => {
    const { api, request } = makeApi()
    await api.purchaseBoost(10, "req-abc")
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith("billing.purchase-boost", { hours: 10, reqId: "req-abc" })
  })

  it("requestAccess sends a boost request with the reason when present", async () => {
    const { api, request } = makeApi()
    await api.requestAccess({ requestedHours: 15, reason: "deadline" })
    expect(request).toHaveBeenCalledWith("billing.request-access", {
      type: "boost",
      requestedHours: 15,
      reason: "deadline",
    })
  })

  it("requestAccess OMITS reason when empty (no empty-string key)", async () => {
    const { api, request } = makeApi()
    await api.requestAccess({ requestedHours: 15, reason: "" })
    // MUST BITE: sending reason:"" would persist a blank reason — the key must
    // be absent so the backend treats it as no reason.
    expect(request).toHaveBeenCalledWith("billing.request-access", {
      type: "boost",
      requestedHours: 15,
    })
  })

  it("returns the transport result verbatim", async () => {
    const request = vi.fn().mockResolvedValue({ plans: [{ planId: "plan_pro" }] })
    const api = new BillingApi({ request } as unknown as Transport)
    await expect(api.listPlans()).resolves.toEqual({ plans: [{ planId: "plan_pro" }] })
  })
})
