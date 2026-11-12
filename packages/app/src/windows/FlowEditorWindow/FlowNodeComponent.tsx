/**
 * FlowNodeComponent — Custom React Flow node for workflow nodes
 *
 * Keeps the Flowing/HexaFlows node anatomy (header strip, body, gate list,
 * triangular gate handles) but draws it in the OS design language:
 * - A card one step off the sheet (`bgStep`), radius 14, hairline border,
 *   the violet lift shadow; selection = 2px accent ring.
 * - Each node type keeps its coloured header rule (3px, the node colour).
 *   - Action: assignee name in the header, `user` glyph, title + description
 *   - Function: accent header wash, "Tools" + `cpu` glyph, "Auto" badge
 *   - Start/End (gate): compact 56px pill-ish card, centred label
 *   - Pin: small 24px circle on the tile wash
 *   - Integration: `plugs` glyph + integration name, "Integration" footer
 * - Input gate handles on the left, output gate handles on the right
 *   (Flowing-style triangles — see GateHandle)
 * - Gate list inside the body with mini triangles + Phosphor glyphs
 * - Signal-only gates visually distinct from data gates
 *
 * Gate visual language (Flowing-style):
 *   Data gate (has schemaId):  ▶ coloured triangle (artifact colour + stroke border)
 *   Signal gate (no schemaId): ▶ grey triangle with the bell glyph
 */

import { memo } from "react"
import { Position, type NodeProps } from "@xyflow/react"
import { Ph } from "../../components/ui/ds"
import { NODE_TYPE_META, type FlowNodeData, type Gate } from "./types"
import { GateHandle } from "./GateHandle"
import { useArtifact, useWorkspaceMember } from "./FlowEditorContext"
import { getAvatarBorderColor } from "../BoardWindow/board-utils"
import { resolveGateColors } from "./flowingColors"
import { useFlowEditorTheme, type FlowEditorTheme } from "./useFlowEditorTheme"

const NODE_WIDTH = 288

// ============================================================================
// MINI TRIANGLE SVG — for gate rows inside the node body
// ============================================================================

function MiniTriangle({ color, strokeColor }: { color: string; strokeColor: string }) {
  return (
    <svg
      width="10"
      height="12"
      viewBox="0 0 9 11"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ flexShrink: 0 }}
    >
      <path
        d="M7.75 6.79904L3.25 9.39712C2.25 9.97446 1 9.25278 1 8.09808L1 2.90192C1 1.74722 2.25 1.02554 3.25 1.60289L7.75 4.20096C8.75 4.77831 8.75 6.22169 7.75 6.79904Z"
        fill={color}
        stroke={strokeColor}
        strokeWidth="0.6"
      />
    </svg>
  )
}

// ============================================================================
// GATE ROW — inside the node body, shows gate info with a Phosphor glyph
// ============================================================================

function GateRow({ gate }: { gate: Gate }) {
  const t = useFlowEditorTheme()
  const artifact = useArtifact(gate.schemaId)
  const isData = gate.schemaId !== null
  const { fill, stroke } = resolveGateColors(artifact?.color)

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "2px 0",
        fontSize: 11,
        lineHeight: "14px",
        color: t.nodeGateText,
      }}
    >
      <MiniTriangle color={fill} strokeColor={stroke} />

      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {gate.label || gate.gateId}
      </span>

      <span
        style={{
          color: t.nodeDescText,
          fontFamily: t.fontMono,
          fontSize: 9,
          letterSpacing: 0.3,
          textTransform: "uppercase",
          marginLeft: "auto",
          display: "flex",
          alignItems: "center",
          gap: 4,
          flexShrink: 0,
        }}
      >
        <Ph name={isData ? "package" : "bell"} size={10} color={t.nodeDescText} />
        {isData ? (artifact ? artifact.name : gate.schemaId!.slice(0, 8)) : "signal"}
      </span>
    </div>
  )
}

// ============================================================================
// SHARED PIECES
// ============================================================================

