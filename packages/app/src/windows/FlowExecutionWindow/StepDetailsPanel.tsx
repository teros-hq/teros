/**
 * StepDetailsPanel — details of a selected execution step, as a ds Card.
 *
 * Displays:
 * - Node label, type, and description
 * - Step status badge
 * - Task ID (if any)
 * - Input/output data (collapsible JSON, mono)
 * - Error message (if failed)
 * - Timing info (started, completed, duration)
 */

import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Platform, Pressable, ScrollView, View } from "react-native"
import { useColors } from "../../components/mca/primitives/useColors"
import { Badge, Card, FieldLabel, Ph, T, Tile } from "../../components/ui/ds"
import {
  STEP_STATUS_META,
  STEP_STATUS_PH,
  STEP_STATUS_TONE,
  IDLE_NODE_META,
  EXEC_NODE_TYPE_META,
  EXEC_NODE_TYPE_PH,
  type ExecutionNodeData,
  type ExecutionStep,
  formatDuration,
  formatTime,
} from "./types"

interface StepDetailsPanelProps {
  /** Selected node data (null if no selection) */
  nodeData: ExecutionNodeData | null
  /** The full step data (if available) — includes input/output data */
  step: ExecutionStep | null
}

/** The step payload arrives with ISO strings from `get-execution`, Dates from the typed model — accept both. */
function toIso(v: unknown): string | undefined {
  if (!v) return undefined
  if (v instanceof Date) return v.toISOString()
  return String(v)
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 5 }}>
      <T step="xs" tone="text3" style={{ minWidth: 72 }}>
        {label}
      </T>
      <T step={mono ? "code" : "sm"} tone="text2" ellipsis style={{ flex: 1 }}>
        {value}
      </T>
    </View>
  )
}

function JsonBlock({ label, data }: { label: string; data: Record<string, unknown> }) {
  const c = useColors()
  const [open, setOpen] = useState(false)
  return (
    <View style={{ marginTop: 12 }}>
      <Pressable
        accessibilityRole="button"
        onPress={() => setOpen((o) => !o)}
        style={[
          { flexDirection: "row", alignItems: "center", gap: 6 },
          Platform.OS === "web" ? ({ cursor: "pointer" } as any) : null,
        ]}
      >
        <Ph name={open ? "caret-down" : "caret-right"} size={11} color={c.text3} />
        <T step="xs" tone="text2">
          {label}
        </T>
      </Pressable>
      {open ? (
        <ScrollView
          style={{ maxHeight: 200, marginTop: 8, borderRadius: 10, backgroundColor: c.nest }}
          contentContainerStyle={{ padding: 10 }}
        >
          <T step="code" tone="text2" style={{ lineHeight: 17 }}>
            {JSON.stringify(data, null, 2)}
          </T>
        </ScrollView>
      ) : null}
    </View>
  )
}

export function StepDetailsPanel({ nodeData, step }: StepDetailsPanelProps) {
  const { t } = useTranslation()
  const c = useColors()

  if (!nodeData) {
    return (
      <Card pad style={{ alignItems: "center", paddingVertical: 28 }}>
        <Tile sm icon="cursor-click" tone="muted" />
        <T step="12" tone="text3" center style={{ marginTop: 10 }}>
          {t("flowExecution.selectNode", { defaultValue: "Select a node to see its details" })}
        </T>
      </Card>
    )
  }

  const typeMeta = EXEC_NODE_TYPE_META[nodeData.nodeType]
  const statusMeta = nodeData.stepStatus ? STEP_STATUS_META[nodeData.stepStatus] : IDLE_NODE_META
  const tone = nodeData.stepStatus ? STEP_STATUS_TONE[nodeData.stepStatus] : "neutral"
  const glyph = nodeData.stepStatus ? STEP_STATUS_PH[nodeData.stepStatus] : "circle"

  return (
    <Card pad>
      {/* Header */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Tile xs icon={EXEC_NODE_TYPE_PH[nodeData.nodeType] ?? "circle"} />
        <T step="hsm" ellipsis style={{ flex: 1 }}>
          {nodeData.label || typeMeta.label}
        </T>
      </View>

      {/* Status badge */}
      <View style={{ marginTop: 10, flexDirection: "row" }}>
        <Badge tone={tone} icon={glyph} mono>
          {statusMeta.label}
        </Badge>
      </View>

      {/* Description */}
      {nodeData.description ? (
        <T step="12" tone="text2" style={{ marginTop: 10 }}>
          {nodeData.description}
        </T>
      ) : null}

      <View style={{ height: 1, backgroundColor: c.border, marginVertical: 12 }} />

      <Row label={t("flowExecution.field.type", { defaultValue: "Type" })} value={typeMeta.label} />
      {nodeData.role ? (
        <Row
          label={t("flowExecution.field.role", { defaultValue: "Role" })}
          value={
            nodeData.role === "human"
              ? t("flowExecution.role.human", { defaultValue: "Human" })
              : nodeData.role
          }
        />
      ) : null}
      {nodeData.taskId ? (
        <Row
          label={t("flowExecution.field.task", { defaultValue: "Task" })}
          value={nodeData.taskId}
          mono
        />
      ) : null}

      {/* Timing */}
      {step ? (
        <>
          <Row
            label={t("flowExecution.field.started", { defaultValue: "Started" })}
            value={formatTime(toIso(step.startedAt))}
            mono
          />
          <Row
            label={t("flowExecution.field.completed", { defaultValue: "Completed" })}
            value={formatTime(toIso(step.completedAt))}
            mono
          />
          <Row
            label={t("flowExecution.field.duration", { defaultValue: "Duration" })}
            value={formatDuration(toIso(step.startedAt), toIso(step.completedAt))}
            mono
          />
        </>
      ) : null}

      {/* Error */}
      {nodeData.stepError ? (
        <View style={{ marginTop: 12 }}>
          <FieldLabel>{t("flowExecution.field.error", { defaultValue: "Error" })}</FieldLabel>
          <View
            style={{
              padding: 10,
              borderRadius: 10,
              backgroundColor: c.tint.r.bg,
              borderWidth: 1,
              borderColor: c.tint.r.bd,
            }}
          >
            <T step="code" color={c.tint.r.tx}>
              {nodeData.stepError}
            </T>
          </View>
        </View>
      ) : null}

      {/* Input data */}
      {step?.inputData && Object.keys(step.inputData).length > 0 ? (
        <JsonBlock
          label={t("flowExecution.field.input", { defaultValue: "Input data" })}
          data={step.inputData}
        />
      ) : null}

      {/* Output data */}
      {step?.outputData && Object.keys(step.outputData).length > 0 ? (
        <JsonBlock
          label={t("flowExecution.field.output", { defaultValue: "Output data" })}
          data={step.outputData}
        />
      ) : null}

      {/* Instructions */}
      {nodeData.instructions ? (
        <View style={{ marginTop: 12 }}>
          <FieldLabel>
            {t("flowExecution.field.instructions", { defaultValue: "Instructions" })}
          </FieldLabel>
          <ScrollView style={{ maxHeight: 140 }}>
            <T step="12" tone="text2">
              {nodeData.instructions}
            </T>
          </ScrollView>
        </View>
      ) : null}
    </Card>
  )
}
