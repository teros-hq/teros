/**
 * Session Trace Window (F2 / TER-643).
 *
 * Admin-only drill-down of a single turn: paste/enter a `sessionUsageId` (copied
 * from the Agent Usage sessions table, Sentry, or logs) and inspect the whole
 * turn — LLM calls + tool executions interleaved, message text, 👍/👎, and the
 * subagent tree — inside Teros instead of opening Latitude. Accepts an initial
 * `sessionUsageId` prop so any list can open it pre-loaded later.
 *
 * Reads `admin-api.agent-usage-session-detail` (requireSystemAdmin server-side);
 * FORBIDDEN shows the same Shield empty-state as the other admin windows.
 */

import { AlertTriangle, ListTree, RefreshCw, Search, Shield } from "@tamagui/lucide-icons"
import { useState } from "react"
import { Button, Input, Paragraph, ScrollView, Text, XStack, YStack } from "tamagui"
import { FullscreenLoader } from "../../components/ui"
import { getTerosClient } from "../../services/terosClientSingleton"
import { MonitoringHeader, type MonitoringTarget, scrollbarThin } from "../../components/monitoring"
import { useColors } from "../../components/mca/primitives/useColors"
import { useTilingStore } from "../../store/tilingStore"
import { SessionTraceView } from "./components/SessionTraceView"
import { useSessionTrace } from "./hooks/useSessionTrace"

export type SessionTraceWindowProps = { sessionUsageId?: string }

/**
 * The trace pill shows this ONE turn's SESSION status — not system health
 * (TER-669). Distinct vocabulary on purpose: a session is "Errored"/"Completed",
 * never "Critical"/"Healthy". Maps to the header's colour level for the tint.
 */
const SESSION_STATUS: Record<string, { level: "ok" | "degraded" | "error"; text: string }> = {
  completed: { level: "ok", text: "Completed" },
  running: { level: "ok", text: "Running" },
  errored: { level: "error", text: "Errored" },
  timed_out: { level: "error", text: "Timed out" },
  aborted: { level: "degraded", text: "Aborted" },
}

export function SessionTraceWindowContent({ sessionUsageId }: SessionTraceWindowProps) {
  const client = getTerosClient()
  const c = useColors()
  const openWindow = useTilingStore((s) => s.openWindow)
  const nav = (target: MonitoringTarget) => openWindow(target, {}, false)
  const [inputValue, setInputValue] = useState(sessionUsageId ?? "")
  const [submittedId, setSubmittedId] = useState<string | null>(sessionUsageId ?? null)
  const { trace, loading, error, notFound, reload } = useSessionTrace(client, submittedId)

  const submit = () => setSubmittedId(inputValue.trim() || null)
  const openChild = (id: string) => {
    setInputValue(id)
    setSubmittedId(id)
  }

  return (
    <YStack flex={1} backgroundColor="$background">
      <MonitoringHeader
        title="Session Trace"
        activeView="trace"
        statusLevel={trace ? (SESSION_STATUS[trace.session.status]?.level ?? "ok") : "ok"}
        statusText={trace ? (SESSION_STATUS[trace.session.status]?.text ?? trace.session.status) : undefined}
        onNavigate={nav}
      />
      <XStack
        ai="center"
        gap={10}
        paddingHorizontal={16}
        paddingVertical={12}
        borderBottomColor={c.borderStrong}
        borderBottomWidth={1}
        flexWrap="wrap"
      >
        <ListTree size={18} color="$blue10" />
        <Text fontSize={16} fontWeight="700" color="$gray12">
          Session Trace
        </Text>
        <XStack flex={1} minWidth={240} ai="center" gap={6}>
          <Input
            flex={1}
            size="$3"
            value={inputValue}
            onChangeText={setInputValue}
            onSubmitEditing={submit}
            placeholder="sessionUsageId (su_…)"
            aria-label="Session usage id"
          />
          <Button size="$3" icon={Search} onPress={submit}>
            Load
          </Button>
          {submittedId ? (
            <Button size="$3" icon={RefreshCw} disabled={loading} onPress={reload} aria-label="Refresh" />
          ) : null}
        </XStack>
      </XStack>

      {!submittedId ? (
        <YStack flex={1} ai="center" jc="center" gap={10} padding={32}>
          <ListTree size={36} color="$gray8" />
          <Text fontSize={14} color="$gray10">
            Enter a sessionUsageId to inspect a turn.
          </Text>
          <Paragraph fontSize={12} color="$gray9" textAlign="center" maxWidth={420}>
            Copy it from the Agent Usage sessions table, a Sentry event, or the backend logs.
          </Paragraph>
        </YStack>
      ) : loading ? (
        <FullscreenLoader />
      ) : error ? (
        <YStack flex={1} ai="center" jc="center" gap={12} padding={32}>
          {error === "Admin privileges required" ? (
            <Shield size={40} color="$orange10" />
          ) : (
            <AlertTriangle size={40} color="$red10" />
          )}
          <Text fontSize={15} fontWeight="600" color="$gray12">
            {error}
          </Text>
        </YStack>
      ) : notFound ? (
        <YStack flex={1} ai="center" jc="center" gap={10} padding={32}>
          <AlertTriangle size={36} color="$gray8" />
          <Text fontSize={14} color="$gray10">
            No session found for{" "}
            <Text fontFamily="$mono" color="$gray12">
              {submittedId}
            </Text>
            .
          </Text>
        </YStack>
      ) : trace ? (
        <ScrollView flex={1} style={scrollbarThin as never}>
          <YStack padding={16}>
            <SessionTraceView trace={trace} onOpenChild={openChild} />
          </YStack>
        </ScrollView>
      ) : null}
    </YStack>
  )
}
