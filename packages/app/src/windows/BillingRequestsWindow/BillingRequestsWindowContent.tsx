/**
 * BillingRequestsWindow — admin queue for billing access requests (FASE 6,
 * decision #10). Lists billing_access_requests via admin.list-access-requests and
 * resolves them via admin.resolve-access-request (approve boost with optional
 * grantedHours override, or deny — both with an optional note). Refreshes live on
 * billing.access-requested. Admin/super only (the backend enforces it too).
 *
 * Backend returns DATA (resolved userName/email, requestedPlanName); this window
 * composes the copy.
 *
 * Presentation follows the OS prototype (design-testing): Page + PageHead,
 * a ChipBtn filter row, and one LGroup of request rows.
 */

import { useEffect, useState } from "react"
import { View, useWindowDimensions } from "react-native"
import { useTranslation } from "react-i18next"
import { AppSpinner } from "../../components/ui"
import { Avatar } from "../../components/Avatar"
import {
  Badge,
  Btn,
  ChipBtn,
  EmptyState,
  Field,
  LGroup,
  LRow,
  Page,
  PageHead,
  Ph,
  T,
} from "../../components/ui/ds"
import { useColors } from "../../components/mca/primitives/useColors"
import { getTerosClient } from "../../services/terosClientSingleton"
import { useBillingStore } from "../../store/billingStore"
import {
  buildResolvePayload,
  formatEstimatedCost,
  formatRequesterContext,
  type RequestStatus,
} from "./payload"

interface AccessRequest {
  _id: string
  userId: string
  userName: string | null
  userEmail: string | null
  type: "boost" | "upgrade"
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

const STATUSES: RequestStatus[] = ["pending", "approved", "denied"]

const STATUS_TONE: Record<RequestStatus, "a" | "g" | "r"> = {
  pending: "a",
  approved: "g",
  denied: "r",
}

export function BillingRequestsWindowContent(_props: { windowId: string }) {
  const { t } = useTranslation()
  const client = getTerosClient()
  const resetPendingAdminRequests = useBillingStore((s) => s.resetPendingAdminRequests)

  const [status, setStatus] = useState<RequestStatus>("pending")
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
      const res = (await client.send("admin", "list-access-requests", {
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
      if (status === "pending") load("pending")
    }
    client.on("billing.access-requested", onRequested)
    return () => client.off("billing.access-requested", onRequested)
  }, [status])

  const resolve = async (req: AccessRequest, action: "approve" | "deny") => {
    if (resolving.has(req._id)) return
    setResolving((prev) => new Set(prev).add(req._id))
    try {
      const data = buildResolvePayload(req, action, grantHours[req._id], note[req._id])
      await client.send("admin", "resolve-access-request", data)
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
    <Page>
      <PageHead
        eyebrow={t("billing.eyebrow", { defaultValue: "Facturación" })}
        title={t("billing.admin.title")}
        lead={t("billing.admin.lead", {
          defaultValue: "Solicitudes de horas extra y cambios de plan que esperan tu revisión.",
        })}
      />

      {/* Status filter */}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 16 }}>
        {STATUSES.map((s) => (
          <ChipBtn
            key={s}
            testID={`billing-req-tab-${s}`}
            on={status === s}
            count={s === status && !isLoading && !error ? requests.length : undefined}
            onPress={() => setStatus(s)}
          >
            {t(`billing.admin.${s}`)}
          </ChipBtn>
        ))}
      </View>

      {/* Content */}
      {isLoading ? (
        <View style={{ paddingVertical: 48, alignItems: "center", justifyContent: "center" }}>
          <AppSpinner variant="brand" />
        </View>
      ) : error ? (
        <ErrorStrip testID="billing-req-error" text={t("billing.admin.loadError")} />
      ) : requests.length === 0 ? (
        <View testID="billing-req-empty">
          <EmptyState
            icon="credit-card"
            title={t("billing.admin.empty", { status: t(`billing.admin.${status}`).toLowerCase() })}
          />
        </View>
      ) : (
        <LGroup>
          {requests.map((req) => (
            <RequestRow
              key={req._id}
              req={req}
              resolving={resolving.has(req._id)}
              grantHours={grantHours[req._id] ?? String(req.requestedHours ?? "")}
              note={note[req._id] ?? ""}
              onGrantHours={(v) =>
                setGrantHours((prev) => ({ ...prev, [req._id]: v.replace(/[^0-9]/g, "") }))
              }
              onNote={(v) => setNote((prev) => ({ ...prev, [req._id]: v }))}
              onApprove={() => resolve(req, "approve")}
              onDeny={() => resolve(req, "deny")}
            />
          ))}
        </LGroup>
      )}
    </Page>
  )
}

