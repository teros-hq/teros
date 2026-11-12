/**
 * BillingAuditWindow — admin read-only audit for a single user's billing
 * (TER-596 A1). Consumes admin.get-billing-audit and explains how the user's
 * agentHoursUsed formed: a live recompute (expected vs actual + drift), the
 * current-period ledger breakdown, active boosts, and the snapshot/invoice
 * history. Opened from the billing summary's "View audit" button.
 *
 * Backend returns DATA (resolved names + numbers); this window composes the copy.
 * Pure derivations (drift significance, usage %, boost origin) live in audit.ts
 * so they are unit-testable (the harness stubs this *WindowContent module).
 *
 * Presentation follows the OS prototype (design-testing): Page + PageHead,
 * a Stats row, and LGroup/LRow lists with mono timestamps and Badge statuses.
 */

import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { View } from "react-native"
import { AppSpinner } from "../../components/ui"
import { Avatar } from "../../components/Avatar"
import {
  Badge,
  type BadgeTone,
  Card,
  LGroup,
  LRow,
  Page,
  PageHead,
  Ph,
  SectionLabel,
  Stat,
  Stats,
  T,
} from "../../components/ui/ds"
import { useColors } from "../../components/mca/primitives/useColors"
import type {
  BillingAuditBoost,
  BillingAuditInvoice,
  BillingAuditLedgerEntry,
  BillingAuditSnapshot,
  BillingAuditView,
} from "../../services/AdminApi"
import { getTerosClient } from "../../services/terosClientSingleton"
import { boostOrigin, isDriftSignificant, usagePercent } from "./audit"

const day = (iso: string | null): string => (iso ? iso.slice(0, 10) : "—")

/** Subscription / invoice status → badge tone. */
function statusTone(status: string): BadgeTone {
  const s = status.toLowerCase()
  if (s === "active" || s === "paid") return "g"
  if (s === "paused" || s === "pending" || s === "open" || s === "past_due") return "a"
  if (s === "cancelled" || s === "canceled" || s === "void" || s === "failed") return "r"
  return "i"
}

export interface BillingAuditWindowProps {
  windowId: string
  userId?: string
  subscriptionId?: string
  userName?: string
}

export function BillingAuditWindowContent(props: BillingAuditWindowProps) {
  const { t } = useTranslation()
  const client = getTerosClient()
  const [audit, setAudit] = useState<BillingAuditView | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    let alive = true
    const run = async () => {
      setIsLoading(true)
      setError(false)
      try {
        const res = await client.admin.getBillingAudit({
          userId: props.userId,
          subscriptionId: props.subscriptionId,
        })
        if (alive) setAudit(res)
      } catch {
        if (alive) setError(true)
      } finally {
        if (alive) setIsLoading(false)
      }
    }
    run()
    return () => {
      alive = false
    }
  }, [client, props.userId, props.subscriptionId])

  if (isLoading) {
    return (
      <Page noScroll>
        <View style={{ paddingVertical: 64, alignItems: "center", justifyContent: "center" }}>
          <AppSpinner variant="brand" />
        </View>
      </Page>
    )
  }
  if (error || !audit) {
    return (
      <Page>
        <PageHead
          eyebrow={t("billing.eyebrow", { defaultValue: "Facturación" })}
          title={t("windows.billingAudit")}
        />
        <ErrorStrip testID="billing-audit-error" text={t("billing.audit.loadError")} />
      </Page>
    )
  }

  return (
    <AuditBody
      audit={audit}
      name={props.userName ?? audit.subscription.userName ?? audit.subscription.userId}
    />
  )
}

