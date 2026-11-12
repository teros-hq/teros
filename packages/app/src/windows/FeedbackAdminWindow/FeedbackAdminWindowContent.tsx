/**
 * Feedback Admin Window Content
 *
 * Admin panel for the standardized feedback/bug triage:
 * - Lifecycle tabs: Tracking (open/in_review/in_progress), Future
 *   (postponed), Dismissed (wont_fix | invalid), Completed (resolved), All
 * - Search + type filter over the list
 * - Detail view: full description, reporter, updates timeline
 * - Actions: change status (dismiss requires a reason), set priority,
 *   add a reporter-visible update. Resolving emails the reporter.
 *
 * Only accessible to users with role "admin" or "super" (server-side
 * enforced on every admin-api.feedback-* action).
 *
 * Presentation follows the OS prototype: `Page` + `PageHead`, rows as
 * `LGroup`/`LRow`, detail as `Card` sections. All colours from `useColors()`.
 */

import * as React from "react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { Pressable, ScrollView, View } from "react-native"
import { Sheet, XStack, YStack } from "tamagui"
import { AppSpinner, FullscreenLoader } from "../../components/ui"
import {
  Badge,
  Btn,
  Card,
  EmptyState,
  Field,
  LGroup,
  LRow,
  Page,
  PageHead,
  PTabs,
  SectionLabel,
  T,
  type BadgeTone,
} from "../../components/ui/ds"
import { useToast } from "../../components/Toast"
import { getTerosClient } from "../../services/terosClientSingleton"
import type {
  FeedbackAdminDetail,
  FeedbackAdminItem,
  FeedbackAdminStatus,
  FeedbackAdminView,
  FeedbackDismissReason,
} from "../../services/FeedbackAdminApi"
import type { FeedbackAdminWindowProps } from "./definition"
import { useColors } from "../../components/mca/primitives/useColors"

// ============================================================================
// Types
// ============================================================================

interface Props extends FeedbackAdminWindowProps {
  windowId: string
}

type Screen = "list" | "detail"

const VIEW_TABS: FeedbackAdminView[] = ["tracking", "future", "dismissed", "completed", "all"]

const STATUS_TO_VIEW: Record<FeedbackAdminStatus, FeedbackAdminView> = {
  open: "tracking",
  in_review: "tracking",
  in_progress: "tracking",
  postponed: "future",
  dismissed: "dismissed",
  resolved: "completed",
}

// ============================================================================
// Status/priority presentation helpers
// ============================================================================

function statusLabel(status: FeedbackAdminStatus): string {
  switch (status) {
    case "open":
      return "Open"
    case "in_review":
      return "In Review"
    case "in_progress":
      return "In Progress"
    case "postponed":
      return "Future"
    case "resolved":
      return "Completed"
    case "dismissed":
      return "Dismissed"
  }
}

function statusTone(status: FeedbackAdminStatus): BadgeTone {
  switch (status) {
    case "open":
      return "i"
    case "in_review":
      return "a"
    case "in_progress":
      return "m"
    case "postponed":
      return "neutral"
    case "resolved":
      return "g"
    case "dismissed":
      return "muted"
  }
}

function priorityTone(priority?: string): BadgeTone | undefined {
  switch (priority) {
    case "critical":
      return "r"
    case "high":
      return "a"
    case "medium":
      return "i"
    case "low":
      return "g"
    default:
      return undefined
  }
}

