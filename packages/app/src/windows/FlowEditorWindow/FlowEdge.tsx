/**
 * FlowEdge — Flowing-style thick edge with border for React Flow
 *
 * Renders edges as two stacked SVG paths:
 *   1. A 5px dark "background" stroke (the border) — shade-500 equivalent
 *   2. A 3px light "foreground" stroke (the main line) — shade-300 equivalent
 *
 * This creates the thick "bordered" edge look from Flowing/HexaFlows.
 * Uses smoothstep paths with borderRadius=24 for the rounded corners.
 *
 * The edge color is derived from the artifact/schema color of the connection.
 * Flowing uses shade-500 for background and shade-300 for foreground.
 */

import { memo } from 'react';
import {
  type EdgeProps,
  getSmoothStepPath,
} from '@xyflow/react';
import { resolveEdgeColors } from './flowingColors';

// ============================================================================
// COMPONENT
// ============================================================================

function FlowEdgeInner(props: EdgeProps) {
  const {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    style = {},
    selected,
  } = props;

  // Get the edge color from edge data, default to slate
  const baseColor = (props.data?.color as string) || null;
  const { light: lightColor, dark: darkColor } = resolveEdgeColors(baseColor);

  // Adjusted coordinates — Flowing moves edge endpoints ±6px closer to nodes
  const getAdjustedSourceCoords = () => {
    if (sourcePosition === 'right') return { x: Math.round(sourceX) - 6, y: Math.round(sourceY) };
    if (sourcePosition === 'left') return { x: Math.round(sourceX) + 6, y: Math.round(sourceY) };
    if (sourcePosition === 'top') return { x: Math.round(sourceX), y: Math.round(sourceY) + 6 };
    if (sourcePosition === 'bottom') return { x: Math.round(sourceX), y: Math.round(sourceY) - 6 };
    return { x: Math.round(sourceX), y: Math.round(sourceY) };
  };

  const getAdjustedTargetCoords = () => {
    if (targetPosition === 'right') return { x: Math.round(targetX) - 6, y: Math.round(targetY) };
    if (targetPosition === 'left') return { x: Math.round(targetX) + 6, y: Math.round(targetY) };
    if (targetPosition === 'top') return { x: Math.round(targetX), y: Math.round(targetY) + 6 };
    if (targetPosition === 'bottom') return { x: Math.round(targetX), y: Math.round(targetY) - 6 };
    return { x: Math.round(targetX), y: Math.round(targetY) };
  };

  const adjustedSource = getAdjustedSourceCoords();
  const adjustedTarget = getAdjustedTargetCoords();

  // Calculate the smoothstep path with rounded corners
  const [edgePath] = getSmoothStepPath({
    sourceX: adjustedSource.x,
    sourceY: adjustedSource.y,
    sourcePosition,
    targetX: adjustedTarget.x,
    targetY: adjustedTarget.y,
    targetPosition,
    borderRadius: 24,
  });

  return (
    <>
      {/* Background path — thick dark stroke (the "border") */}
      <path
        id={`${id}-bg`}
        className="react-flow__edge-path"
        d={edgePath}
        style={{
          stroke: darkColor,
          strokeWidth: selected ? 7 : 5,
          fill: 'none',
          ...style,
        }}
      />
      {/* Foreground path — thinner light stroke (the main line) */}
      <path
        id={id}
        className="react-flow__edge-path"
        d={edgePath}
        style={{
          stroke: lightColor,
          strokeWidth: selected ? 4 : 3,
          fill: 'none',
          ...style,
        }}
      />
      {/* Transparent wide path for easier click/interaction */}
      <path
        d={edgePath}
        style={{
          stroke: 'transparent',
          strokeWidth: 14,
          fill: 'transparent',
        }}
      />
    </>
  );
}

export const FlowEdge = memo(FlowEdgeInner);
