/**
 * ResumenTab — the read-only overview of a user in the admin detail drill-in.
 *
 * Stats (agents/workspaces/cost/tokens) come from the lazy `getUserDetail`
 * enrichment; apps/conversations + activity + providers + metadata come from the
 * lightweight list row. The enrichment loads independently, so its KPIs show a
 * placeholder while loading and a RECOVERABLE inline banner on error — the rest
 * of the tab (row-derived data) always renders. Composes monitoring KPIs +
 * Sparkline and MCA primitives; every colour is a monitoring token.
 */

import {
  Bot,
  Building2,
  DollarSign,
  Hash,
  MessageSquare,
  RefreshCw,
  Users,
} from "@tamagui/lucide-icons"
import { useTranslation } from "react-i18next"
import { Text, XStack, YStack } from "tamagui"
import {
  Empty,
  IconChip,
  KeyValueGrid,
  type KeyValueRow,
  PillList,
} from "../../../components/mca/primitives"
import { tokens } from "../../../components/monitoring/colors"
import { KpiStrip, KpiTile, SectionCard } from "../../../components/monitoring/Kpi"
import { Sparkline } from "../../../components/monitoring/Sparkline"
import { ProviderIcon } from "../../../components/providers/ProviderIcons"
import type { UserDetailEnrichment, UserSummary } from "../../../services/AdminApi"
import { formatCompact, formatCost, formatDate, formatRelative } from "../usersModel"

export interface ResumenTabProps {
  user: UserSummary
  detail: UserDetailEnrichment | null
  loading: boolean
  error?: string | null
  onRetry: () => void
}

/** Enrichment KPI value: placeholder while loading, dash on error, else formatted. */
function enrich(loading: boolean, loaded: boolean, format: () => string): string {
  if (loaded) return format()
  return loading ? "…" : "—"
}

export function ResumenTab({ user, detail, loading, error, onRetry }: ResumenTabProps) {
  const { t } = useTranslation()
  const loaded = detail != null
  const s = detail?.stats

  return (
    <YStack gap={20} paddingTop={4}>
      {error ? (
        <EnrichmentError
          message={error}
          onRetry={onRetry}
          retryLabel={t("windows.usersPanel.retry")}
        />
      ) : null}

      <KpiStrip>
        <KpiTile
          icon={Users}
          label={t("windows.usersPanel.detail.stats.apps")}
          value={String(user.stats.apps)}
        />
        <KpiTile
          icon={MessageSquare}
          label={t("windows.usersPanel.detail.stats.conversations")}
          value={String(user.stats.channels)}
        />
        <KpiTile
          icon={Bot}
          label={t("windows.usersPanel.detail.stats.agents")}
          value={enrich(loading, loaded, () => String(s?.agents ?? 0))}
        />
        <KpiTile
          icon={Building2}
          label={t("windows.usersPanel.detail.stats.workspaces")}
          value={enrich(loading, loaded, () => String(s?.workspaces ?? 0))}
        />
        <KpiTile
          icon={DollarSign}
          label={t("windows.usersPanel.detail.stats.cost")}
          value={enrich(loading, loaded, () => formatCost(s?.totalCost ?? 0))}
        />
        <KpiTile
          icon={Hash}
          label={t("windows.usersPanel.detail.stats.tokens")}
          value={enrich(loading, loaded, () => formatCompact(s?.totalTokens ?? 0))}
        />
      </KpiStrip>

      <ActivitySection user={user} />
      <ProvidersSection user={user} />
      <MetaSection user={user} />
    </YStack>
  )
}

function EnrichmentError({
  message,
  onRetry,
  retryLabel,
}: {
  message: string
  onRetry: () => void
  retryLabel: string
}) {
  return (
    <XStack
      testID="resumen-enrichment-error"
      ai="center"
      gap={10}
      paddingHorizontal={12}
      paddingVertical={9}
      borderRadius={10}
      borderWidth={1}
      borderColor={`${tokens.error}38`}
      backgroundColor={`${tokens.error}1A`}
    >
      <Text flex={1} fontSize={13} color={tokens.error} numberOfLines={2}>
        {message}
      </Text>
      <XStack
        testID="resumen-enrichment-retry"
        ai="center"
        gap={5}
        cursor="pointer"
        hoverStyle={{ opacity: 0.8 }}
        onPress={onRetry}
        {...({ role: "button", tabIndex: 0 } as Record<string, unknown>)}
      >
        <RefreshCw size={13} color={tokens.text} />
        <Text fontSize={12} fontWeight="600" color={tokens.text}>
          {retryLabel}
        </Text>
      </XStack>
    </XStack>
  )
}

function ActivitySection({ user }: { user: UserSummary }) {
  const { t } = useTranslation()
  const activity = user.activity ?? []
  const values = activity.map((d) => d.count)
  const total = values.reduce((a, b) => a + b, 0)

  return (
    <SectionCard title={t("windows.usersPanel.detail.activityTitle")}>
      {activity.length === 0 || total === 0 ? (
        <Empty message={t("windows.usersPanel.detail.noActivity")} />
      ) : (
        <YStack height={56} justifyContent="flex-end">
          <Sparkline values={values} color={tokens.success} height={56} />
        </YStack>
      )}
    </SectionCard>
  )
}

function ProvidersSection({ user }: { user: UserSummary }) {
  const { t } = useTranslation()
  const providers = user.providers ?? []

  return (
    <SectionCard title={t("windows.usersPanel.detail.providersTitle")}>
      {providers.length === 0 ? (
        <Empty message={t("windows.usersPanel.detail.noProviders")} />
      ) : (
        <PillList
          max={12}
          items={providers.map((p) => (
            <IconChip
              key={p.providerType}
              icon={<ProviderIcon providerType={p.providerType} size={9} />}
              text={p.displayName}
              accent={tokens.success}
            />
          ))}
        />
      )}
    </SectionCard>
  )
}

function MetaSection({ user }: { user: UserSummary }) {
  const { t } = useTranslation()
  const badges = user.badges ?? []
  const badgeLabels = badges.map((b) => t(`windows.usersPanel.detail.badge.${b}`))

  const rows: KeyValueRow[] = [
    { key: t("windows.usersPanel.detail.meta.userId"), value: user.userId, mono: true },
    { key: t("windows.usersPanel.detail.meta.joined"), value: formatDate(user.createdAt) },
    { key: t("windows.usersPanel.detail.meta.lastSeen"), value: formatRelative(user.lastLoginAt) },
    {
      key: t("windows.usersPanel.detail.meta.emailVerified"),
      value: user.emailVerified
        ? t("windows.usersPanel.detail.meta.yes")
        : t("windows.usersPanel.detail.meta.no"),
    },
    {
      key: t("windows.usersPanel.detail.meta.badges"),
      value:
        badgeLabels.length > 0 ? <PillList items={badgeLabels} accent={tokens.warning} /> : "—",
    },
  ]

  return (
    <SectionCard title={t("windows.usersPanel.detail.metadataTitle")}>
      <KeyValueGrid rows={rows} keyWidth={120} />
    </SectionCard>
  )
}
