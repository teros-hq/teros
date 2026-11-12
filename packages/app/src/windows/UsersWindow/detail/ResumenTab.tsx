/**
 * ResumenTab — the read-only overview of a user in the admin detail drill-in.
 *
 * Stats (agents/workspaces/cost/tokens) come from the lazy `getUserDetail`
 * enrichment; apps/conversations + activity + providers + metadata come from the
 * lightweight list row. The enrichment loads independently, so its KPIs show a
 * placeholder while loading and a RECOVERABLE inline banner on error — the rest
 * of the tab (row-derived data) always renders. Composed from the ds `Stats` /
 * `Card` primitives; every colour comes from `useColors()`.
 */

import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { View } from "react-native"
import { useColors } from "../../../components/mca/primitives/useColors"
import { Badge, Btn, Card, EmptyHint, Stat, Stats, T } from "../../../components/ui/ds"
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
    <View style={{ gap: 16 }}>
      {error ? (
        <EnrichmentError
          message={error}
          onRetry={onRetry}
          retryLabel={t("windows.usersPanel.retry")}
        />
      ) : null}

      <Stats cols={3}>
        <Stat label={t("windows.usersPanel.detail.stats.apps")} v={String(user.stats.apps)} />
        <Stat
          label={t("windows.usersPanel.detail.stats.conversations")}
          v={String(user.stats.channels)}
        />
        <Stat
          label={t("windows.usersPanel.detail.stats.agents")}
          v={enrich(loading, loaded, () => String(s?.agents ?? 0))}
        />
        <Stat
          label={t("windows.usersPanel.detail.stats.workspaces")}
          v={enrich(loading, loaded, () => String(s?.workspaces ?? 0))}
        />
        <Stat
          label={t("windows.usersPanel.detail.stats.cost")}
          v={enrich(loading, loaded, () => formatCost(s?.totalCost ?? 0))}
        />
        <Stat
          label={t("windows.usersPanel.detail.stats.tokens")}
          v={enrich(loading, loaded, () => formatCompact(s?.totalTokens ?? 0))}
        />
      </Stats>

      <ActivitySection user={user} />
      <ProvidersSection user={user} />
      <MetaSection user={user} />
    </View>
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
  const c = useColors()
  return (
    <View
      testID="resumen-enrichment-error"
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: c.tint.r.bd,
        backgroundColor: c.tint.r.bg,
      }}
    >
      <T step="sm" color={c.tint.r.tx} numberOfLines={2} style={{ flex: 1 }}>
        {message}
      </T>
      <Btn
        testID="resumen-enrichment-retry"
        variant="ghost"
        size="sm"
        icon="arrows-clockwise"
        onPress={onRetry}
      >
        {retryLabel}
      </Btn>
    </View>
  )
}

/** A titled section card: `T base` title + content. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card pad>
      <T step="base" style={{ marginBottom: 12 }}>
        {title}
      </T>
      {children}
    </Card>
  )
}

function ActivitySection({ user }: { user: UserSummary }) {
  const { t } = useTranslation()
  const activity = user.activity ?? []
  const values = activity.map((d) => d.count)
  const total = values.reduce((a, b) => a + b, 0)

  return (
    <Section title={t("windows.usersPanel.detail.activityTitle")}>
      {activity.length === 0 || total === 0 ? (
        <EmptyHint>{t("windows.usersPanel.detail.noActivity")}</EmptyHint>
      ) : (
        <View style={{ height: 64, justifyContent: "flex-end" }}>
          <Sparkline values={values} height={64} />
        </View>
      )}
    </Section>
  )
}

function ProvidersSection({ user }: { user: UserSummary }) {
  const { t } = useTranslation()
  const c = useColors()
  const providers = user.providers ?? []

  return (
    <Section title={t("windows.usersPanel.detail.providersTitle")}>
      {providers.length === 0 ? (
        <EmptyHint>{t("windows.usersPanel.detail.noProviders")}</EmptyHint>
      ) : (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {providers.slice(0, 12).map((p) => (
            <View
              key={p.providerType}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                height: 36,
                paddingHorizontal: 14,
                borderRadius: 100,
                backgroundColor: c.wash,
              }}
            >
              <ProviderIcon providerType={p.providerType} size={13} color={c.text2} />
              <T step="sm">{p.displayName}</T>
            </View>
          ))}
          {providers.length > 12 ? (
            <T step="codenote" tone="text3" style={{ alignSelf: "center" }}>
              +{providers.length - 12}
            </T>
          ) : null}
        </View>
      )}
    </Section>
  )
}

function MetaRow({ label, value, last }: { label: string; value: ReactNode; last?: boolean }) {
  const c = useColors()
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 14,
        paddingVertical: 10,
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: c.border,
      }}
    >
      <T step="sm" tone="text3" style={{ width: 140 }}>
        {label}
      </T>
      <View style={{ flex: 1, minWidth: 0 }}>
        {typeof value === "string" ? <T step="sm">{value}</T> : value}
      </View>
    </View>
  )
}

function MetaSection({ user }: { user: UserSummary }) {
  const { t } = useTranslation()
  const badges = user.badges ?? []
  const badgeLabels = badges.map((b) => t(`windows.usersPanel.detail.badge.${b}`))

  return (
    <Section title={t("windows.usersPanel.detail.metadataTitle")}>
      <View style={{ marginTop: -6 }}>
        <MetaRow
          label={t("windows.usersPanel.detail.meta.userId")}
          value={
            <T step="code" tone="text2" selectable>
              {user.userId}
            </T>
          }
        />
        <MetaRow
          label={t("windows.usersPanel.detail.meta.joined")}
          value={formatDate(user.createdAt)}
        />
        <MetaRow
          label={t("windows.usersPanel.detail.meta.lastSeen")}
          value={formatRelative(user.lastLoginAt)}
        />
        <MetaRow
          label={t("windows.usersPanel.detail.meta.emailVerified")}
          value={
            user.emailVerified
              ? t("windows.usersPanel.detail.meta.yes")
              : t("windows.usersPanel.detail.meta.no")
          }
        />
        <MetaRow
          last
          label={t("windows.usersPanel.detail.meta.badges")}
          value={
            badgeLabels.length > 0 ? (
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                {badgeLabels.map((label) => (
                  <Badge key={label} tone="a" pill>
                    {label}
                  </Badge>
                ))}
              </View>
            ) : (
              "—"
            )
          }
        />
      </View>
    </Section>
  )
}
