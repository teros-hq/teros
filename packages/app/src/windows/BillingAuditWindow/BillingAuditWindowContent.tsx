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
 */

import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { ScrollView } from "react-native"
import { Text, XStack, YStack } from "tamagui"
import { AppSpinner } from "../../components/ui"
import { useColors } from "../../components/mca/primitives/useColors"
import { colors as semanticColors, surface } from "../../components/mca/primitives/colors"
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

export interface BillingAuditWindowProps {
  windowId: string
  userId?: string
  subscriptionId?: string
  userName?: string
}

export function BillingAuditWindowContent(props: BillingAuditWindowProps) {
  const { t } = useTranslation()
  const c = useColors()
  const isDark = c.bgPage === surface.dark.bgPage
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
      <YStack flex={1} backgroundColor={c.bgPage} justifyContent="center" alignItems="center">
        <AppSpinner variant="brand" />
      </YStack>
    )
  }
  if (error || !audit) {
    return (
      <YStack
        testID="billing-audit-error"
        flex={1}
        backgroundColor={c.bgPage}
        justifyContent="center"
        alignItems="center"
        padding={20}
      >
        <Text fontSize={13} color={c.badges.err.text}>
          {t("billing.audit.loadError")}
        </Text>
      </YStack>
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
  const c = useColors()
  const { subscription: s, consumption: cns } = audit
  const driftBad = isDriftSignificant(cns.driftHours, cns.expectedHours, cns.actualHours)
  const pct = usagePercent(s.agentHoursUsed, s.agentHoursLimit)

  return (
    <YStack testID="billing-audit-window" flex={1} backgroundColor={c.bgPage}>
      <AuditHeader name={name} planName={s.planName} status={s.status} />
      <ScrollView style={{ flex: 1 }}>
        <YStack padding={12} gap={12}>
          <SummaryGrid
            pct={pct}
            used={s.agentHoursUsed}
            limit={s.agentHoursLimit}
            boost={s.boostHours}
            periodStart={s.currentPeriodStart}
            periodEnd={s.currentPeriodEnd}
          />
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
        </YStack>
      </ScrollView>
    </YStack>
  )
}

function AuditHeader({
  name,
  planName,
  status,
}: {
  name: string
  planName: string | null
  status: string
}) {
  const c = useColors()
  const isDark = c.bgPage === surface.dark.bgPage
  return (
    <XStack
      height={44}
      paddingHorizontal={12}
      alignItems="center"
      gap={8}
      borderBottomWidth={1}
      borderBottomColor={isDark ? "rgba(39,39,42,0.6)" : c.bgInner}
    >
      <Text fontSize={13} fontWeight="700" color={c.text} numberOfLines={1}>
        {name}
      </Text>
      <Text fontSize={12} color={semanticColors.indigo}>
        {planName ?? "—"}
      </Text>
      <StatusPill status={status} />
    </XStack>
  )
}

function StatusPill({ status }: { status: string }) {
  const c = useColors()
  return (
    <XStack
      paddingHorizontal={8}
      paddingVertical={2}
      borderRadius={9999}
      backgroundColor={c.badges.info.bg}
    >
      <Text fontSize={10} fontWeight="600" color={c.badges.info.text} textTransform="capitalize">
        {status}
      </Text>
    </XStack>
  )
}

function StatCard({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  const c = useColors()
  return (
    <YStack
      flex={1}
      minWidth={92}
      borderRadius={10}
      borderWidth={1}
      borderColor={c.border}
      backgroundColor={c.bgCard}
      padding={10}
    >
      <Text fontSize={15} fontWeight="700" color={accent ? semanticColors.indigo : c.text} letterSpacing={-0.3}>
        {value}
      </Text>
      <Text
        fontSize={10}
        color={c.text3}
        marginTop={3}
        textTransform="uppercase"
        letterSpacing={0.5}
      >
        {label}
      </Text>
    </YStack>
  )
}

function SummaryGrid(props: {
  pct: number | null
  used: number
  limit: number
  boost: number
  periodStart: string | null
  periodEnd: string | null
}) {
  const { t } = useTranslation()
  const hours =
    props.limit > 0 ? `${props.used.toFixed(1)} / ${props.limit}h` : `${props.used.toFixed(1)}h`
  return (
    <XStack gap={8} flexWrap="wrap">
      <StatCard label={t("billing.audit.hours")} value={hours} accent />
      <StatCard
        label={t("billing.audit.usage")}
        value={props.pct === null ? "—" : `${props.pct}%`}
      />
      <StatCard label={t("billing.audit.boost")} value={`${props.boost}h`} />
      <StatCard
        label={t("billing.audit.period")}
        value={`${day(props.periodStart)} → ${day(props.periodEnd)}`}
      />
    </XStack>
  )
}

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
  const driftColor = props.bad ? c.badges.err.text : c.badges.ok.text
  return (
    <YStack
      borderRadius={10}
      borderWidth={1}
      borderColor={c.border}
      backgroundColor={c.bgCard}
      padding={12}
      gap={8}
    >
      <SectionTitle title={props.title} />
      <XStack justifyContent="space-between">
        <KV label={props.expectedLabel} value={`${props.expected.toFixed(2)}h`} />
        <KV label={props.actualLabel} value={`${props.actual.toFixed(2)}h`} />
        <YStack alignItems="flex-end">
          <Text testID="billing-audit-drift" fontSize={13} fontWeight="700" color={driftColor}>
            {props.drift.toFixed(2)}h
          </Text>
          <Text fontSize={10} color={driftColor}>
            {props.bad ? props.badLabel : props.okLabel}
          </Text>
        </YStack>
      </XStack>
      <Text fontSize={11} color={c.text2}>
        {props.driftLabel}
      </Text>
    </YStack>
  )
}

function BoostsSection({ boosts }: { boosts: BillingAuditBoost[] }) {
  const { t } = useTranslation()
  const c = useColors()
  if (boosts.length === 0) return null
  return (
    <YStack
      borderRadius={10}
      borderWidth={1}
      borderColor={c.border}
      backgroundColor={c.bgCard}
      padding={12}
      gap={8}
    >
      <SectionTitle title={t("billing.audit.boosts")} count={boosts.length} />
      {boosts.map((b) => (
        <XStack key={b._id} justifyContent="space-between" alignItems="center">
          <Text fontSize={12} color={c.text}>
            {b.hours}h
          </Text>
          <Text fontSize={11} color={c.text2}>
            {day(b.periodStart)} → {day(b.periodEnd)}
          </Text>
          <Text fontSize={10} color={semanticColors.indigo} textTransform="uppercase">
            {t(`billing.audit.origin.${boostOrigin(b)}`)}
          </Text>
        </XStack>
      ))}
    </YStack>
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
  const c = useColors()
  return (
    <YStack
      borderRadius={10}
      borderWidth={1}
      borderColor={c.border}
      backgroundColor={c.bgCard}
      padding={12}
      gap={8}
    >
      <SectionTitle title={t("billing.audit.ledger")} count={total} />
      {entries.length === 0 ? (
        <Text fontSize={12} color={c.text2}>
          {t("billing.audit.ledgerEmpty")}
        </Text>
      ) : (
        entries.map((e) => (
          <XStack
            key={`${e.hourBucket}-${e.trackerRunId}`}
            justifyContent="space-between"
            alignItems="center"
          >
            <Text fontSize={11} color={c.text2} fontFamily="$mono">
              {e.hourBucket.slice(0, 16).replace("T", " ")}
            </Text>
            <Text fontSize={11} color={c.text}>
              +{e.hoursAdded.toFixed(3)}h
            </Text>
            <Text fontSize={11} color={c.text2}>
              Σ {e.cumulative.toFixed(2)}h
            </Text>
          </XStack>
        ))
      )}
      {truncated && (
        <Text fontSize={10} color={c.text2} fontStyle="italic">
          {t("billing.audit.ledgerTruncated", { shown: entries.length, total })}
        </Text>
      )}
    </YStack>
  )
}

function SnapshotsSection({ snapshots }: { snapshots: BillingAuditSnapshot[] }) {
  const { t } = useTranslation()
  const c = useColors()
  if (snapshots.length === 0) return null
  return (
    <YStack
      borderRadius={10}
      borderWidth={1}
      borderColor={c.border}
      backgroundColor={c.bgCard}
      padding={12}
      gap={8}
    >
      <SectionTitle title={t("billing.audit.snapshots")} count={snapshots.length} />
      {snapshots.map((s) => (
        <XStack
          key={`${s.periodStart}-${s.periodEnd}`}
          justifyContent="space-between"
          alignItems="center"
        >
          <Text fontSize={11} color={c.text2}>
            {day(s.periodStart)} → {day(s.periodEnd)}
          </Text>
          <Text fontSize={11} color={c.text}>
            {s.agentHoursUsed.toFixed(1)} / {s.agentHoursLimit}h
          </Text>
          <Text fontSize={11} color={s.overageHours > 0 ? c.badges.err.text : c.text2}>
            {s.overageHours > 0 ? `+${s.overageHours.toFixed(1)}h` : "—"}
          </Text>
        </XStack>
      ))}
    </YStack>
  )
}

function InvoicesSection({ invoices }: { invoices: BillingAuditInvoice[] }) {
  const { t } = useTranslation()
  const c = useColors()
  if (invoices.length === 0) return null
  return (
    <YStack
      borderRadius={10}
      borderWidth={1}
      borderColor={c.border}
      backgroundColor={c.bgCard}
      padding={12}
      gap={8}
    >
      <SectionTitle title={t("billing.audit.invoices")} count={invoices.length} />
      {invoices.map((i) => (
        <XStack key={i._id} justifyContent="space-between" alignItems="center">
          <Text fontSize={11} color={c.text2}>
            {day(i.periodStart)} → {day(i.periodEnd)}
          </Text>
          <Text fontSize={11} color={c.text}>
            {i.amount > 0 ? `${i.amount} ${i.currency}` : "—"}
          </Text>
          <Text fontSize={10} color={semanticColors.indigo} textTransform="capitalize">
            {i.status}
          </Text>
        </XStack>
      ))}
    </YStack>
  )
}

function SectionTitle({ title, count }: { title: string; count?: number }) {
  const c = useColors()
  return (
    <XStack gap={6} alignItems="center">
      <Text
        fontSize={11}
        fontWeight="700"
        color={c.text}
        textTransform="uppercase"
        letterSpacing={0.5}
      >
        {title}
      </Text>
      {count !== undefined && (
        <Text fontSize={11} color={c.text2}>
          {count}
        </Text>
      )}
    </XStack>
  )
}

function KV({ label, value }: { label: string; value: string }) {
  const c = useColors()
  return (
    <YStack>
      <Text fontSize={13} fontWeight="700" color={c.text}>
        {value}
      </Text>
      <Text fontSize={10} color={c.text2}>
        {label}
      </Text>
    </YStack>
  )
}
