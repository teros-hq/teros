/**
 * Railway MCA - Custom Tool Call Renderer
 *
 * Main entry point that delegates to specific sub-renderers based on tool name.
 */

import type React from 'react';

import type { ToolCallRendererProps } from '../types';
import { withPermissionSupport } from '../withPermissionSupport';
import {
  ConnectRepoRenderer,
  CreateEnvironmentRenderer,
  CreateProjectRenderer,
  CreateServiceRenderer,
  CreateVolumeRenderer,
  DeleteProjectRenderer,
  DeleteServiceRenderer,
  DeployPublicRepoRenderer,
} from './railway/ActionsRenderer';
import {
  GetBuildLogsRenderer,
  GetDeployLogsRenderer,
  GetDeploymentRenderer,
  ListDeploymentsRenderer,
  RedeployRenderer,
} from './railway/DeploymentsRenderer';
import { CreateDomainRenderer, ListDomainsRenderer } from './railway/DomainsRenderer';
import {
  GetProjectRenderer,
  GetUserRenderer,
  ListEnvironmentsRenderer,
  ListProjectsRenderer,
  ListServicesRenderer,
  ListWorkspacesRenderer,
} from './railway/ServicesRenderer';
import { ToolCallCard } from '../primitives';
import { Badge, getShortToolName } from './railway/shared';
import { ListVariablesRenderer, SetVariablesRenderer } from './railway/VariablesRenderer';

// ============================================================================
// Tool Name to Renderer Mapping
// ============================================================================

const RENDERERS: Record<string, React.ComponentType<ToolCallRendererProps>> = {
  // User & Workspaces
  'railway-get-user': GetUserRenderer,
  'railway-list-workspaces': ListWorkspacesRenderer,

  // Projects
  'railway-list-projects': ListProjectsRenderer,
  'railway-get-project': GetProjectRenderer,
  'railway-create-project': CreateProjectRenderer,
  'railway-delete-project': DeleteProjectRenderer,

  // Environments
  'railway-list-environments': ListEnvironmentsRenderer,
  'railway-create-environment': CreateEnvironmentRenderer,

  // Services
  'railway-list-services': ListServicesRenderer,
  'railway-create-service': CreateServiceRenderer,
  'railway-delete-service': DeleteServiceRenderer,

  // Variables
  'railway-list-variables': ListVariablesRenderer,
  'railway-set-variables': SetVariablesRenderer,

  // Deployments
  'railway-list-deployments': ListDeploymentsRenderer,
  'railway-get-deployment': GetDeploymentRenderer,
  'railway-redeploy': RedeployRenderer,

  // Domains
  'railway-list-domains': ListDomainsRenderer,
  'railway-create-domain': CreateDomainRenderer,

  // GitHub
  'railway-connect-repo': ConnectRepoRenderer,
  'railway-deploy-public-repo': DeployPublicRepoRenderer,

  // Volumes
  'railway-create-volume': CreateVolumeRenderer,

  // Logs
  'railway-get-build-logs': GetBuildLogsRenderer,
  'railway-get-deploy-logs': GetDeployLogsRenderer,
};

// ============================================================================
// Fallback Renderer
// ============================================================================

function FallbackRenderer({ toolName, status, appIcon }: ToolCallRendererProps) {
  const shortName = getShortToolName(toolName);

  if (__DEV__) {
    // eslint-disable-next-line no-console
    console.warn(
      `[RailwayRenderer] missing dedicated renderer for tool: ${toolName}. ` +
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

// ============================================================================
// Main Renderer
// ============================================================================

function RailwayRendererBase(props: ToolCallRendererProps) {
  const shortName = getShortToolName(props.toolName);
  const Renderer = RENDERERS[shortName] || FallbackRenderer;

  return <Renderer {...props} />;
}

export const RailwayToolCallRenderer = withPermissionSupport(RailwayRendererBase);
export default RailwayToolCallRenderer;
