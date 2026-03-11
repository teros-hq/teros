/**
 * MCA UI Component Types
 *
 * Defines the interface for MCA-provided UI components
 */

import { type ComponentType, createContext, useContext } from 'react';

/**
 * Tool execution status
 * - pending: initial state, waiting for permission check or waiting for previous tool to complete
 * - running: currently executing (shown with spinner)
 * - pending_permission: waiting for user approval (shown with approval widget)
 * - completed: finished successfully
 * - failed: finished with error
 */
export type ToolStatus = 'pending' | 'running' | 'completed' | 'failed' | 'pending_permission';

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
  duration?: number;

  // App info
  mcaId?: string;
  appIcon?: string;

  // Permission-related props (when status === 'pending_permission')
  appId?: string;
  permissionRequestId?: string;
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
