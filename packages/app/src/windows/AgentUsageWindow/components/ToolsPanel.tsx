/**
 * Tools panel — recent tool executions, newest first, drilling into the trace
 * of their session. Status uses a tool-specific vocabulary (permission_denied /
 * aborted aren't in the generic statusMeta, which would mis-color them green).
 */

import { Button, Text, XStack, YStack } from "tamagui"
import { type Column, DataTable, fmtCount, SectionCard, tokens } from "../../../components/monitoring"
import { colors as semanticColors } from "../../../components/mca/primitives/colors"
import type { ToolExecutionSummary } from "../../../services/AdminApi"
import { formatBytes, formatDuration, relativeTime } from "../formatters"
import type { FilterDirectory } from "../hooks/useDirectory"
import { PanelNote } from "./panelBits"

const TOOL_STATUS: Record<ToolExecutionSummary["status"], { color: string; label: string }> = {
  success: { color: tokens.success, label: "success" },
  error: { color: tokens.error, label: "error" },
  running: { color: tokens.accent, label: "running" },
  permission_denied: { color: tokens.warning, label: "denied" },
  aborted: { color: tokens.textTertiary, label: "aborted" },
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
  if (tools.length === 0) {
    return <PanelNote>No tool executions in this range.</PanelNote>
  }

  const columns: Column<ToolExecutionSummary>[] = [
    { key: "when", header: "Started", width: 96, align: "left", color: () => tokens.textTertiary, render: (t) => relativeTime(t.startedAt) },
    {
      key: "tool",
      header: "Tool / MCA",
      width: 220,
      flex: 1,
      align: "left",
      render: (t) => (
        <YStack minWidth={0} flex={1}>
          <Text fontSize={13} fontWeight="600" color={tokens.text} numberOfLines={1}>
            {t.toolName}
          </Text>
          {t.mcaId ? (
            <Text fontSize={11} fontFamily="$mono" color={tokens.textTertiary} numberOfLines={1}>
              {t.mcaId}
            </Text>
          ) : null}
        </YStack>
      ),
    },
    {
      key: "who",
      header: "Agent · User",
      width: 170,
      align: "left",
      render: (t) => (
        <YStack minWidth={0} flex={1}>
          <Text fontSize={12} fontWeight="560" color={tokens.textSecondary} numberOfLines={1}>
            {showInternalIds ? t.agentId : (directory?.agentIdToName.get(t.agentId) ?? t.agentId)}
          </Text>
          <Text fontSize={11} color={tokens.textTertiary} numberOfLines={1}>
            {showInternalIds ? t.userId : (directory?.userIdToName.get(t.userId) ?? t.userId)}
          </Text>
        </YStack>
      ),
    },
    {
      key: "status",
      header: "Status",
      width: 110,
      align: "left",
      render: (t) => {
        const m = TOOL_STATUS[t.status] ?? { color: tokens.textTertiary, label: t.status }
        return (
          <XStack ai="center" gap={6}>
            <YStack width={9} height={9} borderRadius={9999} backgroundColor={m.color} />
            <Text fontSize={12} fontWeight="560" color={m.color} numberOfLines={1}>
              {m.label}
            </Text>
          </XStack>
        )
      },
    },
    { key: "dur", header: "Duration", width: 92, align: "right", mono: true, render: (t) => formatDuration(t.durationMs) },
    { key: "in", header: "In", width: 78, align: "right", mono: true, color: () => tokens.textTertiary, render: (t) => (t.inputSizeBytes == null ? "—" : formatBytes(t.inputSizeBytes)) },
    { key: "out", header: "Out", width: 78, align: "right", mono: true, color: () => tokens.textTertiary, render: (t) => (t.outputSizeBytes == null ? "—" : formatBytes(t.outputSizeBytes)) },
  ]

  /** Expanded detail — the error (or an honest note), step, ids, drill to trace. */
  const renderDetail = (t: ToolExecutionSummary) => (
    <>
      {showInternalIds ? (
        <Text fontSize={11} fontFamily="$mono" color={tokens.textTertiary} selectable>
          {t.toolExecutionId} · session: {t.sessionUsageId}
        </Text>
      ) : null}
      {t.errorMessage ? (
        <Text
          fontSize={12}
          fontFamily="$mono"
          color={tokens.error}
          padding={8}
          backgroundColor="rgba(239,68,68,0.06)"
          // @todo nira - 2026.07.17 : monitoring tokens don't expose a semantic error-bg; using inline rgba until monitoring colors are migrated to useColors()
          borderRadius={8}
          selectable
        >
          {t.errorMessage}
        </Text>
      ) : (
        <Text fontSize={11} color={tokens.textTertiary}>
          No error message captured — the tool exited with status "{t.status}".
        </Text>
      )}
      <XStack ai="center" gap={16} flexWrap="wrap">
        <Text fontSize={11} color={tokens.textTertiary}>
          Step <Text color={tokens.textSecondary}>{t.stepIndex}.{t.toolCallIndex}</Text>
        </Text>
        <Text fontSize={11} color={tokens.textTertiary}>
          In <Text color={tokens.textSecondary}>{formatBytes(t.inputSizeBytes ?? 0)}</Text>
        </Text>
        <Text fontSize={11} color={tokens.textTertiary}>
          Out <Text color={tokens.textSecondary}>{formatBytes(t.outputSizeBytes ?? 0)}</Text>
        </Text>
        <Button size="$2" theme="blue" onPress={() => onDrill(t.sessionUsageId)} aria-label={`Open session trace for ${t.sessionUsageId}`}>
          View trace →
        </Button>
      </XStack>
    </>
  )

  return (
    <SectionCard title="Tool executions" right={<Text fontSize={11} color={tokens.textTertiary}>{atFetchLimit ? `${fmtCount(tools.length)} most recent (more exist)` : `${fmtCount(tools.length)} shown`} · tap a row for details</Text>}>
      <DataTable columns={columns} rows={tools} rowKey={(t) => t.toolExecutionId} renderExpanded={renderDetail} />
    </SectionCard>
  )
}
