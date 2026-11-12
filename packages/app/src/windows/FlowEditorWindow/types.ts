/**
 * FlowEditorWindow — Shared Types
 *
 * Type definitions for the visual flow editor, mapping between
 * the @teros/workflows Flowing data models and React Flow's node/edge shapes.
 *
 * Flowing model:
 * - 6 node types: start, action, end, function, pin, integration
 * - Gates reference Artifacts via schemaId (artifactId), or null for signal-only
 * - WorkflowNode uses inputs/outputs, color, direction, data
 * - WorkflowEdge uses outputNodeId/outputId/inputNodeId/inputId
 */

import type { Node, Edge } from "@xyflow/react"
import type { WorkflowNode, WorkflowEdge, Gate, Flow, NodeType, Artifact } from "@teros/workflows"
import {
  Play,
  Zap,
  CircleStop,
  FunctionSquare,
  Pin,
  Plug,
  Split,
  Merge,
} from "@tamagui/lucide-icons"
import type { ComponentType } from "react"

// Re-export types that other components in this directory need
export type {
  NodeType,
  Gate,
  WorkflowNode,
  WorkflowEdge,
  Flow,
  Artifact,
  Trigger,
} from "@teros/workflows"

// ============================================================================
// REACT FLOW CUSTOM NODE DATA
// ============================================================================

/**
 * Data payload carried by each React Flow node.
 * Mirrors WorkflowNode but adds UI-specific fields.
 */
export interface FlowNodeData extends Record<string, unknown> {
  /** Workflow node type (start, action, end, function, pin, integration) */
  nodeType: NodeType
  /** Human-readable label */
  label: string
  /** Description of what this node does */
  description: string
  /** Instructions sent to the agent/human */
  instructions: string
  /** Who executes this node (agentId or 'human') */
  role: string
  /** Color for visual identification (hex) */
  color: string
  /** Visual layout direction */
  direction: string
  /** Input gates */
  inputs: Gate[]
  /** Output gates */
  outputs: Gate[]
  /** Node-specific configuration (e.g., function code, integration config) */
  data?: Record<string, unknown>
  /**
   * Project ID override for this action node — when set, tasks created by
   * this node go to this project's board instead of the flow's default.
   * Only meaningful for action nodes.
   */
  projectId?: string
  /** Whether this node is currently selected in the editor */
  selected?: boolean
}

/** React Flow node type used in the editor */
export type FlowRFNode = Node<FlowNodeData>

// ============================================================================
// REACT FLOW CUSTOM EDGE DATA
// ============================================================================

/**
 * Data payload carried by each React Flow edge.
 * Maps to WorkflowEdge (gate-to-gate connections using Flowing naming).
 */
export interface FlowEdgeData extends Record<string, unknown> {
  /** Source gate ID (outputId in Flowing terms) */
  outputId: string
  /** Target gate ID (inputId in Flowing terms) */
  inputId: string
  /** Edge color derived from the source gate's artifact color (hex) */
  color?: string
}

/** React Flow edge type used in the editor */
export type FlowRFEdge = Edge<FlowEdgeData>

// ============================================================================
// CONVERTERS — Workflow ↔ React Flow
// ============================================================================

/**
 * Convert a WorkflowNode to a React Flow node.
 */
export function workflowNodeToRFNode(node: WorkflowNode): FlowRFNode {
  return {
    id: node.nodeId,
    type: "flowNode",
    position: node.position,
    data: {
      nodeType: node.type,
      label: node.label,
      description: node.description,
      instructions: node.instructions,
      role: node.role,
      color: node.color,
      direction: node.direction,
      inputs: node.inputs,
      outputs: node.outputs,
      data: node.data,
      projectId: node.projectId,
    },
  }
}

/**
 * Convert a React Flow node back to a WorkflowNode.
 */
