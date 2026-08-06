/**
 * Users Window Content
 *
 * Admin Users panel, rebuilt on the Monitoring design system (TER-683 · PR2):
 * - A two-view shell: a sortable/filterable `DataTable` LIST and a per-user
 *   DETAIL drill-in (a stub here; PR3 fills it in).
 * - Server-side search + filters (Estado / Rol / Plan / Cuota) + numbered
 *   pagination, so the panel scales past the old 100-user cap.
 * - A clickable KPI strip (Cerca del límite / Agotadas jump to the Cuota filter).
 *
 * Layer separation: the backend returns DATA (ids + resolved names + a `pct`);
 * this file composes the UI. All colours come from `monitoring/colors` tokens.
 */

import { ChevronLeft, ChevronRight, Search, Users, X } from "@tamagui/lucide-icons"
import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { Pressable, TextInput } from "react-native"
import { ScrollView, Text, XStack, YStack } from "tamagui"
import { Avatar, Badge, Empty } from "../../components/mca/primitives"
import { AppSpinner } from "../../components/ui/AppSpinner"
import { scrollbarThin, tokens } from "../../components/monitoring/colors"
import { type Column, DataTable } from "../../components/monitoring/DataTable"
import { KpiStrip, KpiTile } from "../../components/monitoring/Kpi"
import { SegmentedTabs } from "../../components/monitoring/SegmentedTabs"
import { Sparkline } from "../../components/monitoring/Sparkline"
import { ProviderIcon } from "../../components/providers/ProviderIcons"
import type { UsageFilter, UserRole, UserStatus, UserSummary } from "../../services/AdminApi"
import { getTerosClient } from "../../services/terosClientSingleton"
import { UserDetailView } from "./detail/UserDetailView"
import { Select } from "./Select"
import { UsersHeader } from "./UsersHeader"
import {
  formatRelative,
  hoursColor,
  hoursUsage,
  lastAccessSortValue,
  planBadge,
  roleBadgeVariant,
  USAGE_FILTER_OPTIONS,
  userStatusMeta,
} from "./usersModel"

const PAGE_SIZE = 50

type StatusFilter = UserStatus | "all"
type RoleFilter = UserRole | "all"
type UsageFilterAll = UsageFilter | "all"
type View = { mode: "list" } | { mode: "detail"; userId: string }

interface Summary {
  total: number
  active: number
  admins: number
  nearLimit: number
  exhausted: number
}

const STATUS_KEYS: StatusFilter[] = ["all", "active", "suspended", "pending_verification"]
const ROLE_KEYS: RoleFilter[] = ["all", "user", "admin", "super"]

export interface UsersWindowContentProps {
  windowId: string
}

// Priority for the responsive column set (high → low). `user` is never dropped.
const COLUMN_PRIORITY = [
  "user",
  "plan",
  "hours",
  "status",
  "activity",
  "providers",
  "role",
  "lastAccess",
  "apps",
  "convs",
]
const TABLE_H_PADDING = 24 // DataTable inner horizontal padding (12 + 12)
const TABLE_COL_GAP = 12

/**
 * Greedily keep the highest-priority columns that FIT the measured width, so the
 * table always fits the window — never a horizontal scrollbar. Whatever a dropped
 * column would show is still on the user's detail view (drill-in).
 */
function pickVisibleColumns(columns: Column<UserSummary>[], width: number): Column<UserSummary>[] {
  if (width <= 0) return columns // before measurement: render all
  const byKey = new Map(columns.map((c) => [c.key, c]))
  const keep = new Set<string>()
  let used = TABLE_H_PADDING
  for (const key of COLUMN_PRIORITY) {
    const col = byKey.get(key)
    if (!col) continue
    const needed = col.width + (keep.size > 0 ? TABLE_COL_GAP : 0)
    if (keep.size === 0 || used + needed <= width) {
      used += needed
      keep.add(key)
    } else {
      break // stop at the first priority column that no longer fits
    }
  }
  return columns.filter((c) => keep.has(c.key))
}

