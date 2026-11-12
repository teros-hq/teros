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
 *
 * Drawn as the OS prototype's page: `Page` on the sheet → MonitoringHeader
 * (eyebrow + serif title + session status badge + view chips, with the id
 * field + Load / refresh as the controls) → the trace view.
 */

import { useState } from "react"
import { View } from "react-native"
import { FullscreenLoader } from "../../components/ui"
import { getTerosClient } from "../../services/terosClientSingleton"
import { MonitoringHeader, type MonitoringTarget } from "../../components/monitoring"
import { Btn, IconBtn } from "../../components/ui/ds/Buttons"
import { Field } from "../../components/ui/ds/Field"
import { EmptyState, Page } from "../../components/ui/ds/Page"
import { T } from "../../components/ui/ds/Text"
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
    <Page>
      <MonitoringHeader
        title="Session trace"
        activeView="trace"
        statusLevel={trace ? (SESSION_STATUS[trace.session.status]?.level ?? "ok") : "ok"}
        statusText={
          trace ? (SESSION_STATUS[trace.session.status]?.text ?? trace.session.status) : undefined
        }
        onNavigate={nav}
        controls={
          <>
            <Field
              mono
              icon="magnifying-glass"
              value={inputValue}
              onChangeText={setInputValue}
              onSubmitEditing={submit}
              placeholder="sessionUsageId (su_…)"
              containerStyle={{ minWidth: 260, flexGrow: 1 }}
              {...({ "aria-label": "Session usage id" } as any)}
            />
            <Btn size="md" variant="primary" icon="magnifying-glass" onPress={submit}>
              Load
            </Btn>
            {submittedId ? (
              <IconBtn
                icon="arrows-clockwise"
                disabled={loading}
                onPress={reload}
                title="Refresh"
                {...({ "aria-label": "Refresh" } as any)}
              />
            ) : null}
          </>
        }
      />

      {!submittedId ? (
        <EmptyState
          icon="tree-structure"
          title="Enter a sessionUsageId to inspect a turn."
          text="Copy it from the Agent Usage sessions table, a Sentry event, or the backend logs."
        />
      ) : loading ? (
        <View style={{ minHeight: 240 }}>
          <FullscreenLoader />
        </View>
      ) : error ? (
        <EmptyState
          icon={error === "Admin privileges required" ? "shield-check" : "warning"}
          title={error}
          text={
            error === "Admin privileges required"
              ? "This window is restricted to system admins (role ∈ admin | super)."
              : undefined
          }
        />
      ) : notFound ? (
        <EmptyState
          icon="warning"
          title="No session found"
          text={`No session found for ${submittedId}.`}
          action={
            <T step="code" tone="text3" selectable>
              {submittedId}
            </T>
          }
        />
      ) : trace ? (
        <SessionTraceView trace={trace} onOpenChild={openChild} />
      ) : null}
    </Page>
  )
}
