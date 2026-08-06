/**
 * Permission Controls Context — Renderer UX Guide v2 §8.
 *
 * Coordinates `withPermissionSupport` (provider) with `ToolCallCard`
 * (consumer). When the wrapped tool call enters `pending_permission`,
 * the HOC provides:
 *   • permissionRequestId, appId, toolName — needed by ControlsBar.
 *   • forceExpand — tells the card to render expanded by default
 *     regardless of its own `defaultExpanded` prop.
 *
 * The card reads this context inside its render and, if a request is
 * active, automatically:
 *   • opens its body (forceExpand),
 *   • renders <ControlsBar/> at the end of the body.
 *
 * This keeps individual renderers ignorant of the permission flow —
 * they don't need to import ControlsBar or thread permission props.
 */

import { createContext, useContext } from 'react';

export interface PermissionControlsValue {
  permissionRequestId: string;
  appId?: string;
  toolName: string;
  /** Force the card to render with body expanded. */
  forceExpand: boolean;
}

export const PermissionControlsContext = createContext<PermissionControlsValue | null>(null);

/** `null` when no active permission request — most renderings. */
export function usePermissionControls(): PermissionControlsValue | null {
  return useContext(PermissionControlsContext);
}