export function rfNodeToWorkflowNode(node: FlowRFNode): WorkflowNode {
  const data = node.data as FlowNodeData
  return {
    nodeId: node.id,
    type: data.nodeType,
    label: data.label,
    description: data.description ?? "",
    instructions: data.instructions ?? "",
    role: data.role ?? "",
    color: data.color || NODE_TYPE_META[data.nodeType].color,
    direction: data.direction || "right",
    inputs: (data.inputs ?? []).map(cleanGate),
    outputs: (data.outputs ?? []).map(cleanGate),
    position: { x: node.position.x, y: node.position.y },
    ...(data.data ? { data: data.data } : {}),
    ...(data.projectId ? { projectId: data.projectId } : {}),
  }
}

/** Strip null values from gate fields before sending to MCA. */
function cleanGate(gate: Gate): Gate {
  return {
    gateId: gate.gateId,
    ...(gate.label != null ? { label: gate.label } : {}),
    schemaId: gate.schemaId ?? null,
    ...(gate.allowModifying != null ? { allowModifying: gate.allowModifying } : {}),
  }
}

/**
 * Convert a WorkflowEdge to a React Flow edge.
 * Flowing uses outputNodeId/outputId → inputNodeId/inputId.
 */
export function workflowEdgeToRFEdge(edge: WorkflowEdge): FlowRFEdge {
  return {
    id: edge.edgeId,
    source: edge.outputNodeId,
    target: edge.inputNodeId,
    sourceHandle: edge.outputId,
    targetHandle: edge.inputId,
    type: "flowEdge",
    label: edge.label,
    data: {
      outputId: edge.outputId,
      inputId: edge.inputId,
      ...(edge.color ? { color: edge.color } : {}),
    },
  }
}

/**
 * Convert a React Flow edge back to a WorkflowEdge.
 */
export function rfEdgeToWorkflowEdge(edge: FlowRFEdge, flowId: string): WorkflowEdge {
  const data = (edge.data ?? {}) as FlowEdgeData
  return {
    edgeId: edge.id,
    flowId,
    label: typeof edge.label === "string" ? edge.label : undefined,
    outputNodeId: edge.source,
    outputId: data.outputId ?? edge.sourceHandle ?? "",
    inputNodeId: edge.target,
    inputId: data.inputId ?? edge.targetHandle ?? "",
    ...(data.color ? { color: data.color } : {}),
  }
}

/**
 * Convert an entire Flow document to React Flow nodes + edges.
 */
export function flowToReactFlow(flow: Flow): { nodes: FlowRFNode[]; edges: FlowRFEdge[] } {
  return {
    nodes: flow.nodes.map(workflowNodeToRFNode),
    edges: flow.edges.map(workflowEdgeToRFEdge),
  }
}

/**
 * Convert React Flow nodes + edges back to workflow format.
 */
export function reactFlowToWorkflow(
  nodes: FlowRFNode[],
  edges: FlowRFEdge[],
  flowId: string,
): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  return {
    nodes: nodes.map(rfNodeToWorkflowNode),
    edges: edges.map((e) => rfEdgeToWorkflowEdge(e, flowId)),
  }
}

// ============================================================================
// NODE TYPE METADATA — for palette and styling
// ============================================================================

export interface NodeTypeMeta {
  type: NodeType
  label: string
  description: string
  color: string
  bgColor: string
  borderColor: string
  icon: ComponentType<{ size?: number; color?: string; strokeWidth?: number }>
  /** Phosphor glyph (kebab-case) — the OS design language icon for this type. */
  phIcon: string
  defaultInputs: number
  defaultOutputs: number
  canDelete: boolean
  canDuplicate: boolean
  /** Whether this node type creates a task on the board */
  createsTask: boolean
  /** Default color for nodes of this type (hex) */
  defaultColor: string
  /** Default direction for layout */
  defaultDirection: string
}

