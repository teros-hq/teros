/**
 * Users Window Content
 *
 * Admin Users panel in the OS prototype vocabulary (design-testing, Oct 2026):
 * - `Page` + `PageHead` (eyebrow · serif title · lead) → a `Stats` row of KPI
 *   tiles (the quota ones are clickable and jump to the Cuota filter) → a
 *   filter row (search `Field`, `ChipBtn` groups for Estado / Rol, `Select`
 *   pickers for Plan / Cuota) → the users as `LGroup`/`LRow` rows with a
 *   codenote header → numbered pill pagination.
 * - A per-user DETAIL drill-in (`UserDetailView`).
 * - Server-side search + filters + pagination, so the panel scales past the old
 *   100-user cap.
 *
 * Layer separation: the backend returns DATA (ids + resolved names + a `pct`);
 * this file composes the UI. All colours come from `useColors()`.
 */

import { Fragment, type ReactNode, useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { ActivityIndicator, View } from "react-native"
import { Avatar } from "../../components/Avatar"
import { useColors } from "../../components/mca/primitives/useColors"
import {
  Badge,
  Btn,
  Card,
  ChipBtn,
  EmptyState,
  Field,
  IconBtn,
  LGroup,
  LRow,
  Page,
  Ph,
  Stat,
  Stats,
  T,
} from "../../components/ui/ds"
import type { UsageFilter, UserRole, UserStatus, UserSummary } from "../../services/AdminApi"
import { getTerosClient } from "../../services/terosClientSingleton"
import { UserDetailView } from "./detail/UserDetailView"
import { Select } from "./Select"
import { UsersHeader } from "./UsersHeader"
import {
  formatRelative,
  hoursTone,
  hoursUsage,
  planBadge,
  planTone,
  roleTone,
  USAGE_FILTER_OPTIONS,
  userStatusMeta,
  userStatusTone,
} from "./usersModel"

const PAGE_SIZE = 50

type StatusFilter = UserStatus | "all"
type RoleFilter = UserRole | "all"
type UsageFilterAll = UsageFilter | "all"
type ViewMode = { mode: "list" } | { mode: "detail"; userId: string }

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

// Column widths of the list (the user column takes the rest).
const COL = { role: 84, plan: 110, hours: 150, last: 84, caret: 16 }
const ROW_GAP = 14
// Below these measured list widths the lower-priority columns are dropped
// (whatever they show is still on the detail view).
const HIDE_LAST_BELOW = 640
const HIDE_PLAN_BELOW = 520

export function UsersWindowContent(_props: UsersWindowContentProps) {
  const client = getTerosClient()
  const { t } = useTranslation()
  const c = useColors()

  const [view, setView] = useState<ViewMode>({ mode: "list" })
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

  // Measured width of the list → responsive column set (never a horizontal scrollbar).
  const [listWidth, setListWidth] = useState(0)
  const showLast = listWidth === 0 || listWidth >= HIDE_LAST_BELOW
  const showPlan = listWidth === 0 || listWidth >= HIDE_PLAN_BELOW

  // ── FORBIDDEN: keep the full-window block (admin/super only) ──────────────────
  if (forbidden) {
    return (
      <Page>
        <EmptyState
          icon="shield-check"
          title={t("errors.users.adminRequired")}
          text={t("errors.users.privilegesRequired")}
        />
      </Page>
    )
  }

  // ── DETAIL: the fragmented per-user drill-in ──────────────────────────────────
  if (view.mode === "detail") {
    const detailUser =
      selectedUser?.userId === view.userId
        ? selectedUser
        : users.find((u) => u.userId === view.userId)
    if (!detailUser) {
      // The row left the current page (filters/page changed) — offer a way back.
      return (
        <Page>
          <UsersHeader
            crumbs={[
              { label: t("windows.usersPanel.title"), onPress: () => setView({ mode: "list" }) },
              { label: t("windows.usersPanel.detail.thisUser") },
            ]}
          />
        </Page>
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

  return (
    <Page>
      <UsersHeader
        crumbs={[{ label: t("windows.usersPanel.title") }]}
        statusText={
          summary ? t("windows.usersPanel.statusUsers", { count: summary.total }) : undefined
        }
      />

      {summary ? (
        <Stats cols={5}>
          <Stat v={summary.total} label={t("windows.usersPanel.kpi.total")} />
          <Stat
            v={summary.active}
            label={t("windows.usersPanel.kpi.active")}
            sub={t("users.kpi.activeSub", {
              defaultValue: "de {{total}} con acceso",
              total: summary.total,
            })}
          />
          <Stat v={summary.admins} label={t("windows.usersPanel.kpi.admins")} />
          <KpiStat
            testID="kpi-near"
            active={usageFilter === "near"}
            onPress={() => changeUsage("near")}
            v={summary.nearLimit}
            label={t("windows.usersPanel.kpi.nearLimit")}
            sub={t("users.kpi.filterHint", { defaultValue: "pulsa para filtrar" })}
            tone={summary.nearLimit > 0 ? "a" : undefined}
          />
          <KpiStat
            testID="kpi-exhausted"
            active={usageFilter === "exhausted"}
            onPress={() => changeUsage("exhausted")}
            v={summary.exhausted}
            label={t("windows.usersPanel.kpi.exhausted")}
            sub={t("users.kpi.filterHint", { defaultValue: "pulsa para filtrar" })}
            tone={summary.exhausted > 0 ? "r" : undefined}
          />
        </Stats>
      ) : null}

      {/* Filter row */}
      <View style={{ marginTop: 20, gap: 12, zIndex: 10 }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "flex-end", gap: 14 }}>
          <View style={{ flexGrow: 1, flexBasis: 240, minWidth: 200 }}>
            <Field
              testID="users-search"
              icon="magnifying-glass"
              value={searchInput}
              onChangeText={setSearchInput}
              placeholder={t("windows.usersPanel.searchPlaceholder")}
              autoCapitalize="none"
              autoCorrect={false}
              right={
                searchInput.length > 0 ? (
                  <IconBtn
                    icon="x"
                    plain
                    sm
                    onPress={() => setSearchInput("")}
                    aria-label={t("windows.usersPanel.clear")}
                    style={{ marginRight: -8 }}
                  />
                ) : undefined
              }
            />
          </View>
          <FilterGroup label={t("windows.usersPanel.filters.status")}>
            {STATUS_KEYS.map((k) => (
              <ChipBtn key={k} on={statusFilter === k} onPress={() => changeStatus(k)}>
                {k === "all" ? t("windows.usersPanel.status.all") : t(userStatusMeta(k).labelKey)}
              </ChipBtn>
            ))}
          </FilterGroup>
          <FilterGroup label={t("windows.usersPanel.filters.role")}>
            {ROLE_KEYS.map((k) => (
              <ChipBtn key={k} on={roleFilter === k} onPress={() => changeRole(k)}>
                {t(`windows.usersPanel.role.${k}`)}
              </ChipBtn>
            ))}
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
        </View>

        {activeChips.length > 0 ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
            {activeChips.map((chip) => (
              <FilterChip
                key={chip.key}
                label={chip.label}
                onRemove={chip.onRemove}
                removeLabel={t("windows.usersPanel.clear")}
              />
            ))}
            <Btn variant="ghost" size="sm" onPress={resetFilters}>
              {t("windows.usersPanel.clear")}
            </Btn>
          </View>
        ) : null}
      </View>

      <View style={{ marginTop: 16, gap: 12 }}>
        {error ? (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              paddingHorizontal: 14,
              paddingVertical: 8,
              borderRadius: 12,
              backgroundColor: c.tint.r.bg,
              borderWidth: 1,
              borderColor: c.tint.r.bd,
            }}
          >
            <T step="sm" color={c.tint.r.tx} numberOfLines={2} style={{ flex: 1 }}>
              {error}
            </T>
            <Btn variant="ghost" size="sm" icon="arrows-clockwise" onPress={() => loadUsers()}>
              {t("windows.usersPanel.retry")}
            </Btn>
            <IconBtn
              icon="x"
              plain
              sm
              onPress={() => setError(null)}
              aria-label={t("windows.usersPanel.clear")}
            />
          </View>
        ) : null}

        {loading ? (
          <View style={{ padding: 32, alignItems: "center", gap: 10 }}>
            <ActivityIndicator color={c.accent} />
            <T step="sm" tone="text3">
              {t("common.loading")}
            </T>
          </View>
        ) : users.length === 0 ? (
          <EmptyState
            icon="users-three"
            title={
              hasFilters
                ? t("windows.usersPanel.empty.noMatch")
                : t("windows.usersPanel.empty.none")
            }
            text={hasFilters ? t("windows.usersPanel.empty.clearHint") : undefined}
            action={
              hasFilters ? (
                <Btn variant="sec" size="sm" onPress={resetFilters}>
                  {t("windows.usersPanel.clear")}
                </Btn>
              ) : undefined
            }
          />
        ) : (
          <View onLayout={(e) => setListWidth(e.nativeEvent.layout.width)} style={{ minWidth: 0 }}>
            <ListHeader showPlan={showPlan} showLast={showLast} />
            <LGroup>
              {users.map((u) => (
                <UserRow
                  key={u.userId}
                  user={u}
                  showPlan={showPlan}
                  showLast={showLast}
                  onPress={() => openDetail(u)}
                />
              ))}
            </LGroup>
          </View>
        )}

        {!loading && total > PAGE_SIZE ? (
          <Pagination
            page={page}
            pageCount={pageCount}
            total={total}
            onChange={setPage}
            rangeLabel={(from, to) => t("windows.usersPanel.pagination.range", { from, to, total })}
          />
        ) : null}
      </View>
    </Page>
  )
}