// ─── Rows ────────────────────────────────────────────────────────────────────

function RequestRow({
  req,
  resolving,
  grantHours,
  note,
  onGrantHours,
  onNote,
  onApprove,
  onDeny,
}: {
  req: AccessRequest
  resolving: boolean
  grantHours: string
  note: string
  onGrantHours: (v: string) => void
  onNote: (v: string) => void
  onApprove: () => void
  onDeny: () => void
}) {
  const { t } = useTranslation()
  const { width } = useWindowDimensions()
  const narrow = width <= 620
  const displayName = req.userName || req.userEmail || req.userId
  const context = formatRequesterContext(req)
  const cost =
    req.type === "boost" ? formatEstimatedCost(req.estimatedCost, req.estimatedCostCurrency) : null

  return (
    <View testID={`billing-req-${req._id}`}>
      <LRow padV={14} style={{ alignItems: "flex-start" }}>
        <Avatar name={displayName} size={36} />
        <View style={{ flex: 1, minWidth: 0, gap: 10 }}>
          {/* Identity · type · amount · status */}
          <View
            style={{
              flexDirection: narrow ? "column" : "row",
              alignItems: narrow ? "flex-start" : "center",
              gap: narrow ? 8 : 14,
            }}
          >
            <View style={{ flex: narrow ? undefined : 1, minWidth: 0, gap: 1 }}>
              <T step="sm" ellipsis>
                {displayName}
              </T>
              {req.userEmail && req.userName ? (
                <T step="12" tone="text3" ellipsis>
                  {req.userEmail}
                </T>
              ) : null}
              {context ? (
                <T testID={`billing-req-${req._id}-context`} step="12" tone="text3">
                  {context}
                </T>
              ) : null}
            </View>

            <Badge tone="i">
              {req.type === "boost"
                ? t("billing.admin.requestedHours", { hours: req.requestedHours ?? 0 })
                : req.requestedPlanName || t("billing.admin.upgrade")}
            </Badge>

            {req.type === "boost" ? (
              <View style={{ alignItems: narrow ? "flex-start" : "flex-end", minWidth: 64 }}>
                <T step="xl">{`${req.requestedHours ?? 0}h`}</T>
                {cost ? (
                  <T testID={`billing-req-${req._id}-cost`} step="codenote" tone="text3">
                    {cost}
                  </T>
                ) : null}
              </View>
            ) : null}

            <Badge tone={STATUS_TONE[req.status]} dot>
              {t(`billing.admin.${req.status}`)}
            </Badge>
          </View>

          {req.reason ? (
            <T step="sm" tone="text2">
              {req.reason}
            </T>
          ) : null}

          {/* Resolve controls (pending only) */}
          {req.status === "pending" ? (
            <View
              style={{
                flexDirection: "row",
                flexWrap: "wrap",
                alignItems: "center",
                gap: 8,
              }}
            >
              {req.type === "boost" ? (
                <Field
                  testID={`billing-req-${req._id}-hours`}
                  mono
                  icon="clock"
                  keyboardType="number-pad"
                  value={grantHours}
                  onChangeText={onGrantHours}
                  placeholder={t("billing.admin.grantHours")}
                  containerStyle={{ width: 110 }}
                />
              ) : null}
              <Field
                testID={`billing-req-${req._id}-note`}
                placeholder={t("billing.admin.note")}
                value={note}
                onChangeText={onNote}
                containerStyle={{ flex: 1, minWidth: 160 }}
              />
              {/* Deny left, Approve right (A1): the primary action sits on the right. */}
              <Btn
                testID={`billing-req-${req._id}-deny`}
                size="sm"
                variant="dangerSoft"
                icon="x"
                disabled={resolving}
                loading={resolving}
                onPress={onDeny}
              >
                {t("billing.admin.deny")}
              </Btn>
              <Btn
                testID={`billing-req-${req._id}-approve`}
                size="sm"
                variant="primary"
                icon="check"
                disabled={resolving}
                loading={resolving}
                onPress={onApprove}
              >
                {t("billing.admin.approve")}
              </Btn>
            </View>
          ) : null}
        </View>
      </LRow>
    </View>
  )
}

/** Tinted red strip for a failed load. */
function ErrorStrip({ text, testID }: { text: string; testID?: string }) {
  const c = useColors()
  return (
    <View
      testID={testID}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        padding: 14,
        borderRadius: 12,
        backgroundColor: c.tint.r.bg,
        borderWidth: 1,
        borderColor: c.tint.r.bd,
      }}
    >
      <Ph name="warning" size={16} color={c.tint.r.tx} />
      <T step="sm" color={c.tint.r.tx} style={{ flex: 1 }}>
        {text}
      </T>
    </View>
  )
}
