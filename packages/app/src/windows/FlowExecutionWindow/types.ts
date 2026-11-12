/**
 * FlowExecutionWindow — Shared Types
 *
 * Type definitions for the execution monitor, extending the FlowEditor
 * types with execution status information.
 */

import type { Node, Edge } from "@xyflow/react"
import type {
  Execution,
  ExecutionStep,
  ExecutionStepStatus,
  ExecutionStatus,
  Flow,
  NodeType,
  Gate,
} from "@teros/workflows"

// Re-export for convenience
export type { Execution, ExecutionStep, ExecutionStepStatus, ExecutionStatus, Flow }

// ============================================================================
// EXECUTION NODE DATA — extends FlowNodeData with execution status
// ============================================================================

/**
 * Data payload for execution nodes.
 * Extends the editor's FlowNodeData with execution status overlay.
 */
export interface ExecutionNodeData extends Record<string, unknown> {
  /** Workflow node type */
  nodeType: NodeType
  /** Node label */
  label: string
  /** Node description */
  description: string
  /** Instructions */
  instructions: string
  /** Role */
  role: string
  /** Input gates */
  inputs: Gate[]
  color: string
  direction: string
  /** Output gates */
  outputs: Gate[]
  /** Execution step status (null if no step for this node) */
  stepStatus: ExecutionStepStatus | null
  /** Task ID associated with this node's step (if any) */
  taskId?: string
  /** Step error message (if failed) */
  stepError?: string
  /** When the step started */
  stepStartedAt?: string
  /** When the step completed */
  stepCompletedAt?: string
  /** Whether this node is currently selected */
  selected?: boolean
}

export type ExecutionRFNode = Node<ExecutionNodeData>

export type ExecutionRFEdge = Edge

// ============================================================================
// EXECUTION STATUS METADATA — for styling nodes by status
// ============================================================================

export interface StepStatusMeta {
  label: string
  color: string
  bgColor: string
  borderColor: string
  icon: string
  /** Pulsing animation for active states */
  pulse?: boolean
}

export const STEP_STATUS_META: Record<ExecutionStepStatus, StepStatusMeta> = {
  pending: {
    label: "Pending",
    color: "#9CA3AF",
    bgColor: "#1F2937",
    borderColor: "#4B5563",
    icon: "⏳",
  },
  running: {
    label: "Running",
    color: "#3B82F6",
    bgColor: "#1E3A5F",
    borderColor: "#3B82F6",
    icon: "⚡",
    pulse: true,
  },
  completed: {
    label: "Completed",
    color: "#10B981",
    bgColor: "#064E3B",
    borderColor: "#10B981",
    icon: "✓",
  },
  failed: {
    label: "Failed",
    color: "#EF4444",
    bgColor: "#5B1D1D",
    borderColor: "#EF4444",
    icon: "✕",
  },
  blocked: {
    label: "Blocked",
    color: "#F59E0B",
    bgColor: "#5B4211",
    borderColor: "#F59E0B",
    icon: "⛔",
  },
  retry: {
    label: "Retry",
    color: "#8B5CF6",
    bgColor: "#3D2D5B",
    borderColor: "#8B5CF6",
    icon: "🔄",
    pulse: true,
  },
}

/** Status for nodes that have no step yet (not reached by execution) */
export const IDLE_NODE_META: StepStatusMeta = {
  label: "Idle",
  color: "#6B7280",
  bgColor: "#111827",
  borderColor: "#374151",
  icon: "○",
}

// ============================================================================
// EXECUTION STATUS META — for the status badge in the toolbar
// ============================================================================

export interface ExecutionStatusMeta {
  label: string
  color: string
  bgColor: string
  icon: string
  pulse?: boolean
}

export const EXECUTION_STATUS_META: Record<ExecutionStatus, ExecutionStatusMeta> = {
  running: {
    label: "Running",
    color: "#3B82F6",
    bgColor: "#1E3A5F",
    icon: "⚡",
    pulse: true,
  },
  completed: {
    label: "Completed",
    color: "#10B981",
    bgColor: "#064E3B",
    icon: "✓",
  },
  failed: {
    label: "Failed",
    color: "#EF4444",
    bgColor: "#5B1D1D",
    icon: "✕",
  },
  paused: {
    label: "Paused",
    color: "#F59E0B",
    bgColor: "#5B4211",
    icon: "⏸",
  },
  cancelled: {
    label: "Cancelled",
    color: "#6B7280",
    bgColor: "#1F2937",
    icon: "⊘",
  },
}

// ============================================================================
// NODE TYPE METADATA — reuse from FlowEditor types
// ============================================================================

export interface ExecNodeTypeMeta {
  type: NodeType
  label: string
  icon: string
  color: string
}