function formatDate(dateString: string): string {
  const date = new Date(dateString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)
  if (diffMins < 1) return "just now"
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

// ============================================================================
// Main component
// ============================================================================

export function FeedbackAdminWindowContent(props: Props) {
  const { t } = useTranslation()
  const c = useColors()
  const toast = useToast()
  const client = getTerosClient()

  const [screen, setScreen] = useState<Screen>("list")
  const [view, setView] = useState<FeedbackAdminView>(
    (props.view as FeedbackAdminView) || "tracking",
  )
  const [search, setSearch] = useState(props.search || "")
  const [typeFilter, setTypeFilter] = useState<"all" | "bug" | "suggestion">("all")

  const [items, setItems] = useState<FeedbackAdminItem[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [detail, setDetail] = useState<FeedbackAdminDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  // Status-change form state
  const [statusFormOpen, setStatusFormOpen] = useState(false)
  const [newStatus, setNewStatus] = useState<FeedbackAdminStatus>("open")
  const [dismissReason, setDismissReason] = useState<FeedbackDismissReason>("wont_fix")
  const [statusMessage, setStatusMessage] = useState("")
  const [notifyReporter, setNotifyReporter] = useState(true)
  const [saving, setSaving] = useState(false)

  // Add-update form state
  const [updateMessage, setUpdateMessage] = useState("")
  const [addingUpdate, setAddingUpdate] = useState(false)

  // ── Data loading ───────────────────────────────────────────────────────────

  const loadList = useCallback(async () => {
    try {
      const result = await client.feedbackAdmin.list({ view, limit: 200 })
      setItems(result.feedbacks)
      setCounts(result.stats.byStatus)
      setError(null)
    } catch (err: any) {
      setError(
        err.code === "FORBIDDEN"
          ? t("feedbackAdmin.adminRequired")
          : err.message || t("feedbackAdmin.loadFailed"),
      )
    } finally {
      setLoading(false)
    }
  }, [client, view, t])

  const loadDetail = useCallback(
    async (feedbackId: string) => {
      setDetailLoading(true)
      try {
        const d = await client.feedbackAdmin.get(feedbackId)
        setDetail(d)
        setError(null)
      } catch (err: any) {
        toast.error(t("feedbackAdmin.error"), err.message || t("feedbackAdmin.loadFailed"))
      } finally {
        setDetailLoading(false)
      }
    },
    [client, t, toast],
  )

  useEffect(() => {
    setLoading(true)
    loadList()
  }, [loadList])

  // ── Derived ────────────────────────────────────────────────────────────────

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return items.filter((f) => {
      if (typeFilter !== "all" && f.type !== typeFilter) return false
      if (!q) return true
      return (
        f.title.toLowerCase().includes(q) ||
        (f.reportedByName || "").toLowerCase().includes(q) ||
        f.feedbackId.toLowerCase().includes(q)
      )
    })
  }, [items, search, typeFilter])

  const viewCount = (v: FeedbackAdminView): number | undefined => {
    if (v === "all") return undefined
    if (v === "tracking") return (counts.open || 0) + (counts.in_review || 0) + (counts.in_progress || 0)
    if (v === "future") return counts.postponed || 0
    if (v === "dismissed") return counts.dismissed || 0
    if (v === "completed") return counts.resolved || 0
    return undefined
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  const openDetail = (feedbackId: string) => {
    setScreen("detail")
    setDetail(null)
    setStatusFormOpen(false)
    setStatusMessage("")
    setUpdateMessage("")
    loadDetail(feedbackId)
  }

  const closeDetail = () => {
    setScreen("list")
    setDetail(null)
    loadList()
  }

  const openStatusForm = (target: FeedbackAdminStatus) => {
    setNewStatus(target)
    setDismissReason("wont_fix")
    setStatusMessage("")
    setNotifyReporter(true)
    setStatusFormOpen(true)
  }

  const submitStatusChange = async () => {
    if (!detail) return
    setSaving(true)
    try {
      const result = await client.feedbackAdmin.updateStatus({
        feedbackId: detail.feedbackId,
        status: newStatus,
        message: statusMessage.trim() || undefined,
        dismissReason: newStatus === "dismissed" ? dismissReason : undefined,
        notifyReporter,
      })
      toast.success(
        t("feedbackAdmin.statusUpdated"),
        result.reporterNotified ? t("feedbackAdmin.reporterEmailed") : undefined,
      )
      setStatusFormOpen(false)
      loadDetail(detail.feedbackId)
    } catch (err: any) {
      toast.error(t("feedbackAdmin.error"), err.message || t("feedbackAdmin.updateFailed"))
    } finally {
      setSaving(false)
    }
  }

  const submitPriority = async (priority: string) => {
    if (!detail) return
    try {
      await client.feedbackAdmin.setPriority(detail.feedbackId, priority as any)
      toast.success(t("feedbackAdmin.prioritySet"))
      loadDetail(detail.feedbackId)
    } catch (err: any) {
      toast.error(t("feedbackAdmin.error"), err.message || t("feedbackAdmin.updateFailed"))
    }
  }

  const submitUpdate = async () => {
    if (!detail || !updateMessage.trim()) return
    setAddingUpdate(true)
    try {
      await client.feedbackAdmin.addUpdate(detail.feedbackId, updateMessage.trim())
      toast.success(t("feedbackAdmin.updateAdded"))
      setUpdateMessage("")
      loadDetail(detail.feedbackId)
    } catch (err: any) {
      toast.error(t("feedbackAdmin.error"), err.message || t("feedbackAdmin.updateFailed"))
    } finally {
      setAddingUpdate(false)
    }
  }

  // ── Render: list ───────────────────────────────────────────────────────────

  const tabs = VIEW_TABS.map((v) => ({
    key: v,
    label: t(`feedbackAdmin.view_${v}`),
    count: viewCount(v),
  }))

  if (screen === "detail") {
    if (!detail) {
      return <FullscreenLoader label={t("feedbackAdmin.loadingDetail")} />
    }
    return (
      <DetailScreen
        detail={detail}
        onBack={closeDetail}
        onOpenStatusForm={openStatusForm}
        statusFormOpen={statusFormOpen}
        newStatus={newStatus}
        dismissReason={dismissReason}
        setDismissReason={setDismissReason}
        statusMessage={statusMessage}
        setStatusMessage={setStatusMessage}
        notifyReporter={notifyReporter}
        setNotifyReporter={setNotifyReporter}
        saving={saving}
        onSubmitStatus={submitStatusChange}
        onCloseStatusForm={() => setStatusFormOpen(false)}
        priority={detail.priority}
        onSetPriority={submitPriority}
        updateMessage={updateMessage}
        setUpdateMessage={setUpdateMessage}
        addingUpdate={addingUpdate}
        onSubmitUpdate={submitUpdate}
      />
    )
  }

  return (
    <Page>
      <PageHead
        eyebrow={t("feedbackAdmin.eyebrow")}
        title={t("windows.feedbackAdmin")}
        lead={t("feedbackAdmin.subtitle")}
        actions={
          <XStack gap={8} alignItems="center">
            <Field
              placeholder={t("feedbackAdmin.search")}
              value={search}
              onChangeText={setSearch}
              icon="magnifying-glass"
              bare
              containerStyle={{ width: 220 }}
            />
          </XStack>
        }
      />

      <XStack px={16} pt={4}>
        <PTabs items={tabs} value={view} onChange={(k) => setView(k as FeedbackAdminView)} full />
      </XStack>

      <XStack px={16} py={8} gap={8} alignItems="center">
        <PTabs
          sm
          items={[
            { key: "all", label: t("feedbackAdmin.typeAll") },
            { key: "bug", label: t("feedbackAdmin.typeBug") },
            { key: "suggestion", label: t("feedbackAdmin.typeSuggestion") },
          ]}
          value={typeFilter}
          onChange={(k) => setTypeFilter(k as any)}
        />
      </XStack>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingTop: 4 }}>
        {loading ? (
          <FullscreenLoader />
        ) : error ? (
          <EmptyState icon="warning" title={t("feedbackAdmin.error")} text={error} />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon="tray"
            title={t("feedbackAdmin.emptyTitle")}
            text={t("feedbackAdmin.emptyText")}
          />
        ) : (
          <LGroup>
            {filtered.map((f) => (
              <LRow key={f.feedbackId} onPress={() => openDetail(f.feedbackId)}>
                <XStack flex={1} gap={10} alignItems="center">
                  <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: f.type === "bug" ? c.badges.err.text : c.badges.warn.text }} />
                  <YStack flex={1} gap={2}>
                    <T ellipsis>
                      {f.title}
                    </T>
                    <XStack gap={8} alignItems="center">
                      <T tone="text2" ellipsis>
                        {f.reportedByName || f.reportedBy}
                      </T>
                      <T tone="text3">
                        · {formatDate(f.createdAt)}
                      </T>
                      {f.updatesCount > 0 && (
                        <T tone="text3">
                          · {f.updatesCount} upd
                        </T>
                      )}
                    </XStack>
                  </YStack>
                  <XStack gap={6} alignItems="center">
                    {f.priority && <Badge tone={priorityTone(f.priority)} cap sm>{f.priority}</Badge>}
                    {f.status === "dismissed" && f.dismissReason && (
                      <Badge tone="muted" cap sm>
                        {t(`feedbackAdmin.dismiss_${f.dismissReason}`)}
                      </Badge>
                    )}
                    <Badge tone={statusTone(f.status)} cap sm dot>
                      {statusLabel(f.status)}
                    </Badge>
                  </XStack>
                </XStack>
              </LRow>
            ))}
          </LGroup>
        )}
      </ScrollView>
    </Page>
  )
}

