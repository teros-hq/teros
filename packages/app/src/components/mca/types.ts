/**
 * MCA UI Component Types
 *
 * Defines the interface for MCA-provided UI components
 */

import { type ComponentType, createContext, useContext } from 'react';
import type { McaStatusType } from './primitives/colors';

/**
 * Tool execution status (alias of `McaStatusType` — single source of truth
 * lives in `primitives/colors.ts`).
 *
 * - pending: initial state, waiting for permission check or waiting for previous tool to complete
 * - running: currently executing (shown with spinner)
 * - pending_permission: waiting for user approval (shown with approval widget)
 * - completed: finished successfully
 * - failed: finished with error
 */
export type ToolStatus = McaStatusType;

/**
 * Props passed to custom ToolCall renderers
 */
export interface ToolCallRendererProps {
  toolCallId: string;
  toolName: string;
  input?: Record<string, any>;
  status: ToolStatus;
  output?: string;
  error?: string;
  /**
   * @deprecated Renderer UX Guide v2 §7 prohibits showing duration in
   * the header. Kept for backwards compatibility — the prop still
   * arrives but `ToolCallCard` / `HeaderRow` ignore it. Do not pass
   * it from new renderers. Will be removed once the 16 sub-issues of
   * Follow-up E migrate (target 2026-10-01).
   */
  duration?: number;

  // App info
  mcaId?: string;
  appIcon?: string;

  // Permission-related props (when status === 'pending_permission')
  appId?: string;
  permissionRequestId?: string;

  /**
   * Binary irreversibility marker (Renderer UX Guide v2 §8). Sourced from
   * `manifest.tools[toolName].annotations.irreversible`. Surfaces an
   * Irreversibility Indicator badge in the header. Either present or
   * absent — no risk levels.
   */
  irreversible?: boolean;

  /** Attachments from tool execution (images, files, etc.) — rendered inline */
  attachments?: Array<{ url: string; mime: string; filename?: string }>;
}

/**
 * Permission callbacks provided via context
 */
export interface PermissionContextValue {
  /** Grant permission for this execution only */
  onGrant: (requestId: string) => void;
  /** Grant permission and set tool to 'allow' permanently */
  onGrantAlways: (requestId: string, appId: string, toolName: string) => void;
  /** Deny permission for this execution only */
  onDeny: (requestId: string) => void;
  /** Deny permission and set tool to 'deny' permanently */
  onDenyAlways: (requestId: string, appId: string, toolName: string) => void;
}

/**
 * Context for permission callbacks
 * Allows renderers to handle permission requests without prop drilling
 */
export const PermissionContext = createContext<PermissionContextValue | null>(null);

/**
 * Hook to access permission callbacks
 */
export function usePermissionCallbacks(): PermissionContextValue | null {
  return useContext(PermissionContext);
}

/**
 * A React component that renders a tool call
 */
export type ToolCallRendererComponent = ComponentType<ToolCallRendererProps>;

/**
 * MCA UI configuration from manifest.json
 */
export interface McaUiConfig {
  enabled: boolean;
  toolCallRenderer?: string; // Path to the renderer component
}

/**
 * Registered MCA with its UI components
 */
export interface RegisteredMca {
  mcaId: string;
  name: string;
  toolNames: string[];
  ToolCallRenderer?: ToolCallRendererComponent;
}