export const EXEC_NODE_TYPE_META: Record<NodeType, ExecNodeTypeMeta> = {
  start: { type: "start", label: "Start", icon: "▶", color: "#10B981" },
  action: { type: "action", label: "Action", icon: "⚡", color: "#3B82F6" },
  end: { type: "end", label: "End", icon: "⏹", color: "#EF4444" },
  function: { type: "function", label: "Function", icon: "ƒ", color: "#F59E0B" },
  pin: { type: "pin", label: "Pin", icon: "📌", color: "#8B5CF6" },
  integration: { type: "integration", label: "Integration", icon: "🔌", color: "#EC4899" },
  split: { type: "split", label: "Split", icon: "⑂", color: "#F59E0B" },
  join: { type: "join", label: "Join", icon: "⨝", color: "#8B5CF6" },
}

// ============================================================================
// CONVERTERS — Flow + Execution → React Flow nodes with status
// ============================================================================

/**
 * Build React Flow nodes from a Flow document, overlaying execution step statuses.
 *
 * @param flow The flow definition (nodes + edges)
 * @param steps The execution steps (from get-execution)
 * @returns React Flow nodes with execution status data
 */
export function flowToExecutionNodes(
  flow: Flow,
  steps: ExecutionStep[],
): { nodes: ExecutionRFNode[]; edges: ExecutionRFEdge[] } {
  // Build a map of nodeId → step for quick lookup
  const stepByNodeId = new Map<string, ExecutionStep>()
  for (const step of steps) {
    stepByNodeId.set(step.nodeId, step)
  }

  const nodes: ExecutionRFNode[] = flow.nodes.map((wn) => {
    const step = stepByNodeId.get(wn.nodeId)
    return {
      id: wn.nodeId,
      type: "executionNode",
      position: wn.position,
      data: {
        nodeType: wn.type,
        label: wn.label,
        description: wn.description,
        instructions: wn.instructions,
        role: wn.role,
        inputs: wn.inputs,
        color: wn.color,
        direction: wn.direction,
        outputs: wn.outputs,
        stepStatus: step?.status ?? null,
        taskId: step?.taskId,
        stepError: step?.error,
        stepStartedAt: step?.startedAt?.toISOString(),
        stepCompletedAt: step?.completedAt?.toISOString(),
      } as ExecutionNodeData,
    }
  })

  const edges: ExecutionRFEdge[] = flow.edges.map((we) => ({
    id: we.edgeId,
    source: we.outputNodeId,
    target: we.inputNodeId,
    sourceHandle: we.outputId,
    targetHandle: we.inputId,
    type: "smoothstep",
  }))

  return { nodes, edges }
}

// ============================================================================
// POLLING CONFIG
// ============================================================================

/** Polling interval for execution status updates (ms) — fallback when WebSocket events are not available */
export const POLL_INTERVAL_MS = 5000

/** Max polling attempts before stopping (safety) */
export const MAX_POLL_ATTEMPTS = 240 // 20 min at 5s interval

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Format a duration from ISO strings.
 */
export function formatDuration(start?: string, end?: string): string {
  if (!start) return "—"
  const startTime = new Date(start).getTime()
  const endTime = end ? new Date(end).getTime() : Date.now()
  const diffMs = endTime - startTime
  if (diffMs < 1000) return "<1s"
  if (diffMs < 60000) return `${Math.floor(diffMs / 1000)}s`
  if (diffMs < 3600000)
    return `${Math.floor(diffMs / 60000)}m ${Math.floor((diffMs % 60000) / 1000)}s`
  return `${Math.floor(diffMs / 3600000)}h ${Math.floor((diffMs % 3600000) / 60000)}m`
}

/**
 * Format an ISO timestamp for display.
 */
export function formatTime(iso?: string): string {
  if (!iso) return "—"
  const d = new Date(iso)
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

// ============================================================================
// OS PROTOTYPE PRESENTATION — status tints + Phosphor glyphs
// ============================================================================

/** Status tint key of `useColors().tint` (`'neutral'` = washed, no tint). */
export type StatusTone = "g" | "a" | "r" | "i" | "m" | "neutral"

export const STEP_STATUS_TONE: Record<ExecutionStepStatus, StatusTone> = {
  pending: "neutral",
  running: "i",
  completed: "g",
  failed: "r",
  blocked: "a",
  retry: "i",
}

export const STEP_STATUS_PH: Record<ExecutionStepStatus, string> = {
  pending: "circle-dashed",
  running: "circle-notch",
  completed: "check-circle",
  failed: "x-circle",
  blocked: "prohibit",
  retry: "arrows-clockwise",
}

export const EXECUTION_STATUS_TONE: Record<ExecutionStatus, StatusTone> = {
  running: "i",
  completed: "g",
  failed: "r",
  paused: "a",
  cancelled: "neutral",
}

export const EXECUTION_STATUS_PH: Record<ExecutionStatus, string> = {
  running: "circle-notch",
  completed: "check-circle",
  failed: "x-circle",
  paused: "pause-circle",
  cancelled: "prohibit",
}

export const EXEC_NODE_TYPE_PH: Record<NodeType, string> = {
  start: "play",
  action: "lightning",
  end: "stop",
  function: "function",
  pin: "push-pin",
  integration: "plugs",
  split: "git-fork",
  join: "git-merge",
}
