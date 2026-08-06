/**
 * Netlify MCA - Custom Tool Call Renderer
 *
 * Dispatches to a dedicated sub-renderer per tool. 100% coverage — the
 * FallbackRenderer is a dev-only signal of a missing renderer (bug), never a
 * production path.
 *
 * Tools:
 * - deploy-site: deploy result with the public URL (the star)
 * - list-sites: site list
 * - get-deploy-status: deploy state
 * - -health-check: token/connectivity check
 */

import type React from 'react';
import { Badge, ToolCallCard } from '../primitives';
import type { ToolCallRendererProps } from '../types';
import { withPermissionSupport } from '../withPermissionSupport';
import { DeployResultRenderer } from './netlify/DeployResultRenderer';
import { DeployStatusRenderer } from './netlify/DeployStatusRenderer';
import { HealthCheckRenderer } from './netlify/HealthCheckRenderer';
import { getShortToolName } from './netlify/shared';
import { SitesListRenderer } from './netlify/SitesListRenderer';
import { getNetlifyPermissionDescription } from './netlify-permission-description';

const RENDERERS: Record<string, React.ComponentType<ToolCallRendererProps>> = {
  'deploy-site': DeployResultRenderer,
  'list-sites': SitesListRenderer,
  'get-deploy-status': DeployStatusRenderer,
  '-health-check': HealthCheckRenderer,
};

function FallbackRenderer({ toolName, status, appIcon }: ToolCallRendererProps) {
  const shortName = getShortToolName(toolName);

  if (__DEV__) {
    // eslint-disable-next-line no-console
    console.warn(
      `[NetlifyRenderer] missing dedicated renderer for tool: ${toolName}. ` +
        'Add a sub-renderer and register it in RENDERERS.',
    );
  }

  const badge =
    status === 'completed' ? (
      <Badge text="done (fallback)" variant="warning" />
    ) : status === 'failed' ? (
      <Badge text="failed" variant="error" />
    ) : null;

  return (
    <ToolCallCard
      status={status}
      description={`${shortName.replace(/-/g, ' ')} (no renderer)`}
      badge={badge}
      iconUri={appIcon}
    />
  );
}

function NetlifyRendererBase(props: ToolCallRendererProps) {
  const shortName = getShortToolName(props.toolName);

  // Permission flow (Renderer UX Guide v2 §8): while the tool awaits the user's
  // grant, surface a tool-specific, security-aware description instead of the
  // result UI — deploy-site warns that the content becomes PUBLIC. The
  // Allow/Deny ControlsBar is mounted by withPermissionSupport around this.
  if (props.status === 'pending_permission') {
    const description = getNetlifyPermissionDescription(shortName, props.input);
    if (description) {
      return (
        <ToolCallCard status="pending_permission" description={description} iconUri={props.appIcon} />
      );
    }
  }

  const Renderer = RENDERERS[shortName] || FallbackRenderer;
  return <Renderer {...props} />;
}

export const NetlifyToolCallRenderer = withPermissionSupport(NetlifyRendererBase);
export default NetlifyToolCallRenderer;