// ─── List rows ──────────────────────────────────────────────────────────────────

function ListHeader({ showPlan, showLast }: { showPlan: boolean; showLast: boolean }) {
  const { t } = useTranslation()
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: ROW_GAP,
        paddingHorizontal: 16,
        paddingBottom: 8,
      }}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <T step="codenote" tone="text3">
          {t("windows.usersPanel.columns.user")}
        </T>
      </View>
      <View style={{ width: COL.role }}>
        <T step="codenote" tone="text3">
          {t("windows.usersPanel.columns.role")}
        </T>
      </View>
      {showPlan ? (
        <View style={{ width: COL.plan }}>
          <T step="codenote" tone="text3">
            {t("windows.usersPanel.columns.plan")}
          </T>
        </View>
      ) : null}
      <View style={{ width: COL.hours }}>
        <T step="codenote" tone="text3">
          {t("windows.usersPanel.columns.hours")}
        </T>
      </View>
      {showLast ? (
        <View style={{ width: COL.last, alignItems: "flex-end" }}>
          <T step="codenote" tone="text3" numberOfLines={1}>
            {t("windows.usersPanel.columns.lastAccess")}
          </T>
        </View>
      ) : null}
      <View style={{ width: COL.caret }} />
    </View>
  )
}

function UserRow({
  user: u,
  showPlan,
  showLast,
  onPress,
}: {
  user: UserSummary
  showPlan: boolean
  showLast: boolean
  onPress: () => void
}) {
  const { t } = useTranslation()
  const c = useColors()
  const name = u.profile.displayName ?? u.profile.email ?? "—"
  const status = userStatusMeta(u.status)
  const pb = u.billing ? planBadge(u.billing.planId, u.billing.planName) : null

  return (
    <LRow onPress={onPress} gap={ROW_GAP} accessibilityRole="button">
      <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Avatar name={name} imageUrl={u.profile.avatarUrl} size={28} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0 }}>
            <T step="sm" ellipsis style={{ flexShrink: 1 }}>
              {name}
            </T>
            {u.status !== "active" ? (
              <Badge tone={userStatusTone(u.status)} dot sm>
                {t(status.labelKey)}
              </Badge>
            ) : null}
          </View>
          {u.profile.email ? (
            <T step="12" tone="text3" ellipsis>
              {u.profile.email}
            </T>
          ) : null}
        </View>
      </View>
      <View style={{ width: COL.role }}>
        <Badge tone={roleTone(u.role)}>{t(`windows.usersPanel.role.${u.role}`)}</Badge>
      </View>
      {showPlan ? (
        <View style={{ width: COL.plan }}>
          {pb ? (
            <Badge tone={planTone(u.billing!.planId, u.billing!.planName)} pill>
              {pb.label}
            </Badge>
          ) : (
            <T step="code" tone="text3">
              —
            </T>
          )}
        </View>
      ) : null}
      <View style={{ width: COL.hours }}>
        <HoursBar billing={u.billing} />
      </View>
      {showLast ? (
        <View style={{ width: COL.last, alignItems: "flex-end" }}>
          <T step="code" tone="text3">
            {formatRelative(u.lastLoginAt)}
          </T>
        </View>
      ) : null}
      <View style={{ width: COL.caret, alignItems: "flex-end" }}>
        <Ph name="caret-right" size={14} color={c.text3} />
      </View>
    </LRow>
  )
}

