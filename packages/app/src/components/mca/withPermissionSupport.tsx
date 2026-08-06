/**
 * withPermissionSupport — Renderer UX Guide v2 §8.
 *
 * HOC that owns the tool-permission flow for ANY tool-call renderer,
 * independent of which primitives the renderer composes. When a tool is in
 * `pending_permission`:
 *   • Provides `PermissionControlsContext` so a `ToolCallCard` inside the
 *     renderer auto-expands (`forceExpand`) and stays open.
 *   • Renders the single-line `ControlsBar` (Deny / Allow / always menu)
 *     immediately AFTER the renderer's output.
 *
 * The ControlsBar lives HERE — not inside `ToolCallCard` — because the
 * permission gate is a cross-cutting concern keyed on the tool's
 * `pending_permission` status, not on the renderer's choice of layout
 * primitives. Renderers that compose `HeaderRow`/`ExpandedContainer`
 * directly (instead of `ToolCallCard`) therefore still show the widget.
 * This HOC is applied centrally by `McaRegistry` so every registered MCA —
 * and the default renderer — gets it automatically.
 *
 * Idempotent: if an outer `withPermissionSupport` already provided the
 * context (e.g. registry-applied AND a legacy per-renderer self-wrap), the
 * inner instance becomes a transparent pass-through — the outermost wrapper
 * owns the single ControlsBar. Double-wrapping is therefore safe.
 *
 * Grouping (TER-375): when this tool's `permissionRequestId` is part of a
 * parallel group (≥2 consecutive pending tools), the run's single
 * `GroupedPermissionPanel` — rendered by ChatView at the group anchor — owns the
 * Allow/Deny flow. Here we still provide `PermissionControlsContext` so the
 * card auto-expands, but we suppress this card's own per-card `ControlsBar`.
 */

import type React from 'react';
import { useContext } from 'react';
import { View } from 'react-native';
import { ControlsBar } from './primitives/ControlsBar';
import { PermissionControlsContext } from './primitives/PermissionControlsContext';
import { PermissionGroupContext } from './primitives/PermissionGroupContext';
import type { ToolCallRendererProps } from './types';

export function withPermissionSupport<P extends ToolCallRendererProps>(
  WrappedRenderer: React.ComponentType<P>,
): React.ComponentType<P> {
  const displayName = WrappedRenderer.displayName || WrappedRenderer.name || 'Component';

  function RendererWithPermission(props: P) {
    // Idempotency guard: a non-null context means an outer wrapper already
    // owns the permission flow for this subtree — don't provide it (or the
    // ControlsBar) twice.
    const alreadyOwned = useContext(PermissionControlsContext) !== null;
    // When this request belongs to a parallel group, the GroupedPermissionPanel
    // owns Allow/Deny — suppress the per-card bar (but keep forceExpand).
    const groupedRequestIds = useContext(PermissionGroupContext);
    const pending = props.status === 'pending_permission' && !!props.permissionRequestId;
    const isGrouped = pending && !!groupedRequestIds?.has(props.permissionRequestId as string);

    if (pending && !alreadyOwned) {
      return (
        <PermissionControlsContext.Provider
          value={{
            permissionRequestId: props.permissionRequestId as string,
            appId: props.appId,
            toolName: props.toolName,
            forceExpand: true,
          }}
        >
          <WrappedRenderer {...props} />
          {/* Grouped tools defer Allow/Deny to the run's single
              GroupedPermissionPanel; only render the per-card bar when standalone.
              marginTop -1 overlaps the card's bottom border so the bar reads
              as an attached footer of the tool card, not a detached element. */}
          {!isGrouped && (
            <View style={{ marginTop: -1 }}>
              <ControlsBar
                permissionRequestId={props.permissionRequestId as string}
                appId={props.appId}
                toolName={props.toolName}
              />
            </View>
          )}
        </PermissionControlsContext.Provider>
      );
    }

    return <WrappedRenderer {...props} />;
  }

  RendererWithPermission.displayName = `withPermissionSupport(${displayName})`;
  return RendererWithPermission;
}