/** The card frame every full-size node shares. */
function cardStyle(t: FlowEditorTheme, selected: boolean, ringColor: string): React.CSSProperties {
  return {
    background: t.nodeBg,
    border: `1px solid ${selected ? "transparent" : t.nodeBorder}`,
    borderRadius: 14,
    width: NODE_WIDTH,
    boxShadow: selected ? `0 0 0 2px ${ringColor}, ${t.nodeShadow}` : t.nodeShadow,
    overflow: "visible",
    position: "relative",
    fontFamily: t.fontSans,
    fontWeight: 400,
    cursor: "pointer",
    transition: "box-shadow 0.3s cubic-bezier(.16,1,.3,1)",
  }
}

function headerStyle(color: string, bg?: string): React.CSSProperties {
  return {
    padding: "8px 20px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    borderBottom: `3px solid ${color}`,
    background: bg,
    borderTopLeftRadius: 13,
    borderTopRightRadius: 13,
    minHeight: 36,
    boxSizing: "border-box",
  }
}

function GatesSection({ data }: { data: FlowNodeData }) {
  if (data.inputs.length === 0 && data.outputs.length === 0) return null
  return (
    <div style={{ padding: "0 20px 10px" }}>
      {data.inputs.length > 0 && (
        <div style={{ marginBottom: data.outputs.length ? 4 : 0 }}>
          {data.inputs.map((gate) => (
            <GateRow key={gate.gateId} gate={gate} />
          ))}
        </div>
      )}
      {data.outputs.length > 0 && (
        <div>
          {data.outputs.map((gate) => (
            <GateRow key={gate.gateId} gate={gate} />
          ))}
        </div>
      )}
    </div>
  )
}

function Handles({ data, baseTop }: { data: FlowNodeData; baseTop: number }) {
  return (
    <>
      {data.inputs.map((gate, index) => (
        <GateHandleWrapper
          key={gate.gateId}
          gate={gate}
          type="target"
          position={Position.Left}
          top={baseTop + index * 14}
        />
      ))}
      {data.outputs.map((gate, index) => (
        <GateHandleWrapper
          key={gate.gateId}
          gate={gate}
          type="source"
          position={Position.Right}
          top={baseTop + index * 14}
        />
      ))}
    </>
  )
}