/** Thin violet usage bar + mono percentage (amber from 80%, red at the limit). */
function HoursBar({ billing }: { billing: UserSummary["billing"] }) {
  const c = useColors()
  const h = hoursUsage(billing)
  const tone = hoursTone(h.pct, h.unmetered)
  if (tone === "neutral") {
    return (
      <T step="code" tone="text3">
        {h.label}
      </T>
    )
  }
  const pct = Math.max(0, Math.min(h.pct ?? 0, 1))
  const fill = tone === "i" ? c.accent : c.tint[tone].tx
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <View
        style={{
          flex: 1,
          height: 6,
          borderRadius: 3,
          backgroundColor: c.wash2,
          overflow: "hidden",
        }}
        accessibilityLabel={h.label}
      >
        <View
          style={{ width: `${pct * 100}%`, height: "100%", borderRadius: 3, backgroundColor: fill }}
        />
      </View>
      <T
        step="code"
        color={tone === "i" ? c.text3 : fill}
        style={{ width: 40, textAlign: "right" }}
      >
        {`${Math.round((h.pct ?? 0) * 100)} %`}
      </T>
    </View>
  )
}

// ─── Local UI helpers ───────────────────────────────────────────────────────────

function FilterGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={{ gap: 6, minWidth: 0 }}>
      <T step="codenote" tone="text3">
        {label}
      </T>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>{children}</View>
    </View>
  )
}

