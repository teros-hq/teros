/**
 * FlowEditorContext — Shared context for the flow editor
 *
 * React Flow renders custom nodes in isolation — they don't have access
 * to the parent component's state. This context bridges that gap, allowing
 * node components to look up artifact metadata (color, icon, name) for
 * rendering Flowing-style gate visuals, and workspace member info for
 * rendering assignee avatars on action nodes.
 *
 * Provided by FlowEditorWindowContent, consumed by FlowNodeComponent.
 */

import { createContext, useContext } from 'react';
import type { Artifact } from '@teros/workflows';
import type { AgentMapEntry } from '../BoardWindow/board-utils';

export interface FlowEditorContextValue {
  /** All available artifacts for gate type lookup */
  artifacts: Artifact[];
  /** Workspace members (agents + humans) for assignee avatar lookup */
  workspaceMembers: Record<string, AgentMapEntry>;
}

export const FlowEditorContext = createContext<FlowEditorContextValue>({
  artifacts: [],
  workspaceMembers: {},
});

export function useFlowEditorContext(): FlowEditorContextValue {
  return useContext(FlowEditorContext);
}

/**
 * Look up an artifact by its artifactId (schemaId).
 * Returns null if not found or if schemaId is null (signal-only gate).
 */
export function useArtifact(schemaId: string | null): Artifact | null {
  const { artifacts } = useFlowEditorContext();
  if (!schemaId) return null;
  return artifacts.find((a) => a.artifactId === schemaId) ?? null;
}

/**
 * Look up a workspace member by their ID (agentId or userId).
 * Returns null if not found.
 */
export function useWorkspaceMember(memberId: string | null | undefined): AgentMapEntry | null {
  const { workspaceMembers } = useFlowEditorContext();
  if (!memberId) return null;
  return workspaceMembers[memberId] ?? null;
}
