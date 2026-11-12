/**
 * useBillingRealtimeSync — subscribes the billingStore to the billing.* WS events
 * the backend pushes (FASE 6 frontend). Mounted once, globally, in the workspace
 * layout (same pattern as the navbar realtime sync: client.on + cleanup off).
 *
 * Events (backend → user):
 *   - billing.usage-warning   → 80% nudge (non-invasive banner, decision #11)
 *   - automate.quota-exhausted → the day's Automate runs are spent (toast + banner, once a day)
 *   - billing.access-granted  → an admin approved a boost/upgrade → unblock
 *   - billing.access-denied   → an admin denied the request
 *   - billing.access-requested→ (admins only — backend routes to the team's admin
 *     owner or to all admins) badge
 */

import { useEffect, useRef } from 'react'
import { useToast } from '../../components/Toast'
import i18n from '../../i18n'
import { getTerosClient } from '../../services/terosClientSingleton'
import { useBillingStore } from '../../store/billingStore'
import { useTilingStore } from '../../store/tilingStore'

export function useBillingRealtimeSync(): void {
  const toast = useToast()
  // Keep the latest toast controller without re-subscribing the WS listeners:
  // the effect runs once ([]), so it reads the controller through a live ref.
  const toastRef = useRef(toast)
  toastRef.current = toast

  useEffect(() => {
    const client = getTerosClient()
    const store = useBillingStore.getState

    const handleUsageWarning = (data: any) => {
      // Defensive: only act on a well-formed payload (data, not UI).
      if (!data || typeof data.used !== 'number' || typeof data.limit !== 'number') return
      store().setWarning({
        used: data.used,
        limit: data.limit,
        boostHours: typeof data.boostHours === 'number' ? data.boostHours : 0,
        threshold: typeof data.threshold === 'number' ? data.threshold : 0.8,
        tier: typeof data.tier === 'string' ? data.tier : '',
        planName: typeof data.planName === 'string' ? data.planName : '',
        periodEnd: typeof data.periodEnd === 'string' ? data.periodEnd : null,
      })
    }

    const handleGranted = (data: any) => {
      if (!data) return
      store().setLastResolution({
        requestType: data.requestType,
        status: 'approved',
        grantedHours: typeof data.grantedHours === 'number' ? data.grantedHours : undefined,
        planId: typeof data.planId === 'string' ? data.planId : undefined,
      })
      // More hours (boost) or a bigger plan (upgrade) → the 80% nudge is stale.
      store().clearWarning()
      // Surface the admin's decision (the user may not have the panel open).
      const grantedHours = typeof data.grantedHours === 'number' ? data.grantedHours : null
      toastRef.current.success(
        i18n.t('billing.toast.grantedTitle'),
        grantedHours !== null
          ? i18n.t('billing.toast.grantedBoost', { hours: grantedHours })
          : i18n.t('billing.toast.grantedUpgrade'),
      )
    }

    const handleDenied = (data: any) => {
      if (!data) return
      store().setLastResolution({ requestType: data.requestType, status: 'denied' })
      toastRef.current.warning(
        i18n.t('billing.toast.deniedTitle'),
        i18n.t('billing.toast.deniedBody'),
      )
    }

    const handleAutomateQuota = (data: any) => {
      if (!data || typeof data.used !== 'number' || typeof data.limit !== 'number') return
      store().setAutomateQuota({
        used: data.used,
        limit: data.limit,
        planId: typeof data.planId === 'string' ? data.planId : '',
        planName: typeof data.planName === 'string' ? data.planName : '',
        resetsAt: typeof data.resetsAt === 'string' ? data.resetsAt : '',
        starterId: typeof data.starterId === 'string' ? data.starterId : '',
        starterName: typeof data.starterName === 'string' ? data.starterName : '',
        workspaceId: typeof data.workspaceId === 'string' ? data.workspaceId : '',
        topStarters: Array.isArray(data.topStarters) ? data.topStarters : [],
      })
      // The user may be nowhere near Automate: a toast with a way in.
      toastRef.current.show(i18n.t('billing.automateQuota.toastTitle', { limit: data.limit, plan: data.planName ?? '' }), {
        type: 'warning',
        message: i18n.t('billing.automateQuota.toastBody', { name: data.starterName ?? '' }),
        duration: 10_000,
        action: {
          label: i18n.t('billing.automateQuota.openAutomate'),
          onPress: () => useTilingStore.getState().openWindow('automate', {}),
        },
      })
    }

    const handleRequested = () => {
      // Backend routes this to the team's admin owner or to all admins (TER-596
      // T1) — always an admin/super, so a non-admin never receives it.
      store().incPendingAdminRequests()
    }

    client.on('billing.usage-warning', handleUsageWarning)
    client.on('billing.access-granted', handleGranted)
    client.on('billing.access-denied', handleDenied)
    client.on('billing.access-requested', handleRequested)
    client.on('automate.quota-exhausted', handleAutomateQuota)

    return () => {
      client.off('billing.usage-warning', handleUsageWarning)
      client.off('billing.access-granted', handleGranted)
      client.off('billing.access-denied', handleDenied)
      client.off('billing.access-requested', handleRequested)
      client.off('automate.quota-exhausted', handleAutomateQuota)
    }
  }, [])
}