/** A clickable `Stat` tile (same content), used by the quota KPIs that jump to a filter. */
function KpiStat({
  testID,
  active,
  onPress,
  v,
  label,
  sub,
  tone,
}: {
  testID: string
  active: boolean
  onPress: () => void
  v: number
  label: string
  sub: string
  tone?: "a" | "r"
}) {
  const c = useColors()
  const valueColor = active ? c.accent : tone ? c.tint[tone].tx : c.text
  return (
    <Card
      pad={20}
      hov
      accent
      onPress={onPress}
      testID={testID}
      style={{ minHeight: 100, borderColor: active ? c.borderAccentStrong : "transparent" }}
      {...({ role: "button", "aria-pressed": active } as Record<string, unknown>)}
    >
      <T step="sm" tone="text2">
        {label}
      </T>
      <T step="2xl" color={valueColor} style={{ marginTop: 10, marginBottom: 6 }}>
        {String(v)}
      </T>
      <T step="sm" color={active ? c.accent : c.text3}>
        {sub}
      </T>
    </Card>
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
  const c = useColors()
  return (
    <ChipBtn on onPress={onRemove} aria-label={`${removeLabel}: ${label}`}>
      <T step="12" color={c.accent} numberOfLines={1}>
        {label}
      </T>
      <Ph name="x" size={11} color={c.accent} />
    </ChipBtn>
  )
}

// ─── Pagination ─────────────────────────────────────────────────────────────────

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
    <View style={{ alignItems: "center", gap: 8, paddingVertical: 8 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 4,
          flexWrap: "wrap",
        }}
      >
        <IconBtn
          icon="caret-left"
          plain
          sm
          disabled={atStart}
          onPress={() => !atStart && onChange(page - 1)}
          aria-label="Previous page"
        />
        {windowPages.map((p, i) => {
          const gap = i > 0 && p - windowPages[i - 1] > 1
          return (
            <Fragment key={p}>
              {gap ? (
                <T step="code" tone="text3" style={{ paddingHorizontal: 2 }}>
                  …
                </T>
              ) : null}
              <Btn
                variant={p === page ? "ink" : "ghost"}
                size="sm"
                onPress={() => onChange(p)}
                {...({ "aria-current": p === page ? "page" : undefined } as Record<
                  string,
                  unknown
                >)}
              >
                {String(p + 1)}
              </Btn>
            </Fragment>
          )
        })}
        <IconBtn
          icon="caret-right"
          plain
          sm
          disabled={atEnd}
          onPress={() => !atEnd && onChange(page + 1)}
          aria-label="Next page"
        />
      </View>
      <T step="codenote" tone="text3">
        {rangeLabel(from, to)}
      </T>
    </View>
  )
}
