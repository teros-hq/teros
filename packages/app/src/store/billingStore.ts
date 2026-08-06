/**
 * billingStore — ephemeral, session-local billing UX state (FASE 6 frontend).
 *
 * Driven by the realtime WS events the backend pushes (billing.usage-warning,
 * billing.access-granted/denied/requested). Holds NO UI strings — only the data
 * the components compose into copy. Not persisted: the 80% notice is a nudge, and
 * the hard-block widget always re-renders from the chat error message, so losing
 * this on reload is harmless.
 */

import { create } from 'zustand'

/** Payload of a billing.usage-warning event (80% of the effective limit). */
export interface BillingUsageWarning {
  used: number
  /** Effective limit = base plan limit + active boost hours. */
  limit: number
  boostHours: number
  threshold: number
  /** Internal plan slug (plan.name) — stable id. */
  tier: string
  /** Human-readable plan name (displayName) for the banner copy. */
  planName: string
  periodEnd: string | null
}

/** Outcome of an admin resolution pushed to the requesting user. */
export interface BillingResolution {
  requestType: 'boost' | 'upgrade'
  status: 'approved' | 'denied'
  grantedHours?: number
  planId?: string
}

interface BillingState {
  warning: BillingUsageWarning | null
  warningDismissed: boolean
  /** Count of unseen pending access requests (admin badge). */
  pendingAdminRequests: number
  lastResolution: BillingResolution | null

  setWarning: (warning: BillingUsageWarning) => void
  dismissWarning: () => void
  clearWarning: () => void
  incPendingAdminRequests: () => void
  resetPendingAdminRequests: () => void
  setLastResolution: (resolution: BillingResolution | null) => void
}

export const useBillingStore = create<BillingState>((set) => ({
  warning: null,
  warningDismissed: false,
  pendingAdminRequests: 0,
  lastResolution: null,

  // A fresh warning resurfaces the banner even if a previous one was dismissed.
  setWarning: (warning) => set({ warning, warningDismissed: false }),
  dismissWarning: () => set({ warningDismissed: true }),
  clearWarning: () => set({ warning: null, warningDismissed: false }),
  incPendingAdminRequests: () =>
    set((s) => ({ pendingAdminRequests: s.pendingAdminRequests + 1 })),
  resetPendingAdminRequests: () => set({ pendingAdminRequests: 0 }),
  setLastResolution: (lastResolution) => set({ lastResolution }),
}))