function AuditBody({ audit, name }: { audit: BillingAuditView; name: string }) {
  const { t } = useTranslation()
  const { subscription: s, consumption: cns } = audit
  const driftBad = isDriftSignificant(cns.driftHours, cns.expectedHours, cns.actualHours)
  const pct = usagePercent(s.agentHoursUsed, s.agentHoursLimit)
  const hours =
    s.agentHoursLimit > 0
      ? `${s.agentHoursUsed.toFixed(1)} / ${s.agentHoursLimit}h`
      : `${s.agentHoursUsed.toFixed(1)}h`

  return (
    <Page testID="billing-audit-window">
      <PageHead
        eyebrow={t("billing.eyebrow", { defaultValue: "Facturación" })}
        title={name}
        lead={
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <Avatar name={name} size={28} />
            <T step="sm" tone="text2">
              {s.planName ?? "—"}
            </T>
            <Badge tone={statusTone(s.status)} dot>
              {s.status}
            </Badge>
          </View>
        }
      />

      <Stats cols={4} style={{ marginBottom: 20 }}>
        <Stat label={t("billing.audit.hours")} v={hours} accent />
        <Stat label={t("billing.audit.usage")} v={pct === null ? "—" : `${pct}%`} />
        <Stat label={t("billing.audit.boost")} v={`${s.boostHours}h`} />
        <Stat
          label={t("billing.audit.period")}
          v={day(s.currentPeriodStart)}
          sub={`→ ${day(s.currentPeriodEnd)}`}
        />
      </Stats>

      <ConsumptionCard
        expected={cns.expectedHours}
        actual={cns.actualHours}
        drift={cns.driftHours}
        bad={driftBad}
        okLabel={t("billing.audit.driftOk")}
        badLabel={t("billing.audit.driftWarn")}
        title={t("billing.audit.consumption")}
        expectedLabel={t("billing.audit.expected")}
        actualLabel={t("billing.audit.actual")}
        driftLabel={t("billing.audit.drift")}
      />
      <BoostsSection boosts={audit.activeBoosts} />
      <LedgerSection
        entries={audit.ledgerEntries}
        total={audit.ledgerTotalCount}
        truncated={audit.ledgerTruncated}
      />
      <SnapshotsSection snapshots={audit.snapshots} />
      <InvoicesSection invoices={audit.invoices} />
    </Page>
  )
}

// ─── Sections ────────────────────────────────────────────────────────────────

function ConsumptionCard(props: {
  expected: number
  actual: number
  drift: number
  bad: boolean
  title: string
  okLabel: string
  badLabel: string
  expectedLabel: string
  actualLabel: string
  driftLabel: string
}) {
  const c = useColors()
  const driftColor = props.bad ? c.tint.r.tx : c.tint.g.tx
  return (
    <Card pad style={{ marginBottom: 20 }}>
      <T step="base">{props.title}</T>
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "flex-end",
          gap: 28,
          marginTop: 14,
        }}
      >
        <KV label={props.expectedLabel} value={`${props.expected.toFixed(2)}h`} />
        <KV label={props.actualLabel} value={`${props.actual.toFixed(2)}h`} />
        <View style={{ flex: 1 }} />
        <View style={{ alignItems: "flex-end", gap: 6 }}>
          <T testID="billing-audit-drift" step="xl" color={driftColor}>
            {props.drift.toFixed(2)}h
          </T>
          <Badge tone={props.bad ? "r" : "g"} dot>
            {props.bad ? props.badLabel : props.okLabel}
          </Badge>
        </View>
      </View>
      <T step="12" tone="text3" style={{ marginTop: 12 }}>
        {props.driftLabel}
      </T>
    </Card>
  )
}

function BoostsSection({ boosts }: { boosts: BillingAuditBoost[] }) {
  const { t } = useTranslation()
  if (boosts.length === 0) return null
  return (
    <View style={{ marginBottom: 20 }}>
      <SectionLabel label={t("billing.audit.boosts")} count={boosts.length} />
      <LGroup>
        {boosts.map((b) => (
          <LRow key={b._id}>
            <T step="xl" style={{ minWidth: 56 }}>
              {b.hours}h
            </T>
            <T step="code" tone="text3" style={{ flex: 1 }}>
              {day(b.periodStart)} → {day(b.periodEnd)}
            </T>
            <Badge tone={boostOrigin(b) === "purchase" ? "i" : "m"}>
              {t(`billing.audit.origin.${boostOrigin(b)}`)}
            </Badge>
          </LRow>
        ))}
      </LGroup>
    </View>
  )
}

