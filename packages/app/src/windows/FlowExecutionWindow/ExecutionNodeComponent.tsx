/**
 * ExecutionNodeComponent — Custom React Flow node for execution monitoring
 *
 * Renders a node with:
 * - Status-tinted card (based on execution step status, via useColors())
 * - Node type glyph + label
 * - Step status badge with Phosphor glyph
 * - Task ID (if a task was created)
 * - Error display (if failed)
 * - Pulsing animation for running nodes
 *
 * Presentation follows the OS prototype: a step card (radius 16, violet lift),
 * 400 weight, Saans / Reddit Mono, Phosphor glyphs.
 */

import { memo } from "react"
import { Handle, Position, type NodeProps } from "@xyflow/react"
import { useColors } from "../../components/mca/primitives/useColors"
import { colors as semantic } from "../../components/mca/primitives/colors"
import { FONT_MONO, FONT_SANS } from "../../components/mca/primitives/fonts"
import { Ph } from "../../components/ui/ds"
import {
  STEP_STATUS_META,
  STEP_STATUS_PH,
  STEP_STATUS_TONE,
  IDLE_NODE_META,
  EXEC_NODE_TYPE_META,
  EXEC_NODE_TYPE_PH,
  type ExecutionNodeData,
} from "./types"

function ExecutionNodeComponentInner({ data, selected }: NodeProps) {
  const c = useColors()
  const nodeData = data as ExecutionNodeData
  const typeMeta = EXEC_NODE_TYPE_META[nodeData.nodeType]
  const statusMeta = nodeData.stepStatus ? STEP_STATUS_META[nodeData.stepStatus] : IDLE_NODE_META
  const tone = nodeData.stepStatus ? STEP_STATUS_TONE[nodeData.stepStatus] : "neutral"
  const tint = tone === "neutral" ? null : c.tint[tone]
  const statusFg = tint ? tint.tx : c.text3
  const statusBg = tint ? tint.bg : c.wash
  const ringColor = tint ? tint.bd : c.borderStrong
  const statusGlyph = nodeData.stepStatus ? STEP_STATUS_PH[nodeData.stepStatus] : "circle"

  const isRunning = nodeData.stepStatus === "running"
  const isFailed = nodeData.stepStatus === "failed"

  return (
    <div
      style={{
        background: c.bgStep,
        border: `1px solid ${selected ? c.borderAccentStrong : "transparent"}`,
        borderRadius: 16,
        minWidth: 180,
        maxWidth: 260,
        padding: 0,
        boxShadow: selected
          ? `0 0 0 3px ${c.navActive}, ${c.liftSmHover}`
          : isRunning
            ? `0 0 0 2px ${ringColor}, ${c.liftSm}`
            : c.liftSm,
        transition: "border-color 0.2s, box-shadow 0.3s",
        fontFamily: FONT_SANS,
        fontWeight: 400,
        color: c.text,
        overflow: "visible",
        animation: isRunning ? "execPulse 1.5s ease-in-out infinite" : undefined,
      }}
    >
      {/* Header — node type + label */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 12px 6px",
          fontSize: 13,
          lineHeight: 1.3,
        }}
      >
        <span
          style={{
            width: 24,
            height: 24,
            borderRadius: 6,
            background: c.tile,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <Ph name={EXEC_NODE_TYPE_PH[nodeData.nodeType] ?? "circle"} size={13} color={c.accent} />
        </span>
        <span
          style={{
            color: c.text,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
          }}
        >
          {nodeData.label || typeMeta.label}
        </span>
      </div>

      {/* Status badge */}
      <div style={{ padding: "0 12px 6px", display: "flex" }}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            padding: "2px 8px",
            borderRadius: 5,
            background: statusBg,
            fontFamily: FONT_MONO,
            fontSize: 10,
            lineHeight: "13px",
            color: statusFg,
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
        >
          <Ph name={statusGlyph} size={11} color={statusFg} />
          <span>{statusMeta.label}</span>
        </span>
      </div>

      {/* Body — task info and error */}
      <div style={{ padding: "0 12px 10px", fontSize: 11, color: c.text2 }}>
        {/* Task ID */}
        {nodeData.taskId && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              padding: "3px 7px",
              background: c.nest,
              borderRadius: 6,
              marginTop: 2,
            }}
          >
            <Ph name="kanban" size={11} color={c.text3} />
            <span
              style={{
                color: c.text3,
                fontSize: 10,
                fontFamily: FONT_MONO,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                flex: 1,
              }}
            >
              {nodeData.taskId}
            </span>
          </div>
        )}

        {/* Error message */}
        {isFailed && nodeData.stepError && (
          <div
            style={{
              padding: "4px 7px",
              background: c.tint.r.bg,
              borderRadius: 6,
              fontSize: 10,
              lineHeight: 1.35,
              color: c.tint.r.tx,
              marginTop: 6,
              wordBreak: "break-word",
            }}
          >
            {nodeData.stepError}
          </div>
        )}

        {/* Timing */}
        {nodeData.stepStartedAt && (
          <div
            style={{
              marginTop: 6,
              fontSize: 10,
              fontFamily: FONT_MONO,
              color: c.text3,
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            <Ph name="clock" size={10} color={c.text3} />
            <span>{formatTimeShort(nodeData.stepStartedAt)}</span>
            {nodeData.stepCompletedAt && (
              <span> → {formatTimeShort(nodeData.stepCompletedAt)}</span>
            )}
          </div>
        )}
      </div>

      {/* Input handles (left side) */}
      {nodeData.inputs.map((gate, index) => {
        const offset = calculateHandleOffset(index, nodeData.inputs.length)
        return (
          <Handle
            key={gate.gateId}
            id={gate.gateId}
            type="target"
            position={Position.Left}
            style={{
              top: offset,
              background: gate.schemaId ? semantic.amber : c.text3,
              width: 8,
              height: 8,
              border: `2px solid ${c.bgStep}`,
            }}
          />
        )
      })}

      {/* Output handles (right side) */}
      {nodeData.outputs.map((gate, index) => {
        const offset = calculateHandleOffset(index, nodeData.outputs.length)
        return (
          <Handle
            key={gate.gateId}
            id={gate.gateId}
            type="source"
            position={Position.Right}
            style={{
              top: offset,
              background: gate.schemaId ? semantic.green : c.text3,
              width: 8,
              height: 8,
              border: `2px solid ${c.bgStep}`,
            }}
          />
        )
      })}
    </div>
  )
}

function calculateHandleOffset(index: number, total: number): number {
  const headerHeight = 52
  const gateRowHeight = 20
  const startOffset = headerHeight + 8
  if (total === 1) return startOffset
  return startOffset + index * gateRowHeight + gateRowHeight / 2
}

function formatTimeShort(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

export const ExecutionNodeComponent = memo(ExecutionNodeComponentInner)