function Title({ children, color }: { children: React.ReactNode; color: string }) {
  return (
    <div
      style={{
        fontSize: 14,
        lineHeight: "20px",
        color,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </div>
  )
}

function Description({ children, color }: { children: React.ReactNode; color: string }) {
  return (
    <div style={{ fontSize: 12, lineHeight: "16px", color, minHeight: 48, marginTop: 2 }}>
      {children}
    </div>
  )
}

// ============================================================================
// ASSIGNEE BADGE — Shows avatar with border on canvas action nodes
// ============================================================================

function AssigneeBadge({ roleId }: { roleId: string }) {
  const t = useFlowEditorTheme()
  const member = useWorkspaceMember(roleId)

  if (!member) {
    const displayName = roleId === "human" ? "Human" : roleId
    return (
      <div
        style={{
          marginTop: 6,
          padding: "3px 8px",
          borderRadius: 100,
          background: t.wash,
          fontSize: 10,
          color: t.nodeBodyText,
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
        }}
      >
        <Ph name="user" size={10} color={t.nodeBodyText} /> {displayName}
      </div>
    )
  }

  const borderColor = getAvatarBorderColor(roleId, member.type)
  const memberType = member.type ?? (roleId.startsWith("agent_") ? "agent" : "human")

  return (
    <div
      style={{
        marginTop: 6,
        padding: "3px 8px 3px 3px",
        borderRadius: 100,
        background: t.wash,
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        maxWidth: "100%",
        overflow: "hidden",
      }}
    >
      {member.avatarUrl ? (
        <img
          src={member.avatarUrl}
          alt={member.name}
          style={{
            width: 18,
            height: 18,
            borderRadius: "50%",
            border: `2px solid ${borderColor}`,
            objectFit: "cover",
            flexShrink: 0,
          }}
        />
      ) : (
        <div
          style={{
            width: 18,
            height: 18,
            borderRadius: "50%",
            border: `2px solid ${borderColor}`,
            background: t.pinNodeBg,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: t.fontSerif,
            fontSize: 8,
            color: t.pinNodeIconColor,
            flexShrink: 0,
            boxSizing: "border-box",
          }}
        >
          {member.name
            .split(" ")
            .map((w) => w[0])
            .slice(0, 2)
            .join("")
            .toUpperCase()}
        </div>
      )}
      <span
        style={{
          fontSize: 10,
          color: t.nodeBodyText,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {member.name}
      </span>
      <span
        style={{
          fontSize: 8,
          color: borderColor,
          textTransform: "capitalize",
          flexShrink: 0,
        }}
      >
        {memberType}
      </span>
    </div>
  )
}

// ============================================================================
// GATE HANDLE WRAPPER — connects context lookup to GateHandle
// ============================================================================

function GateHandleWrapper({
  gate,
  type,
  position,
  top,
}: {
  gate: Gate
  type: "source" | "target"
  position: Position
  top: number
}) {
  const artifact = useArtifact(gate.schemaId)
  return (
    <GateHandle
      gateId={gate.gateId}
      type={type}
      position={position}
      top={top}
      schemaId={gate.schemaId}
      artifact={artifact}
    />
  )
}

// ============================================================================
// PER-TYPE NODE RENDERERS
// ============================================================================

/**
 * Action node — step card with a coloured header rule, assignee name, `user` glyph.
 */
function ActionNodeRender({
  data,
  selected,
  nodeColor,
}: {
  data: FlowNodeData
  selected: boolean
  nodeColor: string
}) {
  const t = useFlowEditorTheme()
  const meta = NODE_TYPE_META.action

  return (
    <div style={cardStyle(t, selected, t.accent)}>
      {/* Header — coloured bottom rule */}
      <div style={headerStyle(nodeColor)}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          {data.role && <AssigneeBadgeInline roleId={data.role} color={nodeColor} />}
        </div>
        <Ph name="user" size={15} color={nodeColor} />
      </div>

      {/* Body */}
      <div style={{ padding: "8px 20px 4px" }}>
        <Title color={t.text}>{data.label || meta.label}</Title>
        <Description color={t.nodeDescText}>{data.description}</Description>
      </div>

      <GatesSection data={data} />
      <Handles data={data} baseTop={50} />
    </div>
  )
}

/** Inline assignee name (for header, no avatar) */
function AssigneeBadgeInline({ roleId, color }: { roleId: string; color: string }) {
  const member = useWorkspaceMember(roleId)
  const name = member?.name || (roleId === "human" ? "Human" : roleId)
  return (
    <span
      style={{
        fontSize: 13,
        lineHeight: "18px",
        color,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {name}
    </span>
  )
}

/**
 * Function node — accent header wash, "Tools" + `cpu` glyph, "Auto" badge.
 */
function FunctionNodeRender({ data, selected }: { data: FlowNodeData; selected: boolean }) {
  const t = useFlowEditorTheme()
  return (
    <div style={cardStyle(t, selected, t.accent)}>
      {/* Header — accent wash */}
      <div style={headerStyle(t.accent, t.navActive)}>
        <span style={{ fontSize: 13, lineHeight: "18px", color: t.accent }}>Tools</span>
        <Ph name="cpu" size={15} color={t.accent} />
      </div>

      {/* Body */}
      <div style={{ padding: "8px 20px 4px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <Title color={t.text}>{data.label || "Function"}</Title>
          <span
            style={{
              fontSize: 9,
              lineHeight: "12px",
              letterSpacing: 1.3,
              textTransform: "uppercase",
              color: t.tint.i.tx,
              background: t.tint.i.bg,
              borderRadius: 100,
              padding: "2px 7px",
              flexShrink: 0,
            }}
          >
            Auto
          </span>
        </div>
        <Description color={t.nodeDescText}>{data.description}</Description>
      </div>

      <GatesSection data={data} />
      <Handles data={data} baseTop={50} />
    </div>
  )
}

/**
 * Gate node (start/end) — compact card with a centred label.
 */
function GateNodeRender({
  data,
  selected,
  nodeColor,
}: {
  data: FlowNodeData
  selected: boolean
  nodeColor: string
}) {
  const t = useFlowEditorTheme()
  const meta = NODE_TYPE_META[data.nodeType]
  return (
    <div
      style={{
        ...cardStyle(t, selected, nodeColor),
        width: undefined,
        minWidth: 140,
        padding: "0 22px",
        height: 56,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        borderRadius: 100,
      }}
    >
      <Ph name={meta.phIcon} size={14} color={nodeColor} weight="fill" />
      <span style={{ fontSize: 13, lineHeight: "18px", color: t.text, whiteSpace: "nowrap" }}>
        {data.label}
      </span>
      <Handles data={data} baseTop={12} />
    </div>
  )
}

/**
 * Pin node — small 24px circle on the tile wash.
 */
function PinNodeRender({ data, selected }: { data: FlowNodeData; selected: boolean }) {
  const t = useFlowEditorTheme()
  return (
    <div
      style={{
        background: t.pinNodeBg,
        border: `2px solid ${selected ? t.accent : t.pinNodeBorder}`,
        borderRadius: "50%",
        width: 24,
        height: 24,
        boxSizing: "border-box",
        boxShadow: t.nodeShadow,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        position: "relative",
        cursor: "grab",
      }}
    >
      <Ph name="circle" size={8} color={t.pinNodeIconColor} weight="fill" />
      <Handles data={data} baseTop={0} />
    </div>
  )
}

/**
 * Integration node — coloured header with the `plugs` glyph + integration name, "Integration" footer.
 */
function IntegrationNodeRender({
  data,
  selected,
  nodeColor,
}: {
  data: FlowNodeData
  selected: boolean
  nodeColor: string
}) {
  const t = useFlowEditorTheme()
  const meta = NODE_TYPE_META.integration

  return (
    <div style={cardStyle(t, selected, t.accent)}>
      {/* Header — coloured bottom rule */}
      <div style={headerStyle(nodeColor)}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          <Ph name="plugs" size={15} color={nodeColor} />
          <span
            style={{
              fontSize: 13,
              lineHeight: "18px",
              color: nodeColor,
              textTransform: "capitalize",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {(data.data?.integration as string) || "Integration"}
          </span>
        </div>
      </div>

      {/* Body */}
      <div style={{ padding: "8px 20px 4px" }}>
        <Title color={t.text}>{data.label || meta.label}</Title>
        <Description color={t.nodeDescText}>{data.description}</Description>
        <div style={{ display: "flex", justifyContent: "flex-end", padding: "8px 0 6px" }}>
          <span
            style={{
              fontFamily: t.fontMono,
              fontSize: 9,
              letterSpacing: 0.5,
              textTransform: "uppercase",
              color: t.nodeDescText,
            }}
          >
            Integration
          </span>
        </div>
      </div>

      <GatesSection data={data} />
      <Handles data={data} baseTop={50} />
    </div>
  )
}

// ============================================================================
// MAIN COMPONENT — dispatches to per-type renderers
// ============================================================================

function FlowNodeComponentInner({ data, selected }: NodeProps) {
  const nodeData = data as FlowNodeData
  const meta = NODE_TYPE_META[nodeData.nodeType]
  const nodeColor = nodeData.color || meta.color
  const isSelected = !!selected

  switch (nodeData.nodeType) {
    case "action":
      return <ActionNodeRender data={nodeData} selected={isSelected} nodeColor={nodeColor} />
    case "function":
      return <FunctionNodeRender data={nodeData} selected={isSelected} />
    case "start":
    case "end":
      return <GateNodeRender data={nodeData} selected={isSelected} nodeColor={nodeColor} />
    case "pin":
      return <PinNodeRender data={nodeData} selected={isSelected} />
    case "integration":
      return <IntegrationNodeRender data={nodeData} selected={isSelected} nodeColor={nodeColor} />
    default:
      return <ActionNodeRender data={nodeData} selected={isSelected} nodeColor={nodeColor} />
  }
}

export const FlowNodeComponent = memo(FlowNodeComponentInner)