export function UsersWindowContent(_props: UsersWindowContentProps) {
  const client = getTerosClient()
  const { t } = useTranslation()

  const [view, setView] = useState<View>({ mode: "list" })
  const [selectedUser, setSelectedUser] = useState<UserSummary | null>(null)

  const [users, setUsers] = useState<UserSummary[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [forbidden, setForbidden] = useState(false)
  // Distinct plans seen across loads (planId → planName) → the Plan dropdown.
  const [planOptions, setPlanOptions] = useState<Map<string, string>>(new Map())

  // Query params (server-side).
  const [searchInput, setSearchInput] = useState("")
  const [search, setSearch] = useState("") // debounced
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all")
  const [planFilter, setPlanFilter] = useState<string>("all")
  const [usageFilter, setUsageFilter] = useState<UsageFilterAll>("all")
  const [page, setPage] = useState(0)

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))

  // Debounce the search box; reset to the first page whenever the term changes.
  useEffect(() => {
    const id = setTimeout(() => {
      setSearch(searchInput.trim())
      setPage(0)
    }, 300)
    return () => clearTimeout(id)
  }, [searchInput])

  const loadUsers = useCallback(async () => {
    setLoading(true)
    try {
      const result = await client.admin.listUsers({
        search: search || undefined,
        status: statusFilter === "all" ? undefined : statusFilter,
        role: roleFilter === "all" ? undefined : roleFilter,
        plan: planFilter === "all" ? undefined : planFilter,
        usage: usageFilter === "all" ? undefined : usageFilter,
        page,
        pageSize: PAGE_SIZE,
      })
      setUsers(result.users)
      setSummary(result.summary as Summary)
      setTotal(result.total)
      setError(null)
      setForbidden(false)
      setPlanOptions((prev) => {
        const next = new Map(prev)
        for (const u of result.users) {
          if (u.billing?.planId) next.set(u.billing.planId, u.billing.planName ?? u.billing.planId)
        }
        return next
      })
    } catch (err: any) {
      if (err?.code === "FORBIDDEN") {
        setForbidden(true)
      } else {
        setError(err?.message || t("errors.users.loadFailed"))
      }
    } finally {
      setLoading(false)
    }
  }, [client, search, statusFilter, roleFilter, planFilter, usageFilter, page, t])

  useEffect(() => {
    if (client.isConnected()) {
      loadUsers()
      return
    }
    const onConnected = () => loadUsers()
    client.on("connected", onConnected)
    return () => client.off("connected", onConnected)
  }, [client, loadUsers])

  const resetFilters = useCallback(() => {
    setSearchInput("")
    setSearch("")
    setStatusFilter("all")
    setRoleFilter("all")
    setPlanFilter("all")
    setUsageFilter("all")
    setPage(0)
  }, [])

  const changeStatus = (k: StatusFilter) => {
    setStatusFilter(k)
    setPage(0)
  }
  const changeRole = (k: RoleFilter) => {
    setRoleFilter(k)
    setPage(0)
  }
  const changePlan = (k: string) => {
    setPlanFilter(k)
    setPage(0)
  }
  const changeUsage = (k: UsageFilterAll) => {
    setUsageFilter(k)
    setPage(0)
  }

  const openDetail = useCallback((u: UserSummary) => {
    setSelectedUser(u)
    setView({ mode: "detail", userId: u.userId })
  }, [])

  // After a detail action (status/role/access change), patch BOTH the selected
  // user (drives the detail identity) and the row in the current page (drives the
  // list when we go back) so the change reflects immediately without a re-fetch.
  const applyRowUpdate = useCallback((userId: string, patch: Partial<UserSummary>) => {
    setSelectedUser((prev) => (prev && prev.userId === userId ? { ...prev, ...patch } : prev))
    setUsers((prev) => prev.map((u) => (u.userId === userId ? { ...u, ...patch } : u)))
  }, [])

  // Measured width of the table area → responsive column set (no h-scroll).
  const [tableWidth, setTableWidth] = useState(0)

  const columns = useMemo<Column<UserSummary>[]>(
    () => [
      {
        key: "user",
        header: t("windows.usersPanel.columns.user"),
        width: 210,
        flex: 2,
        sortable: true,
        sortValue: (u) => (u.profile.displayName ?? u.profile.email ?? "").toLowerCase(),
        // Name + email STACKED (like the old card) so email stays visible without
        // eating its own column — key to fitting everything on a narrow window.
        render: (u) => (
          <XStack ai="center" gap={8} minWidth={0} width="100%">
            <Avatar
              src={u.profile.avatarUrl}
              name={u.profile.displayName ?? u.profile.email}
              size={24}
            />
            <YStack flex={1} minWidth={0}>
              <Text fontSize={12} color={tokens.text} numberOfLines={1} ellipsizeMode="tail">
                {u.profile.displayName ?? u.profile.email ?? "—"}
              </Text>
              {u.profile.email ? (
                <Text fontSize={10} color={tokens.textMuted} numberOfLines={1} ellipsizeMode="tail">
                  {u.profile.email}
                </Text>
              ) : null}
            </YStack>
          </XStack>
        ),
      },
      {
        key: "role",
        header: t("windows.usersPanel.columns.role"),
        width: 84,
        render: (u) => (
          <Badge text={t(`windows.usersPanel.role.${u.role}`)} variant={roleBadgeVariant(u.role)} />
        ),
      },
      {
        key: "status",
        header: t("windows.usersPanel.columns.status"),
        width: 116,
        render: (u) => {
          const m = userStatusMeta(u.status)
          return (
            <XStack ai="center" gap={6} minWidth={0}>
              <YStack
                width={7}
                height={7}
                borderRadius={9999}
                backgroundColor={m.color}
                flexShrink={0}
              />
              <Text fontSize={12} color={tokens.textSecondary} numberOfLines={1}>
                {t(m.labelKey)}
              </Text>
            </XStack>
          )
        },
      },
      {
        key: "plan",
        header: t("windows.usersPanel.columns.plan"),
        width: 116,
        render: (u) => {
          if (!u.billing) return "—"
          const pb = planBadge(u.billing.planId, u.billing.planName)
          return (
            <XStack
              ai="center"
              paddingHorizontal={8}
              paddingVertical={2}
              borderRadius={9999}
              borderWidth={1}
              borderColor={`${pb.color}33`}
              backgroundColor={`${pb.color}1A`}
              minWidth={0}
            >
              <Text fontSize={11} color={pb.color} numberOfLines={1}>
                {pb.label}
              </Text>
            </XStack>
          )
        },
      },
      {
        key: "apps",
        header: t("windows.usersPanel.columns.apps"),
        width: 60,
        align: "right",
        sortable: true,
        sortValue: (u) => u.stats.apps,
        color: (u) => (u.stats.apps > 0 ? tokens.textSecondary : tokens.textMuted),
        render: (u) => String(u.stats.apps),
      },
      {
        key: "convs",
        header: t("windows.usersPanel.columns.convs"),
        width: 62,
        align: "right",
        sortable: true,
        sortValue: (u) => u.stats.channels,
        color: (u) => (u.stats.channels > 0 ? tokens.textSecondary : tokens.textMuted),
        render: (u) => String(u.stats.channels),
      },
      {
        key: "providers",
        header: t("windows.usersPanel.columns.providers"),
        width: 104,
        render: (u) => {
          if (u.providers.length === 0)
            return (
              <Text fontSize={12} color={tokens.textMuted}>
                —
              </Text>
            )
          // Dedupe by type so a user with two keys of the same provider shows one icon.
          const types = [...new Set(u.providers.map((p) => p.providerType))]
          const shown = types.slice(0, 5)
          return (
            <XStack ai="center" gap={4} minWidth={0}>
              {shown.map((tp) => (
                <XStack
                  key={tp}
                  ai="center"
                  jc="center"
                  width={18}
                  height={18}
                  borderRadius={5}
                  borderWidth={1}
                  borderColor={tokens.border}
                  backgroundColor={tokens.bgInner}
                >
                  <ProviderIcon providerType={tp} size={11} />
                </XStack>
              ))}
              {types.length > shown.length ? (
                <Text fontSize={11} color={tokens.textMuted}>
                  +{types.length - shown.length}
                </Text>
              ) : null}
            </XStack>
          )
        },
      },
      {
        key: "activity",
        header: t("windows.usersPanel.columns.activity"),
        width: 88,
        render: (u) => {
          const values = u.activity.map((a) => a.count)
          const total = values.reduce((s, n) => s + n, 0)
          // Sparkline needs a visible baseline; render a muted dash for zero activity.
          return total > 0 ? (
            <Sparkline values={values} height={20} color={tokens.accent} />
          ) : (
            <Text fontSize={12} color={tokens.textMuted}>
              —
            </Text>
          )
        },
      },
      {
        key: "hours",
        header: t("windows.usersPanel.columns.hours"),
        width: 96,
        align: "right",
        sortable: true,
        sortValue: (u) => hoursUsage(u.billing).pct ?? -1,
        color: (u) => {
          const h = hoursUsage(u.billing)
          return hoursColor(h.pct, h.unmetered)
        },
        render: (u) => hoursUsage(u.billing).label,
      },
      {
        key: "lastAccess",
        header: t("windows.usersPanel.columns.lastAccess"),
        width: 108,
        align: "right",
        sortable: true,
        sortValue: (u) => lastAccessSortValue(u.lastLoginAt),
        color: () => tokens.textTertiary,
        render: (u) => formatRelative(u.lastLoginAt),
      },
    ],
    [t],
  )

  const visibleColumns = useMemo(
    () => pickVisibleColumns(columns, tableWidth),
    [columns, tableWidth],
  )

  // ── FORBIDDEN: keep the full-window block (admin/super only) ──────────────────
  if (forbidden) {
    return (
      <YStack
        flex={1}
        backgroundColor={tokens.bg}
        justifyContent="center"
        alignItems="center"
        padding={24}
        gap={12}
      >
        <Users size={48} color={tokens.error} />
        <Text color={tokens.error} textAlign="center" fontWeight="600">
          {t("errors.users.adminRequired")}
        </Text>
        <Text color={tokens.textTertiary} fontSize={13} textAlign="center">
          {t("errors.users.privilegesRequired")}
        </Text>
      </YStack>
    )
  }

  // ── DETAIL (PR3): the fragmented per-user drill-in ────────────────────────────
  if (view.mode === "detail") {
    const detailUser =
      selectedUser?.userId === view.userId
        ? selectedUser
        : users.find((u) => u.userId === view.userId)
    if (!detailUser) {
      // The row left the current page (filters/page changed) — offer a way back.
      return (
        <YStack flex={1} backgroundColor={tokens.bg}>
          <UsersHeader
            crumbs={[
              { label: t("windows.usersPanel.title"), onPress: () => setView({ mode: "list" }) },
            ]}
          />
        </YStack>
      )
    }
    return (
      <UserDetailView
        user={detailUser}
        onBack={() => setView({ mode: "list" })}
        onUpdate={(patch) => applyRowUpdate(detailUser.userId, patch)}
      />
    )
  }

  // ── LIST ──────────────────────────────────────────────────────────────────────
  const hasFilters =
    !!search ||
    statusFilter !== "all" ||
    roleFilter !== "all" ||
    planFilter !== "all" ||
    usageFilter !== "all"

  const planSelectOptions = [
    { key: "all", label: t("windows.usersPanel.plan.all") },
    ...[...planOptions.entries()].map(([planId, planName]) => ({ key: planId, label: planName })),
  ]
  const usageSelectOptions = USAGE_FILTER_OPTIONS.map((o) => ({ key: o.key, label: t(o.labelKey) }))

  const activeChips: { key: string; label: string; onRemove: () => void }[] = []
  if (search) {
    activeChips.push({
      key: "search",
      label: `"${search}"`,
      onRemove: () => {
        setSearchInput("")
        setSearch("")
        setPage(0)
      },
    })
  }
  if (statusFilter !== "all") {
    activeChips.push({
      key: "status",
      label: t(userStatusMeta(statusFilter).labelKey),
      onRemove: () => changeStatus("all"),
    })
  }
  if (roleFilter !== "all") {
    activeChips.push({
      key: "role",
      label: t(`windows.usersPanel.role.${roleFilter}`),
      onRemove: () => changeRole("all"),
    })
  }
  if (planFilter !== "all") {
    activeChips.push({
      key: "plan",
      label: planOptions.get(planFilter) ?? planFilter,
      onRemove: () => changePlan("all"),
    })
  }
  if (usageFilter !== "all") {
    activeChips.push({
      key: "usage",
      label: usageSelectOptions.find((o) => o.key === usageFilter)?.label ?? usageFilter,
      onRemove: () => changeUsage("all"),
    })
  }

  const searchBox = (
    <XStack
      ai="center"
      gap={8}
      flex={1}
      minWidth={220}
      paddingHorizontal={12}
      paddingVertical={8}
      borderRadius={10}
      borderWidth={1}
      borderColor={tokens.border}
      backgroundColor={tokens.bgInner}
    >
      <Search size={15} color={tokens.textMuted} />
      <TextInput
        testID="users-search"
        style={{ flex: 1, color: tokens.text, fontSize: 14, outlineStyle: "none" } as any}
        value={searchInput}
        onChangeText={setSearchInput}
        placeholder={t("windows.usersPanel.searchPlaceholder")}
        placeholderTextColor={tokens.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
      />
      {searchInput.length > 0 ? (
        <Pressable
          onPress={() => setSearchInput("")}
          hitSlop={8}
          aria-label={t("windows.usersPanel.clear")}
        >
          <X size={15} color={tokens.textTertiary} />
        </Pressable>
      ) : null}
    </XStack>
  )

  return (
    <YStack flex={1} backgroundColor={tokens.bg}>
      <UsersHeader
        crumbs={[{ label: t("windows.usersPanel.title") }]}
        statusText={
          summary ? t("windows.usersPanel.statusUsers", { count: summary.total }) : undefined
        }
        controls={searchBox}
      />

      {summary ? (
        <KpiStrip>
          <KpiTile label={t("windows.usersPanel.kpi.total")} value={String(summary.total)} />
          <KpiTile
            label={t("windows.usersPanel.kpi.active")}
            value={String(summary.active)}
            valueColor={summary.active > 0 ? tokens.success : undefined}
          />
          <ClickableKpi
            testID="kpi-near"
            active={usageFilter === "near"}
            onPress={() => changeUsage("near")}
          >
            <KpiTile
              label={t("windows.usersPanel.kpi.nearLimit")}
              value={String(summary.nearLimit)}
              valueColor={summary.nearLimit > 0 ? tokens.warning : undefined}
            />
          </ClickableKpi>
          <ClickableKpi
            testID="kpi-exhausted"
            active={usageFilter === "exhausted"}
            onPress={() => changeUsage("exhausted")}
          >
            <KpiTile
              label={t("windows.usersPanel.kpi.exhausted")}
              value={String(summary.exhausted)}
              valueColor={summary.exhausted > 0 ? tokens.error : undefined}
            />
          </ClickableKpi>
          <KpiTile label={t("windows.usersPanel.kpi.admins")} value={String(summary.admins)} />
        </KpiStrip>
      ) : null}

      {/* Filter bar */}
      <YStack paddingHorizontal={16} paddingVertical={12} gap={10} zIndex={10}>
        <XStack gap={16} flexWrap="wrap" ai="flex-end">
          <FilterGroup label={t("windows.usersPanel.filters.status")}>
            <SegmentedTabs
              tabs={STATUS_KEYS.map((k) => ({
                key: k,
                label:
                  k === "all" ? t("windows.usersPanel.status.all") : t(userStatusMeta(k).labelKey),
              }))}
              active={statusFilter}
              onChange={(k) => changeStatus(k as StatusFilter)}
            />
          </FilterGroup>
          <FilterGroup label={t("windows.usersPanel.filters.role")}>
            <SegmentedTabs
              tabs={ROLE_KEYS.map((k) => ({ key: k, label: t(`windows.usersPanel.role.${k}`) }))}
              active={roleFilter}
              onChange={(k) => changeRole(k as RoleFilter)}
            />
          </FilterGroup>
          <FilterGroup label={t("windows.usersPanel.filters.plan")}>
            <Select
              testID="filter-plan"
              value={planFilter}
              options={planSelectOptions}
              onChange={changePlan}
              ariaLabel={t("windows.usersPanel.filters.plan")}
            />
          </FilterGroup>
          <FilterGroup label={t("windows.usersPanel.filters.usage")}>
            <Select
              testID="filter-usage"
              value={usageFilter}
              options={usageSelectOptions}
              onChange={(k) => changeUsage(k as UsageFilterAll)}
              ariaLabel={t("windows.usersPanel.filters.usage")}
            />
          </FilterGroup>
        </XStack>

        {activeChips.length > 0 ? (
          <XStack gap={6} ai="center" flexWrap="wrap">
            {activeChips.map((chip) => (
              <FilterChip
                key={chip.key}
                label={chip.label}
                onRemove={chip.onRemove}
                removeLabel={t("windows.usersPanel.clear")}
              />
            ))}
            <Pressable onPress={resetFilters}>
              <Text fontSize={12} fontWeight="600" color={tokens.accent}>
                {t("windows.usersPanel.clear")}
              </Text>
            </Pressable>
          </XStack>
        ) : null}
      </YStack>

      <ScrollView
        flex={1}
        // @ts-expect-error — RN-Web thin scrollbar (Teros standard)
        style={scrollbarThin}
      >
        <YStack paddingHorizontal={16} paddingBottom={16} gap={12}>
          {error ? (
            <XStack
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
                {error}
              </Text>
              <Pressable onPress={() => loadUsers()}>
                <Text fontSize={12} fontWeight="600" color={tokens.text}>
                  {t("windows.usersPanel.retry")}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setError(null)}
                hitSlop={8}
                aria-label={t("windows.usersPanel.clear")}
              >
                <X size={15} color={tokens.textTertiary} />
              </Pressable>
            </XStack>
          ) : null}

          {loading ? (
            <YStack padding={24} ai="center" gap={8}>
              <AppSpinner size="md" color={tokens.accent} />
              <Text color={tokens.textTertiary} fontSize={12}>
                {t("common.loading")}
              </Text>
            </YStack>
          ) : users.length === 0 ? (
            <Empty
              icon={<Users size={40} color={tokens.textMuted} />}
              message={
                hasFilters
                  ? t("windows.usersPanel.empty.noMatch")
                  : t("windows.usersPanel.empty.none")
              }
              hint={hasFilters ? t("windows.usersPanel.empty.clearHint") : undefined}
            />
          ) : (
            <YStack
              onLayout={(e) => setTableWidth(e.nativeEvent.layout.width)}
              minWidth={0}
              width="100%"
            >
              <DataTable<UserSummary>
                columns={visibleColumns}
                rows={users}
                rowKey={(u) => u.userId}
                onRowPress={openDetail}
              />
            </YStack>
          )}

          {!loading && total > PAGE_SIZE ? (
            <Pagination
              page={page}
              pageCount={pageCount}
              total={total}
              onChange={setPage}
              rangeLabel={(from, to) =>
                t("windows.usersPanel.pagination.range", { from, to, total })
              }
            />
          ) : null}
        </YStack>
      </ScrollView>
    </YStack>
  )
}

