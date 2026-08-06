/**
 * BillingRequestsWindow — admin queue for billing access requests (FASE 6,
 * decision #10). Lists billing_access_requests via admin.list-access-requests and
 * resolves them via admin.resolve-access-request (approve boost with optional
 * grantedHours override, or deny — both with an optional note). Refreshes live on
 * billing.access-requested. Admin/super only (the backend enforces it too).
 *
 * Backend returns DATA (resolved userName/email, requestedPlanName); this window
 * composes the copy.
 */

import { Check, CreditCard, X } from '@tamagui/lucide-icons'
import { useEffect, useState } from 'react'
import { ScrollView, TouchableOpacity, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import { Button, Input, Text, XStack, YStack } from 'tamagui'
import { AppSpinner } from '../../components/ui'
import { useColors } from '../../components/mca/primitives/useColors'
import { colors as semanticColors, surface } from '../../components/mca/primitives/colors'
import { getTerosClient } from '../../services/terosClientSingleton'
import { useBillingStore } from '../../store/billingStore'
import {
  buildResolvePayload,
  formatEstimatedCost,
  formatRequesterContext,
  type RequestStatus,
} from './payload'

interface AccessRequest {
  _id: string
  userId: string
  userName: string | null
  userEmail: string | null
  type: 'boost' | 'upgrade'
  requestedHours: number | null
  requestedPlanId: string | null
  requestedPlanName: string | null
  reason: string | null
  status: RequestStatus
  createdAt: string
  // Requester's live billing context (A1).
  currentPlanName: string | null
  agentHoursUsed: number | null
  agentHoursLimit: number | null
  usagePct: number | null
  estimatedCost: number | null
  estimatedCostCurrency: string
}

const STATUSES: RequestStatus[] = ['pending', 'approved', 'denied']

export function BillingRequestsWindowContent(_props: { windowId: string }) {
  const { t } = useTranslation()
  const c = useColors()
  const isDark = c.bgPage === surface.dark.bgPage
  const client = getTerosClient()
  const resetPendingAdminRequests = useBillingStore((s) => s.resetPendingAdminRequests)

  const [status, setStatus] = useState<RequestStatus>('pending')
  const [requests, setRequests] = useState<AccessRequest[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState(false)
  const [grantHours, setGrantHours] = useState<Record<string, string>>({})
  const [note, setNote] = useState<Record<string, string>>({})
  const [resolving, setResolving] = useState<Set<string>>(new Set())

  const load = async (forStatus: RequestStatus) => {
    setIsLoading(true)
    setError(false)
    try {
      const res = (await client.send('admin', 'list-access-requests', {
        status: forStatus,
      })) as { requests: AccessRequest[] }
      setRequests(res?.requests ?? [])
    } catch {
      setError(true)
      setRequests([])
    } finally {
      setIsLoading(false)
    }
  }

  // Reload on status change. Reset the admin badge on mount (the queue is now seen).
  useEffect(() => {
    load(status)
  }, [status])

  useEffect(() => {
    resetPendingAdminRequests()
  }, [resetPendingAdminRequests])

  // Live refresh: a new request landed while the pending queue is open.
  useEffect(() => {
    const onRequested = () => {
      if (status === 'pending') load('pending')
    }
    client.on('billing.access-requested', onRequested)
    return () => client.off('billing.access-requested', onRequested)
  }, [status])

  const resolve = async (req: AccessRequest, action: 'approve' | 'deny') => {
    if (resolving.has(req._id)) return
    setResolving((prev) => new Set(prev).add(req._id))
    try {
      const data = buildResolvePayload(req, action, grantHours[req._id], note[req._id])
      await client.send('admin', 'resolve-access-request', data)
      // Drop it from the (pending) list immediately for snappy UX.
      setRequests((prev) => prev.filter((r) => r._id !== req._id))
    } catch {
      // Reload to reflect server truth (e.g. resolved concurrently).
      load(status)
    } finally {
      setResolving((prev) => {
        const next = new Set(prev)
        next.delete(req._id)
        return next
      })
    }
  }

  return (
    <YStack flex={1} backgroundColor={c.bgPage}>
      {/* Header */}
      <XStack
        height={40}
        paddingHorizontal={12}
        alignItems="center"
        justifyContent="space-between"
        borderBottomWidth={1}
        borderBottomColor={isDark ? 'rgba(39,39,42,0.6)' : c.bgInner}
      >
        <XStack gap={8} alignItems="center">
          <CreditCard size={16} color={semanticColors.indigo} />
          <Text fontSize={12} fontWeight="600" color={c.text}>
            {t('billing.admin.title')}
          </Text>
        </XStack>
        <XStack gap={4}>
          {STATUSES.map((s) => (
            <TouchableOpacity
              key={s}
              testID={`billing-req-tab-${s}`}
              onPress={() => setStatus(s)}
              activeOpacity={0.7}
              style={{
                paddingHorizontal: 8,
                paddingVertical: 3,
                borderRadius: 6,
                backgroundColor: status === s ? c.badges.info.bg : 'transparent',
              }}
            >
              <Text fontSize={11} fontWeight="600" color={status === s ? c.badges.info.text : c.text3}>
                {t(`billing.admin.${s}`)}
              </Text>
            </TouchableOpacity>
          ))}
        </XStack>
      </XStack>

      {/* Content */}
      {isLoading ? (
        <YStack flex={1} justifyContent="center" alignItems="center">
          <AppSpinner variant="brand" />
        </YStack>
      ) : error ? (
        <YStack testID="billing-req-error" flex={1} justifyContent="center" alignItems="center" padding={20}>
          <Text fontSize={13} color={c.badges.err.text}>
            {t('billing.admin.loadError')}
          </Text>
        </YStack>
      ) : requests.length === 0 ? (
        <YStack testID="billing-req-empty" flex={1} justifyContent="center" alignItems="center" padding={20}>
          <Text fontSize={13} color={c.text3} textAlign="center">
            {t('billing.admin.empty', { status: t(`billing.admin.${status}`).toLowerCase() })}
          </Text>
        </YStack>
      ) : (
        <ScrollView style={{ flex: 1 }}>
          <YStack padding={12} gap={10}>
            {requests.map((req) => (
              <YStack
                key={req._id}
                testID={`billing-req-${req._id}`}
                borderRadius={8}
                borderWidth={1}
                borderColor={c.badges.info.border}
                backgroundColor={c.bgCard}
                padding={12}
                gap={8}
              >
                <XStack alignItems="center" justifyContent="space-between" gap={8}>
                  <YStack flex={1}>
                    <Text fontSize={13} fontWeight="600" color={c.text}>
                      {req.userName || req.userEmail || req.userId}
                    </Text>
                    {req.userEmail && req.userName && (
                      <Text fontSize={11} color={c.text2}>
                        {req.userEmail}
                      </Text>
                    )}
                  </YStack>
                  <View
                    style={{
                      paddingHorizontal: 8,
                      paddingVertical: 3,
                      borderRadius: 12,
                      backgroundColor: c.badges.info.bg,
                    }}
                  >
                    <Text fontSize={11} fontWeight="600" color={c.badges.info.text}>
                      {req.type === 'boost'
                        ? t('billing.admin.requestedHours', { hours: req.requestedHours ?? 0 })
                        : req.requestedPlanName || t('billing.admin.upgrade')}
                    </Text>
                  </View>
                </XStack>

                {/* Requester's live billing context (A1): plan · usage · % and,
                    for a boost, the market value of granting it. */}
                {formatRequesterContext(req) && (
                  <Text testID={`billing-req-${req._id}-context`} fontSize={11} color={c.text2}>
                    {formatRequesterContext(req)}
                  </Text>
                )}
                {req.type === 'boost' && formatEstimatedCost(req.estimatedCost, req.estimatedCostCurrency) && (
                  <Text testID={`billing-req-${req._id}-cost`} fontSize={11} color={semanticColors.indigo}>
                    {formatEstimatedCost(req.estimatedCost, req.estimatedCostCurrency)}
                  </Text>
                )}

                {req.reason && (
                  <Text fontSize={12} color={c.text2}>
                    {req.reason}
                  </Text>
                )}

                {req.status === 'pending' && (
                  <YStack gap={8}>
                    {req.type === 'boost' && (
                      <XStack alignItems="center" gap={8}>
                        <Text fontSize={11} color={c.text2}>
                          {t('billing.admin.grantHours')}
                        </Text>
                        <Input
                          testID={`billing-req-${req._id}-hours`}
                          width={70}
                          size="$2"
                          keyboardType="number-pad"
                          value={grantHours[req._id] ?? String(req.requestedHours ?? '')}
                          onChangeText={(v) =>
                            setGrantHours((prev) => ({ ...prev, [req._id]: v.replace(/[^0-9]/g, '') }))
                          }
                          backgroundColor={isDark ? 'rgba(39,39,42,0.6)' : c.bgInner}
                          borderColor={c.borderStrong}
                          color={c.text}
                        />
                      </XStack>
                    )}
                    <Input
                      testID={`billing-req-${req._id}-note`}
                      size="$2"
                      placeholder={t('billing.admin.note')}
                      placeholderTextColor={c.text3}
                      value={note[req._id] ?? ''}
                      onChangeText={(v) => setNote((prev) => ({ ...prev, [req._id]: v }))}
                      backgroundColor={isDark ? 'rgba(39,39,42,0.6)' : c.bgInner}
                      borderColor={c.borderStrong}
                      color={c.text}
                    />
                    {/* Deny left, Approve right (A1): the primary/destructive
                        action sits on the right, matching the rest of the UI. */}
                    <XStack gap={8}>
                      <Button
                        testID={`billing-req-${req._id}-deny`}
                        flex={1}
                        size="$2"
                        icon={X}
                        disabled={resolving.has(req._id)}
                        backgroundColor={c.badges.err.bg}
                        color={c.badges.err.text}
                        onPress={() => resolve(req, 'deny')}
                      >
                        {t('billing.admin.deny')}
                      </Button>
                      <Button
                        testID={`billing-req-${req._id}-approve`}
                        flex={1}
                        size="$2"
                        icon={Check}
                        disabled={resolving.has(req._id)}
                        backgroundColor={c.badges.ok.bg}
                        color={c.badges.ok.text}
                        onPress={() => resolve(req, 'approve')}
                      >
                        {t('billing.admin.approve')}
                      </Button>
                    </XStack>
                  </YStack>
                )}
              </YStack>
            ))}
          </YStack>
        </ScrollView>
      )}
    </YStack>
  )
}