export const NODE_TYPE_META: Record<NodeType, NodeTypeMeta> = {
  start: {
    type: "start",
    label: "Start",
    description: "Entry point — receives trigger data",
    color: "#10B981",
    bgColor: "#064E3B",
    borderColor: "#10B981",
    icon: Play,
    phIcon: "play",
    defaultInputs: 0,
    defaultOutputs: 1,
    canDelete: false,
    canDuplicate: false,
    createsTask: false,
    defaultColor: "#10B981",
    defaultDirection: "right",
  },
  action: {
    type: "action",
    label: "Action",
    description: "Creates a task for an agent or human",
    color: "#3B82F6",
    bgColor: "#1E3A5F",
    borderColor: "#3B82F6",
    icon: Zap,
    phIcon: "lightning",
    defaultInputs: 1,
    defaultOutputs: 1,
    canDelete: true,
    canDuplicate: true,
    createsTask: true,
    defaultColor: "#3B82F6",
    defaultDirection: "right",
  },
  end: {
    type: "end",
    label: "End",
    description: "Terminal node — flow completes here",
    color: "#EF4444",
    bgColor: "#5B1D1D",
    borderColor: "#EF4444",
    icon: CircleStop,
    phIcon: "stop-circle",
    defaultInputs: 1,
    defaultOutputs: 0,
    canDelete: true,
    canDuplicate: true,
    createsTask: false,
    defaultColor: "#EF4444",
    defaultDirection: "right",
  },
  function: {
    type: "function",
    label: "Function",
    description: "Programmatic node — executes code automatically",
    color: "#F59E0B",
    bgColor: "#5B4211",
    borderColor: "#F59E0B",
    icon: FunctionSquare,
    phIcon: "function",
    defaultInputs: 1,
    defaultOutputs: 1,
    canDelete: true,
    canDuplicate: true,
    createsTask: false,
    defaultColor: "#F59E0B",
    defaultDirection: "right",
  },
  pin: {
    type: "pin",
    label: "Pin",
    description: "Proxy/rerouting — passes data through unchanged",
    color: "#8B5CF6",
    bgColor: "#3D2D5B",
    borderColor: "#8B5CF6",
    icon: Pin,
    phIcon: "push-pin",
    defaultInputs: 1,
    defaultOutputs: 1,
    canDelete: true,
    canDuplicate: true,
    createsTask: false,
    defaultColor: "#8B5CF6",
    defaultDirection: "right",
  },
  integration: {
    type: "integration",
    label: "Integration",
    description: "Executes an external integration via MCA",
    color: "#EC4899",
    bgColor: "#5B1D3D",
    borderColor: "#EC4899",
    icon: Plug,
    phIcon: "plugs",
    defaultInputs: 1,
    defaultOutputs: 1,
    canDelete: true,
    canDuplicate: true,
    createsTask: false,
    defaultColor: "#EC4899",
    defaultDirection: "right",
  },
  split: {
    type: "split",
    label: "Split",
    description: "Fans out one artifact array into parallel branches",
    color: "#F59E0B",
    bgColor: "#5B4211",
    borderColor: "#F59E0B",
    icon: Split,
    phIcon: "arrows-split",
    defaultInputs: 1,
    defaultOutputs: 2,
    canDelete: true,
    canDuplicate: true,
    createsTask: false,
    defaultColor: "#F59E0B",
    defaultDirection: "right",
  },
  join: {
    type: "join",
    label: "Join",
    description: "Waits for parallel branches and merges their outputs",
    color: "#8B5CF6",
    bgColor: "#2E1065",
    borderColor: "#8B5CF6",
    icon: Merge,
    phIcon: "arrows-merge",
    defaultInputs: 2,
    defaultOutputs: 1,
    canDelete: true,
    canDuplicate: true,
    createsTask: false,
    defaultColor: "#8B5CF6",
    defaultDirection: "right",
  },
}

export const NODE_PALETTE: NodeType[] = ["start", "action", "function", "pin", "integration", "end"]

// ============================================================================
// GATE HELPERS
// ============================================================================
/**
 * Create a default gate with a generated ID.
 * In the Flowing model, gates default to signal-only (schemaId: null)
 * — signal-only by default.
 */
export function createDefaultGate(direction: "input" | "output", index: number): Gate {
  return {
    gateId: `gate_${direction}_${Date.now()}_${index}`,
    label: `${direction === "input" ? "Input" : "Output"} ${index + 1}`,
    schemaId: null, // signal-only by default
  }
}

/**
 * Generate a unique node ID.
 */
export function generateNodeId(): string {
  return `node_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Generate a unique edge ID.
 */
export function generateEdgeId(): string {
  return `edge_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}