// ─── Local UI helpers (tokens only; no StyleSheet) ────────────────────────────

function FilterGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <YStack gap={5} minWidth={0}>
      <Text
        fontSize={10}
        fontWeight="600"
        letterSpacing={0.5}
        textTransform="uppercase"
        color={tokens.textTertiary}
      >
        {label}
      </Text>
      {children}
    </YStack>
  )
}

function ClickableKpi({
  testID,
  active,
  onPress,
  children,
}: {
  testID: string
  active: boolean
  onPress: () => void
  children: ReactNode
}) {
  return (
    <YStack
      testID={testID}
      flex={1}
      minWidth={0}
      cursor="pointer"
      hoverStyle={{ opacity: 0.85 }}
      onPress={onPress}
      {...({
        role: "button",
        tabIndex: 0,
        "aria-pressed": active,
        onKeyDown: (e: { key: string; preventDefault: () => void }) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            onPress()
          }
        },
      } as any)}
    >
      {children}
    </YStack>
  )
}

function FilterChip({
  label,
  onRemove,
  removeLabel,
}: {
  label: string
  onRemove: () => void
  removeLabel: string
}) {
  return (
    <XStack
      ai="center"
      gap={6}
      paddingVertical={4}
      paddingHorizontal={9}
      borderRadius={9999}
      borderWidth={1}
      borderColor={tokens.borderHover}
      backgroundColor={tokens.bgPress}
    >
      <Text fontSize={12} color={tokens.textSecondary} numberOfLines={1}>
        {label}
      </Text>
      <Pressable onPress={onRemove} hitSlop={6} aria-label={removeLabel}>
        <X size={12} color={tokens.textTertiary} />
      </Pressable>
    </XStack>
  )
}

