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
 */

import { AlertTriangle, RefreshCw, Search, Shield, Zap } from "@tamagui/lucide-icons"
import { useMemo, useState } from "react"
import { Button, Input, Paragraph, ScrollView, Spinner, Text, XStack, YStack } from "tamagui"
import type { LatitudeSignalsListParams } from "../../services/AdminApi"
import { getTerosClient } from "../../services/terosClientSingleton"
import { SignalsList } from "./components/SignalsList"
import { type SignalsStatus, useLatitudeSignals } from "./hooks/useLatitudeSignals"

type Lifecycle = "active" | "archived" | "all"
type Sort = "lastSeen" | "occurrences" | "state"

const SORT_LABELS: Record<Sort, string> = {
  lastSeen: "Recent",
  occurrences: "Frequent",
  state: "Lifecycle",
}

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

function SegButton({
  active,
  label,
  onPress,
}: {
  active: boolean
  label: string
  onPress: () => void
}) {
  return (
    <Button
      size="$2"
      chromeless={!active}
      theme={active ? "blue" : undefined}
      onPress={onPress}
      aria-label={label}
    >
      {label}
    </Button>
  )
}

interface ToolbarProps {
  lifecycle: Lifecycle
  onLifecycle: (l: Lifecycle) => void
  sort: Sort
  onSort: (s: Sort) => void
  queryInput: string
  onQueryInput: (v: string) => void
  onSearch: () => void
  onRefresh: () => void
  loading: boolean
}

function SignalsToolbar(props: ToolbarProps) {
  const {
    lifecycle,
    onLifecycle,
    sort,
    onSort,
    queryInput,
    onQueryInput,
    onSearch,
    onRefresh,
    loading,
  } = props
  return (
    <YStack
      gap={10}
      paddingHorizontal={16}
      paddingVertical={12}
      borderBottomColor="rgba(255,255,255,0.08)"
      borderBottomWidth={1}
    >
      <XStack ai="center" gap={10} flexWrap="wrap">
        <Zap size={18} color="$yellow10" />
        <Text fontSize={16} fontWeight="700" color="$gray12">
          Latitude Signals
        </Text>
        <XStack flex={1} minWidth={200} ai="center" gap={6}>
          <Input
            flex={1}
            size="$3"
            value={queryInput}
            onChangeText={onQueryInput}
            onSubmitEditing={onSearch}
            placeholder="Search signals…"
            aria-label="Search signals"
          />
          <Button size="$3" icon={Search} onPress={onSearch}>
            Search
          </Button>
          <Button
            size="$3"
            icon={RefreshCw}
            disabled={loading}
            onPress={onRefresh}
            aria-label="Refresh"
          />
        </XStack>
      </XStack>

      <XStack ai="center" gap={14} flexWrap="wrap">
        <XStack ai="center" gap={4}>
          <SegButton
            active={lifecycle === "active"}
            label="Active"
            onPress={() => onLifecycle("active")}
          />
          <SegButton
            active={lifecycle === "archived"}
            label="Archived"
            onPress={() => onLifecycle("archived")}
          />
          <SegButton active={lifecycle === "all"} label="All" onPress={() => onLifecycle("all")} />
        </XStack>
        <XStack ai="center" gap={4}>
          {(Object.keys(SORT_LABELS) as Sort[]).map((s) => (
            <SegButton
              key={s}
              active={sort === s}
              label={SORT_LABELS[s]}
              onPress={() => onSort(s)}
            />
          ))}
        </XStack>
      </XStack>
    </YStack>
  )
}

function CenteredState({ children }: { children: React.ReactNode }) {
  return (
    <YStack flex={1} ai="center" jc="center" gap={10} padding={32}>
      {children}
    </YStack>
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
  if (loading) {
    return (
      <YStack flex={1} ai="center" jc="center" padding={32}>
        <Spinner size="large" color="$blue10" />
      </YStack>
    )
  }
  if (error) {
    return (
      <CenteredState>
        {error === "Admin privileges required" ? (
          <Shield size={40} color="$orange10" />
        ) : (
          <AlertTriangle size={40} color="$red10" />
        )}
        <Text fontSize={15} fontWeight="600" color="$gray12">
          {error}
        </Text>
      </CenteredState>
    )
  }
  if (status && status !== "ok") {
    return (
      <CenteredState>
        <AlertTriangle size={36} color="$gray8" />
        <Text fontSize={15} fontWeight="600" color="$gray12">
          {STATUS_EMPTY[status].title}
        </Text>
        <Paragraph fontSize={12} color="$gray9" textAlign="center" maxWidth={440}>
          {STATUS_EMPTY[status].hint}
        </Paragraph>
      </CenteredState>
    )
  }
  if (signals.length === 0) {
    return (
      <CenteredState>
        <Zap size={36} color="$gray8" />
        <Text fontSize={14} color="$gray10">
          No signals in this window.
        </Text>
        <Paragraph fontSize={12} color="$gray9" textAlign="center" maxWidth={420}>
          Latitude clusters failures from exported traces and 👎 / tool-error scores. None have
          surfaced for the current filters.
        </Paragraph>
      </CenteredState>
    )
  }
  return (
    <ScrollView flex={1}>
      <YStack padding={16} gap={12}>
        <SignalsList signals={signals} />
        {hasMore ? (
          <Button
            size="$3"
            chromeless
            disabled={loadingMore}
            onPress={loadMore}
            aria-label="Load more signals"
          >
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        ) : null}
      </YStack>
    </ScrollView>
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

  return (
    <YStack flex={1} backgroundColor="$background">
      <SignalsToolbar
        lifecycle={lifecycle}
        onLifecycle={setLifecycle}
        sort={sort}
        onSort={setSort}
        queryInput={queryInput}
        onQueryInput={setQueryInput}
        onSearch={() => setQuery(queryInput.trim())}
        onRefresh={state.reload}
        loading={state.loading}
      />
      <SignalsBody {...state} />
    </YStack>
  )
}
