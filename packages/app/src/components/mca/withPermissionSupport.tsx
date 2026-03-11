/**
 * Higher-Order Component for Permission Support
 *
 * Wraps any custom renderer to handle pending_permission status.
 * When a tool requires permission, shows the custom renderer (as "running")
 * with the permission widget below it.
 *
 * Usage:
 *   const MyRenderer = withPermissionSupport(MyRendererBase);
 */

import type React from 'react';
import { YStack } from 'tamagui';
import { PermissionRequestWidget } from './PermissionRequestWidget';
import type { ToolCallRendererProps } from './types';

export function withPermissionSupport<P extends ToolCallRendererProps>(
  WrappedRenderer: React.ComponentType<P>,
): React.ComponentType<P> {
  const displayName = WrappedRenderer.displayName || WrappedRenderer.name || 'Component';

  function RendererWithPermission(props: P) {
    // For permission requests, show the custom renderer as "running"
    // with the permission widget below
    if (props.status === 'pending_permission' && props.permissionRequestId) {
      return (
        <YStack gap={0}>
          <WrappedRenderer {...props} status="running" />
          <PermissionRequestWidget
            permissionRequestId={props.permissionRequestId}
            appId={props.appId}
            toolName={props.toolName}
            input={props.input}
          />
        </YStack>
      );
    }

    return <WrappedRenderer {...props} />;
  }

  RendererWithPermission.displayName = `withPermissionSupport(${displayName})`;

  return RendererWithPermission;
}
