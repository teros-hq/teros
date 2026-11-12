/**
 * Latitude Signals Window (F4 · C2).
 *
 * Admin-only, read-only dashboard over Latitude's clustered-failure `signals` —
 * the named groups Latitude derives from Teros' exported traces (F3a) and scores
 * (C0). Browse them inside Teros; each row deep-links into Latitude. Reads
 * `admin-api.latitude-signals-list` (requireSystemAdmin server-side).
 *
 * The dashboard is a disposable read: when Latitude is unconfigured / unreachable /
 * rejects the token, the backend says so via `status` and this renders the matching
 * empty state — the rest of the product is unaffected.
 *
 * Drawn as the OS prototype's page: `Page` → `PageHead` (eyebrow + serif title +
 * search / refresh actions) → lifecycle PTabs + sort chips → Stat tiles → the
 * signals `LGroup`.
 */

import { useMemo, useState } from "react"
import { ActivityIndicator, View } from "react-native"
import type { LatitudeSignalsListParams } from "../../services/AdminApi"
import { getTerosClient } from "../../services/terosClientSingleton"
import { useColors } from "../../components/mca/primitives/useColors"
import { Btn, ChipBtn, IconBtn } from "../../components/ui/ds/Buttons"
import { Stat, Stats } from "../../components/ui/ds/Card"
import { Field } from "../../components/ui/ds/Field"
import { EmptyState, Page, PageHead } from "../../components/ui/ds/Page"
import { PTabs } from "../../components/ui/ds/Tabs"
import { T } from "../../components/ui/ds/Text"
import { SignalsList } from "./components/SignalsList"
import { formatCount, signalLevel } from "./format"
import { type SignalsStatus, useLatitudeSignals } from "./hooks/useLatitudeSignals"

type Lifecycle = "active" | "archived" | "all"
type Sort = "lastSeen" | "occurrences" | "state"

const SORT_LABELS: Record<Sort, string> = {
  lastSeen: "Recent",
  occurrences: "Frequent",
  state: "Lifecycle",
}

const LIFECYCLE_TABS: { key: Lifecycle; label: string; icon: string }[] = [
  { key: "active", label: "Active", icon: "pulse" },
  { key: "archived", label: "Archived", icon: "archive" },
  { key: "all", label: "All", icon: "list" },
]

const STATUS_EMPTY: Record<Exclude<SignalsStatus, "ok">, { title: string; hint: string }> = {
  unconfigured: {
    title: "Latitude isn't configured",
    hint: "Set LATITUDE_API_URL, LATITUDE_EXPORT_TOKEN and LATITUDE_EXPORT_PROJECT to browse signals here.",
  },
  unauthorized: {
    title: "Latitude rejected the token",
    hint: "The configured LATITUDE_EXPORT_TOKEN was refused. Check the org API key.",
  },
  unreachable: {
    title: "Latitude is unreachable",
    hint: "The signals API didn't answer. Signals are best-effort — the rest of Teros is unaffected.",
  },
}

interface ToolbarProps {
  lifecycle: Lifecycle
  onLifecycle: (l: Lifecycle) => void
  sort: Sort
  onSort: (s: Sort) => void
}

function SignalsToolbar({ lifecycle, onLifecycle, sort, onSort }: ToolbarProps) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 14,
        flexWrap: "wrap",
        justifyContent: "space-between",
      }}
    >
      <PTabs items={LIFECYCLE_TABS} value={lifecycle} onChange={onLifecycle} />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <T step="codenote" tone="text3" style={{ marginRight: 4 }}>
          Sort
        </T>
        {(Object.keys(SORT_LABELS) as Sort[]).map((s) => (
          <ChipBtn
            key={s}
            on={sort === s}
            onPress={() => onSort(s)}
            {...({ "aria-label": SORT_LABELS[s] } as any)}
          >
            {SORT_LABELS[s]}
          </ChipBtn>
        ))}
      </View>
    </View>
  )
}

type BodyProps = ReturnType<typeof useLatitudeSignals>

