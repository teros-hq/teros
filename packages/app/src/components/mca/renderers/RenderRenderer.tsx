/**
 * Render MCA - Custom Tool Call Renderer
 *
 * Main entry point that delegates to specific sub-renderers based on tool name.
 */

import type React from 'react';

import type { ToolCallRendererProps } from '../types';
import { withPermissionSupport } from '../withPermissionSupport';
import {
  DeleteServiceRenderer,
  GetLogsRenderer,
  RestartServiceRenderer,
  ResumeServiceRenderer,
  SuspendServiceRenderer,
  // Projects
  ListProjectsRenderer,
  GetProjectRenderer,
  CreateProjectRenderer,
  DeleteProjectRenderer,
  // Environments
  ListEnvironmentsRenderer,
  CreateEnvironmentRenderer,
  // User & Owners
  GetUserRenderer,
  ListOwnersRenderer,
} from './render/ActionsRenderer';
import {
  CancelDeployRenderer,
  GetDeployRenderer,
  ListDeploysRenderer,
  RollbackDeployRenderer,
  TriggerDeployRenderer,
} from './render/DeploymentsRenderer';
import {
  AddCustomDomainRenderer,
  AddDiskRenderer,
  DeleteCustomDomainRenderer,
  ListCustomDomainsRenderer,
  ListDisksRenderer,
  VerifyCustomDomainRenderer,
} from './render/DomainsRenderer';
import {
  CreateServiceRenderer,
  GetServiceRenderer,
  ListServicesRenderer,
} from './render/ServicesRenderer';
import { ToolCallCard } from '../primitives';
import { Badge, getShortToolName } from './render/shared';
import {
  DeleteEnvVarRenderer,
  ListEnvVarsRenderer,
  SetEnvVarsRenderer,
  UpdateEnvVarRenderer,
} from './render/VariablesRenderer';

// ============================================================================
// Tool Name to Renderer Mapping
// ============================================================================

const RENDERERS: Record<string, React.ComponentType<ToolCallRendererProps>> = {
  // User & Owners
  'render-get-user': GetUserRenderer,
  'render-list-owners': ListOwnersRenderer,

  // Projects
  'render-list-projects': ListProjectsRenderer,
  'render-get-project': GetProjectRenderer,
  'render-create-project': CreateProjectRenderer,
  'render-delete-project': DeleteProjectRenderer,

  // Environments
  'render-list-environments': ListEnvironmentsRenderer,
  'render-create-environment': CreateEnvironmentRenderer,

  // Services
  'render-list-services': ListServicesRenderer,
  'render-get-service': GetServiceRenderer,
  'render-create-service': CreateServiceRenderer,
  'render-delete-service': DeleteServiceRenderer,
  'render-suspend-service': SuspendServiceRenderer,
  'render-resume-service': ResumeServiceRenderer,
  'render-restart-service': RestartServiceRenderer,

  // Deploys
  'render-list-deploys': ListDeploysRenderer,
  'render-get-deploy': GetDeployRenderer,
  'render-trigger-deploy': TriggerDeployRenderer,
  'render-cancel-deploy': CancelDeployRenderer,
  'render-rollback-deploy': RollbackDeployRenderer,

  // Env Vars
  'render-list-env-vars': ListEnvVarsRenderer,
  'render-set-env-vars': SetEnvVarsRenderer,
  'render-update-env-var': UpdateEnvVarRenderer,
  'render-delete-env-var': DeleteEnvVarRenderer,

  // Custom Domains
  'render-list-custom-domains': ListCustomDomainsRenderer,
  'render-add-custom-domain': AddCustomDomainRenderer,
  'render-delete-custom-domain': DeleteCustomDomainRenderer,
  'render-verify-custom-domain': VerifyCustomDomainRenderer,

  // Disks
  'render-list-disks': ListDisksRenderer,
  'render-add-disk': AddDiskRenderer,

  // Logs
  'render-get-logs': GetLogsRenderer,
};

// ============================================================================
// Fallback Renderer
// ============================================================================

function FallbackRenderer({ toolName, status, appIcon }: ToolCallRendererProps) {
  const shortName = getShortToolName(toolName);

  if (__DEV__) {
    // eslint-disable-next-line no-console
    console.warn(
      `[RenderRenderer] missing dedicated renderer for tool: ${toolName}. ` +
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

function RenderRendererBase(props: ToolCallRendererProps) {
  const shortName = getShortToolName(props.toolName);
  const Renderer = RENDERERS[shortName] || FallbackRenderer;

  return <Renderer {...props} />;
}

export const RenderToolCallRenderer = withPermissionSupport(RenderRendererBase);
export default RenderToolCallRenderer;