function LedgerSection({
  entries,
  total,
  truncated,
}: {
  entries: BillingAuditLedgerEntry[]
  total: number
  truncated: boolean
}) {
  const { t } = useTranslation()
  return (
    <View style={{ marginBottom: 20 }}>
      <SectionLabel label={t("billing.audit.ledger")} count={total} />
      {entries.length === 0 ? (
        <Card pad>
          <T step="sm" tone="text3">
            {t("billing.audit.ledgerEmpty")}
          </T>
        </Card>
      ) : (
        <LGroup>
          {entries.map((e) => (
            <LRow key={`${e.hourBucket}-${e.trackerRunId}`} padV={10}>
              <T step="code" tone="text3" style={{ flex: 1 }}>
                {e.hourBucket.slice(0, 16).replace("T", " ")}
              </T>
              <T step="code" tone="accent">
                +{e.hoursAdded.toFixed(3)}h
              </T>
              <T step="code" tone="text2" style={{ minWidth: 88, textAlign: "right" }}>
                Σ {e.cumulative.toFixed(2)}h
              </T>
            </LRow>
          ))}
        </LGroup>
      )}
      {truncated ? (
        <T step="12" tone="text3" style={{ marginTop: 8, paddingHorizontal: 4 }}>
          {t("billing.audit.ledgerTruncated", { shown: entries.length, total })}
        </T>
      ) : null}
    </View>
  )
}

function SnapshotsSection({ snapshots }: { snapshots: BillingAuditSnapshot[] }) {
  const { t } = useTranslation()
  const c = useColors()
  if (snapshots.length === 0) return null
  return (
    <View style={{ marginBottom: 20 }}>
      <SectionLabel label={t("billing.audit.snapshots")} count={snapshots.length} />
      <LGroup>
        {snapshots.map((s) => (
          <LRow key={`${s.periodStart}-${s.periodEnd}`} padV={10}>
            <T step="code" tone="text3" style={{ flex: 1 }}>
              {day(s.periodStart)} → {day(s.periodEnd)}
            </T>
            <T step="code">
              {s.agentHoursUsed.toFixed(1)} / {s.agentHoursLimit}h
            </T>
            <T
              step="code"
              color={s.overageHours > 0 ? c.tint.r.tx : c.text3}
              style={{ minWidth: 64, textAlign: "right" }}
            >
              {s.overageHours > 0 ? `+${s.overageHours.toFixed(1)}h` : "—"}
            </T>
          </LRow>
        ))}
      </LGroup>
    </View>
  )
}

function InvoicesSection({ invoices }: { invoices: BillingAuditInvoice[] }) {
  const { t } = useTranslation()
  if (invoices.length === 0) return null
  return (
    <View style={{ marginBottom: 20 }}>
      <SectionLabel label={t("billing.audit.invoices")} count={invoices.length} />
      <LGroup>
        {invoices.map((i) => (
          <LRow key={i._id} padV={10}>
            <T step="code" tone="text3" style={{ flex: 1 }}>
              {day(i.periodStart)} → {day(i.periodEnd)}
            </T>
            <T step="code">{i.amount > 0 ? `${i.amount} ${i.currency}` : "—"}</T>
            <Badge tone={statusTone(i.status)}>{i.status}</Badge>
          </LRow>
        ))}
      </LGroup>
    </View>
  )
}

// ─── Bits ────────────────────────────────────────────────────────────────────

function KV({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ gap: 4 }}>
      <T step="xs" tone="text3">
        {label}
      </T>
      <T step="xl">{value}</T>
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