// ─── Pagination (tokens only) ─────────────────────────────────────────────────

/** Build a compact page-number window: 0 … (p-1) p (p+1) … last */
function pageWindow(page: number, pageCount: number): number[] {
  const pages = new Set<number>([0, pageCount - 1, page, page - 1, page + 1])
  return [...pages].filter((p) => p >= 0 && p < pageCount).sort((a, b) => a - b)
}

function Pagination({
  page,
  pageCount,
  total,
  onChange,
  rangeLabel,
}: {
  page: number
  pageCount: number
  total: number
  onChange: (p: number) => void
  rangeLabel: (from: number, to: number) => string
}) {
  const windowPages = pageWindow(page, pageCount)
  const from = page * PAGE_SIZE + 1
  const to = Math.min((page + 1) * PAGE_SIZE, total)
  const atStart = page === 0
  const atEnd = page >= pageCount - 1

  return (
    <YStack gap={8} ai="center" paddingVertical={8}>
      <XStack gap={6} ai="center" flexWrap="wrap" jc="center">
        <PageButton
          disabled={atStart}
          onPress={() => !atStart && onChange(page - 1)}
          aria-label="Previous page"
        >
          <ChevronLeft size={15} color={atStart ? tokens.textMuted : tokens.textSecondary} />
        </PageButton>

        {windowPages.map((p, i) => {
          const gap = i > 0 && p - windowPages[i - 1] > 1
          return (
            <Fragment key={p}>
              {gap ? (
                <Text fontSize={12} color={tokens.textMuted} paddingHorizontal={2}>
                  …
                </Text>
              ) : null}
              <PageButton active={p === page} onPress={() => onChange(p)}>
                <Text
                  fontSize={12}
                  fontWeight="600"
                  color={p === page ? tokens.text : tokens.textSecondary}
                >
                  {p + 1}
                </Text>
              </PageButton>
            </Fragment>
          )
        })}

        <PageButton
          disabled={atEnd}
          onPress={() => !atEnd && onChange(page + 1)}
          aria-label="Next page"
        >
          <ChevronRight size={15} color={atEnd ? tokens.textMuted : tokens.textSecondary} />
        </PageButton>
      </XStack>
      <Text fontSize={11} color={tokens.textMuted}>
        {rangeLabel(from, to)}
      </Text>
    </YStack>
  )
}

function PageButton({
  children,
  onPress,
  active,
  disabled,
  ...rest
}: {
  children: ReactNode
  onPress: () => void
  active?: boolean
  disabled?: boolean
  "aria-label"?: string
}) {
  return (
    <XStack
      minWidth={30}
      height={30}
      paddingHorizontal={8}
      ai="center"
      jc="center"
      borderRadius={7}
      borderWidth={1}
      borderColor={active ? tokens.borderHover : tokens.border}
      backgroundColor={active ? tokens.bgPress : tokens.bgInner}
      opacity={disabled ? 0.4 : 1}
      cursor={disabled ? "default" : "pointer"}
      hoverStyle={disabled ? {} : { backgroundColor: tokens.bgHover }}
      onPress={disabled ? undefined : onPress}
      {...({ role: "button", tabIndex: disabled ? -1 : 0, ...rest } as any)}
    >
      {children}
    </XStack>
  )
}