function SignalsBody({
  status,
  signals,
  loading,
  loadingMore,
  error,
  hasMore,
  loadMore,
}: BodyProps) {
  const c = useColors()
  const stats = useMemo(() => {
    const escalating = signals.filter((s) => signalLevel(s.states, s.muted) === "bad").length
    const fresh = signals.filter((s) => !s.muted && s.states.includes("new")).length
    const occurrences = signals.reduce((a, s) => a + (s.occurrences ?? 0), 0)
    return { escalating, fresh, occurrences }
  }, [signals])

  if (loading) {
    return (
      <View style={{ alignItems: "center", justifyContent: "center", padding: 48 }}>
        <ActivityIndicator size="large" color={c.accent} />
      </View>
    )
  }
  if (error) {
    const forbidden = error === "Admin privileges required"
    return (
      <EmptyState
        icon={forbidden ? "shield-check" : "warning"}
        title={error}
        text={
          forbidden
            ? "This window is restricted to system admins (role ∈ admin | super)."
            : undefined
        }
      />
    )
  }
  if (status && status !== "ok") {
    return (
      <EmptyState
        icon="plugs"
        title={STATUS_EMPTY[status].title}
        text={STATUS_EMPTY[status].hint}
      />
    )
  }
  if (signals.length === 0) {
    return (
      <EmptyState
        icon="broadcast"
        title="No signals in this window."
        text="Latitude clusters failures from exported traces and 👎 / tool-error scores. None have surfaced for the current filters."
      />
    )
  }
  return (
    <View style={{ gap: 16 }}>
      <Stats cols={4}>
        <Stat
          label="Signals"
          v={formatCount(signals.length)}
          sub={hasMore ? "loaded · more available" : "loaded"}
        />
        <Stat
          label="Escalating"
          v={formatCount(stats.escalating)}
          sub="getting worse"
          accent={stats.escalating > 0}
        />
        <Stat label="New" v={formatCount(stats.fresh)} sub="first seen recently" />
        <Stat label="Occurrences" v={formatCount(stats.occurrences)} sub="across loaded signals" />
      </Stats>
      <SignalsList signals={signals} />
      {hasMore ? (
        <View style={{ flexDirection: "row", justifyContent: "center" }}>
          <Btn
            variant="sec"
            size="md"
            loading={loadingMore}
            disabled={loadingMore}
            onPress={loadMore}
            {...({ "aria-label": "Load more signals" } as any)}
          >
            {loadingMore ? "Loading…" : "Load more"}
          </Btn>
        </View>
      ) : null}
    </View>
  )
}

export function LatitudeSignalsWindowContent() {
  const client = getTerosClient()
  const [lifecycle, setLifecycle] = useState<Lifecycle>("active")
  const [sort, setSort] = useState<Sort>("lastSeen")
  const [queryInput, setQueryInput] = useState("")
  const [query, setQuery] = useState("")

  const params = useMemo<LatitudeSignalsListParams>(
    () => ({
      ...(lifecycle === "all" ? {} : { lifecycleGroup: lifecycle }),
      sortBy: sort,
      sortDirection: "desc",
      ...(query ? { query } : {}),
      limit: 50,
    }),
    [lifecycle, sort, query],
  )

  const state = useLatitudeSignals(client, params)
  const search = () => setQuery(queryInput.trim())

  return (
    <Page>
      <PageHead
        eyebrow="Monitorización"
        title="Latitude Signals"
        lead="Clustered failures Latitude derives from exported traces — each row opens in Latitude."
        actions={
          <>
            <Field
              icon="magnifying-glass"
              value={queryInput}
              onChangeText={setQueryInput}
              onSubmitEditing={search}
              placeholder="Search signals…"
              containerStyle={{ minWidth: 220 }}
              {...({ "aria-label": "Search signals" } as any)}
            />
            <Btn variant="primary" size="md" icon="magnifying-glass" onPress={search}>
              Search
            </Btn>
            <IconBtn
              icon="arrows-clockwise"
              disabled={state.loading}
              onPress={state.reload}
              title="Refresh"
              {...({ "aria-label": "Refresh" } as any)}
            />
          </>
        }
      />
      <View style={{ gap: 16 }}>
        <SignalsToolbar
          lifecycle={lifecycle}
          onLifecycle={setLifecycle}
          sort={sort}
          onSort={setSort}
        />
        <SignalsBody {...state} />
      </View>
    </Page>
  )
}