// ============================================================================
// Detail screen
// ============================================================================

interface DetailScreenProps {
  detail: FeedbackAdminDetail
  onBack: () => void
  onOpenStatusForm: (target: FeedbackAdminStatus) => void
  statusFormOpen: boolean
  newStatus: FeedbackAdminStatus
  dismissReason: FeedbackDismissReason
  setDismissReason: (r: FeedbackDismissReason) => void
  statusMessage: string
  setStatusMessage: (m: string) => void
  notifyReporter: boolean
  setNotifyReporter: (b: boolean) => void
  saving: boolean
  onSubmitStatus: () => void
  onCloseStatusForm: () => void
  priority?: string
  onSetPriority: (p: string) => void
  updateMessage: string
  setUpdateMessage: (m: string) => void
  addingUpdate: boolean
  onSubmitUpdate: () => void
}

function DetailScreen(p: DetailScreenProps) {
  const { t } = useTranslation()
  const c = useColors()
  const d = p.detail

  const nextActions: Array<{ status: FeedbackAdminStatus; label: string; tone?: "primary" | "default" }> =
    d.status === "resolved"
      ? [
          { status: "open", label: t("feedbackAdmin.actReopen") },
          { status: "dismissed", label: t("feedbackAdmin.actDismiss") },
        ]
      : d.status === "dismissed"
        ? [
            { status: "open", label: t("feedbackAdmin.actReopen") },
            { status: "in_progress", label: t("feedbackAdmin.actStart") },
            { status: "postponed", label: t("feedbackAdmin.actPostpone") },
            { status: "resolved", label: t("feedbackAdmin.actComplete"), tone: "primary" },
          ]
        : d.status === "postponed"
          ? [
              { status: "in_progress", label: t("feedbackAdmin.actStart") },
              { status: "dismissed", label: t("feedbackAdmin.actDismiss") },
              { status: "resolved", label: t("feedbackAdmin.actComplete"), tone: "primary" },
            ]
          : [
              { status: "in_review", label: t("feedbackAdmin.actReview") },
              { status: "in_progress", label: t("feedbackAdmin.actStart") },
              { status: "postponed", label: t("feedbackAdmin.actPostpone") },
              { status: "dismissed", label: t("feedbackAdmin.actDismiss") },
              { status: "resolved", label: t("feedbackAdmin.actComplete"), tone: "primary" },
            ]

  return (
    <Page>
      <PageHead
        eyebrow={d.type === "bug" ? t("feedbackAdmin.typeBug") : t("feedbackAdmin.typeSuggestion")}
        title={d.title}
        lead={`${d.feedbackId} · ${formatDate(d.createdAt)}`}
        actions={
          <XStack gap={6} alignItems="center">
            {d.priority && <Badge tone={priorityTone(d.priority)} cap sm>{d.priority}</Badge>}
            <Badge tone={statusTone(d.status)} cap sm dot>
              {statusLabel(d.status)}
            </Badge>
          </XStack>
        }
      />

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 16 }}>
        {/* Back to list */}
        <Btn variant="ghost" size="sm" icon="arrow-left" onPress={p.onBack}>
          {t("feedbackAdmin.backToList")}
        </Btn>

        {/* Reporter + meta */}
        <Card pad>
          <SectionLabel label={t("feedbackAdmin.sectionReport")} />
          <XStack gap={8} alignItems="center" flexWrap="wrap">
            <T tone="text2">
              {d.reportedByName || d.reportedBy}
            </T>
            <T tone="text3">
              · {formatDate(d.createdAt)}
            </T>
            {d.severity && (
              <Badge tone="a" cap sm>
                sev {d.severity}
              </Badge>
            )}
            {d.source && d.source !== "tool" && (
              <Badge tone="i" cap sm>
                {t(`feedbackAdmin.source_${d.source}`)}
              </Badge>
            )}
            {d.agentId && <T tone="text3">· agent {d.agentId}</T>}
          </XStack>
          {d.reporterNotifiedAt && (
            <T tone="text3" style={{ marginTop: 6 }}>
              {t("feedbackAdmin.reporterNotified")} · {formatDate(d.reporterNotifiedAt)}
            </T>
          )}
          {d.reporterNotifyError && (
            <T tone="text3" style={{ marginTop: 4 }}>
              {t("feedbackAdmin.reporterNotifyError")}: {d.reporterNotifyError}
            </T>
          )}
        </Card>

        {/* Description */}
        <Card pad>
          <SectionLabel label={t("feedbackAdmin.sectionDescription")} />
          <T>{d.description}</T>
        </Card>

        {/* Priority */}
        <Card pad>
          <SectionLabel label={t("feedbackAdmin.sectionPriority")} />
          <XStack gap={6}>
            {["low", "medium", "high", "critical"].map((pr) => (
              <Btn
                key={pr}
                size="sm"
                variant={d.priority === pr ? "primary" : "sec"}
                onPress={() => p.onSetPriority(pr)}
              >
                {pr}
              </Btn>
            ))}
          </XStack>
        </Card>

        {/* Status actions */}
        <Card pad>
          <SectionLabel label={t("feedbackAdmin.sectionActions")} />
          <XStack gap={6} flexWrap="wrap">
            {nextActions.map((a) => (
              <Btn
                key={a.status}
                size="sm"
                variant={a.tone === "primary" ? "primary" : "sec"}
                onPress={() => p.onOpenStatusForm(a.status)}
              >
                {a.label}
              </Btn>
            ))}
          </XStack>
        </Card>

        {/* Updates timeline */}
        <Card pad>
          <SectionLabel label={t("feedbackAdmin.sectionUpdates")} count={d.updates?.length ?? 0} />
          {(!d.updates || d.updates.length === 0) ? (
            <T tone="text3">
              {t("feedbackAdmin.noUpdates")}
            </T>
          ) : (
            <YStack gap={8}>
              {[...d.updates].reverse().map((u) => (
                <YStack key={u.updateId} gap={2} style={{ borderLeftWidth: 2, borderLeftColor: c.text3, paddingLeft: 8 }}>
                  <XStack gap={8} alignItems="center">
                    {u.newStatus && (
                      <Badge tone="muted" cap sm>
                        {u.newStatus}
                      </Badge>
                    )}
                    <T tone="text3">
                      {formatDate(u.createdAt)}
                    </T>
                  </XStack>
                  <T>{u.message}</T>
                </YStack>
              ))}
            </YStack>
          )}
        </Card>

        {/* Add update */}
        <Card pad>
          <SectionLabel label={t("feedbackAdmin.sectionAddUpdate")} />
          <Field
            area
            placeholder={t("feedbackAdmin.updatePlaceholder")}
            value={p.updateMessage}
            onChangeText={p.setUpdateMessage}
            minHeight={70}
          />
          <XStack style={{ marginTop: 8 }} justifyContent="flex-end">
            <Btn size="sm" onPress={p.onSubmitUpdate} disabled={p.addingUpdate || !p.updateMessage.trim()}>
              {p.addingUpdate ? <AppSpinner /> : t("feedbackAdmin.addUpdate")}
            </Btn>
          </XStack>
        </Card>
      </ScrollView>

      {/* Status-change sheet */}
      <Sheet
        open={p.statusFormOpen}
        onOpenChange={(o: boolean) => !o && p.onCloseStatusForm()}
        dismissOnSnapToBottom
      >
        <Sheet.Overlay />
        <Sheet.Frame padding={16}>
          <YStack gap={12} paddingBottom={24}>
            <SectionLabel label={`${t("feedbackAdmin.changeTo")} · ${statusLabel(p.newStatus)}`} />

            {p.newStatus === "dismissed" && (
              <XStack gap={6}>
                {(["wont_fix", "invalid"] as FeedbackDismissReason[]).map((r) => (
                  <Btn
                    key={r}
                    size="sm"
                    variant={p.dismissReason === r ? "primary" : "sec"}
                    onPress={() => p.setDismissReason(r)}
                  >
                    {t(`feedbackAdmin.dismiss_${r}`)}
                  </Btn>
                ))}
              </XStack>
            )}

            <Field
              area
              placeholder={t("feedbackAdmin.notePlaceholder")}
              value={p.statusMessage}
              onChangeText={p.setStatusMessage}
              minHeight={70}
            />

            {p.newStatus === "resolved" && (
              <Pressable onPress={() => p.setNotifyReporter(!p.notifyReporter)}>
                <XStack gap={8} alignItems="center">
                  <View
                    style={{
                      width: 16,
                      height: 16,
                      borderRadius: 4,
                      borderWidth: 1,
                      borderColor: c.text2,
                      backgroundColor: p.notifyReporter ? c.accent : "transparent",
                    }}
                  />
                  <T>{t("feedbackAdmin.notifyReporter")}</T>
                </XStack>
              </Pressable>
            )}

            <XStack gap={8} justifyContent="flex-end">
              <Btn size="sm" variant="sec" onPress={p.onCloseStatusForm}>
                {t("feedbackAdmin.cancel")}
              </Btn>
              <Btn size="sm" variant="primary" onPress={p.onSubmitStatus} disabled={p.saving}>
                {p.saving ? <AppSpinner /> : t("feedbackAdmin.confirm")}
              </Btn>
            </XStack>
          </YStack>
        </Sheet.Frame>
      </Sheet>
    </Page>
  )
}
