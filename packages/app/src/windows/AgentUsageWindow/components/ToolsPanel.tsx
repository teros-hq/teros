/**
 * Tools panel — recent tool executions, newest first, drilling into the trace
 * of their session. Status uses a tool-specific vocabulary (permission_denied /
 * aborted aren't in the generic statusMeta, which would mis-color them green).
 */

import { View } from "react-native"
import { type Column, DataTable, fmtCount, SectionCard } from "../../../components/monitoring"
import { useColors } from "../../../components/mca/primitives/useColors"
import { Badge, type BadgeTone } from "../../../components/ui/ds/Badge"
import { Btn } from "../../../components/ui/ds/Buttons"
import { T } from "../../../components/ui/ds/Text"
import type { ToolExecutionSummary } from "../../../services/AdminApi"
import { formatBytes, formatDuration, relativeTime } from "../formatters"
import type { FilterDirectory } from "../hooks/useDirectory"
import { PanelNote } from "./panelBits"

const TOOL_STATUS: Record<ToolExecutionSummary["status"], { tone: BadgeTone; label: string }> = {
  success: { tone: "g", label: "success" },
  error: { tone: "r", label: "error" },
  running: { tone: "i", label: "running" },
  permission_denied: { tone: "a", label: "denied" },
  aborted: { tone: "muted", label: "aborted" },
}

export function ToolsPanel({
  tools,
  showInternalIds,
  onDrill,
  atFetchLimit = false,
  directory,
}: {
  tools: ToolExecutionSummary[]
  showInternalIds: boolean
  onDrill: (sessionUsageId: string) => void
  /** True when the page equals the fetch limit — more rows likely exist (N7). */
  atFetchLimit?: boolean
  /** Name maps for the Agent · User column (P6); rows fall back to raw ids. */
  directory?: FilterDirectory
}) {
  const c = useColors()
  if (tools.length === 0) {
    return <PanelNote>No tool executions in this range.</PanelNote>
  }

  const columns: Column<ToolExecutionSummary>[] = [
    {
      key: "when",
      header: "Started",
      width: 96,
      align: "left",
      color: () => c.text3,
      render: (t) => relativeTime(t.startedAt),
    },
    {
      key: "tool",
      header: "Tool / MCA",
      width: 220,
      flex: 1,
      align: "left",
      render: (t) => (
        <View style={{ minWidth: 0, flex: 1 }}>
          <T step="sm" numberOfLines={1}>
            {t.toolName}
          </T>
          {t.mcaId ? (
            <T step="code" tone="text3" numberOfLines={1}>
              {t.mcaId}
            </T>
          ) : null}
        </View>
      ),
    },
    {
      key: "who",
      header: "Agent · User",
      width: 170,
      align: "left",
      render: (t) => (
        <View style={{ minWidth: 0, flex: 1 }}>
          <T step="sm" tone="text2" numberOfLines={1}>
            {showInternalIds ? t.agentId : (directory?.agentIdToName.get(t.agentId) ?? t.agentId)}
          </T>
          <T step="12" tone="text3" numberOfLines={1}>
            {showInternalIds ? t.userId : (directory?.userIdToName.get(t.userId) ?? t.userId)}
          </T>
        </View>
      ),
    },
    {
      key: "status",
      header: "Status",
      width: 110,
      align: "left",
      render: (t) => {
        const m = TOOL_STATUS[t.status] ?? { tone: "muted" as BadgeTone, label: t.status }
        return (
          <Badge tone={m.tone} dot pill>
            {m.label}
          </Badge>
        )
      },
    },
    {
      key: "dur",
      header: "Duration",
      width: 92,
      align: "right",
      mono: true,
      render: (t) => formatDuration(t.durationMs),
    },
    {
      key: "in",
      header: "In",
      width: 78,
      align: "right",
      mono: true,
      color: () => c.text3,
      render: (t) => (t.inputSizeBytes == null ? "—" : formatBytes(t.inputSizeBytes)),
    },
    {
      key: "out",
      header: "Out",
      width: 78,
      align: "right",
      mono: true,
      color: () => c.text3,
      render: (t) => (t.outputSizeBytes == null ? "—" : formatBytes(t.outputSizeBytes)),
    },
  ]

  /** Expanded detail — the error (or an honest note), step, ids, drill to trace. */
  const renderDetail = (t: ToolExecutionSummary) => (
    <>
      {showInternalIds ? (
        <T step="code" tone="text3" selectable>
          {t.toolExecutionId} · session: {t.sessionUsageId}
        </T>
      ) : null}
      {t.errorMessage ? (
        <View
          style={{
            padding: 10,
            borderRadius: 10,
            backgroundColor: c.tint.r.bg,
            borderWidth: 1,
            borderColor: c.tint.r.bd,
          }}
        >
          <T step="code" color={c.tint.r.tx} selectable>
            {t.errorMessage}
          </T>
        </View>
      ) : (
        <T step="12" tone="text3">
          No error message captured — the tool exited with status "{t.status}".
        </T>
      )}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <T step="12" tone="text3">
          Step{" "}
          <T step="code" tone="text2">
            {t.stepIndex}.{t.toolCallIndex}
          </T>
        </T>
        <T step="12" tone="text3">
          In{" "}
          <T step="code" tone="text2">
            {formatBytes(t.inputSizeBytes ?? 0)}
          </T>
        </T>
        <T step="12" tone="text3">
          Out{" "}
          <T step="code" tone="text2">
            {formatBytes(t.outputSizeBytes ?? 0)}
          </T>
        </T>
        <Btn
          size="sm"
          variant="primary"
          iconRight="arrow-right"
          onPress={() => onDrill(t.sessionUsageId)}
          {...({ "aria-label": `Open session trace for ${t.sessionUsageId}` } as any)}
        >
          View trace
        </Btn>
      </View>
    </>
  )

  return (
    <SectionCard
      title="Tool executions"
      right={
        <T step="12" tone="text3">
          {atFetchLimit
            ? `${fmtCount(tools.length)} most recent (more exist)`
            : `${fmtCount(tools.length)} shown`}{" "}
          · tap a row for details
        </T>
      }
    >
      <DataTable
        columns={columns}
        rows={tools}
        rowKey={(t) => t.toolExecutionId}
        renderExpanded={renderDetail}
      />
    </SectionCard>
  )
}
