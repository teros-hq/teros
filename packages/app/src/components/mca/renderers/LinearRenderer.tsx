/**
 * Linear MCA — Tool Call Renderer entry point.
 *
 * Dispatches each tool call to a dedicated sub-renderer by short name.
 * 20/20 tools covered. `FallbackRenderer` is a dev-only warning signalling
 * a missing entry in the RENDERERS map — in production it should never
 * render.
 */

import type React from 'react';
import { Text, YStack } from 'tamagui';

import {
  Badge,
  colors as globalColors,
  FallbackBody,
  ToolCallCard,
} from '../primitives';
import { HealthCheckRenderer } from './linear/HealthCheckRenderer';
import {
  AddCommentRenderer,
  ArchiveIssueRenderer,
  CreateIssueRenderer,
  DeleteIssueRenderer,
  GetIssueRenderer,
  ListIssuesRenderer,
  UpdateIssueRenderer,
} from './linear/IssuesRenderer';
import {
  AddLabelsToIssueRenderer,
  CreateLabelRenderer,
  DeleteLabelRenderer,
  ListLabelsRenderer,
  RemoveLabelsFromIssueRenderer,
  UpdateLabelRenderer,
} from './linear/LabelsRenderer';
import {
  AddIssuesToProjectRenderer,
  CreateProjectRenderer,
  DeleteProjectRenderer,
  ListProjectsRenderer,
  RemoveIssuesFromProjectRenderer,
} from './linear/ProjectsRenderer';
import {
  getShortToolName,
  getToolLabel,
  LINEAR_ICON,
  toolStatusForPrimitive,
} from './linear/shared';
import { ListTeamsRenderer, ListUsersRenderer } from './linear/TeamsUsersRenderer';
import { ListWorkflowStatesRenderer } from './linear/WorkflowRenderer';
import type { ToolCallRendererProps } from '../types';
import { withPermissionSupport } from '../withPermissionSupport';

// ============================================================================
// Registry — 20/20 coverage
// ============================================================================

const RENDERERS: Record<string, React.ComponentType<ToolCallRendererProps>> = {
  // Health (SDK contract — shipped in every MCA)
  '-health-check': HealthCheckRenderer,
  // Issues
  'linear-list-issues': ListIssuesRenderer,
  'linear-get-issue': GetIssueRenderer,
  'linear-create-issue': CreateIssueRenderer,
  'linear-update-issue': UpdateIssueRenderer,
  'linear-delete-issue': DeleteIssueRenderer,
  'linear-archive-issue': ArchiveIssueRenderer,
  'linear-add-comment': AddCommentRenderer,
  // Projects
  'linear-list-projects': ListProjectsRenderer,
  'linear-create-project': CreateProjectRenderer,
  'linear-delete-project': DeleteProjectRenderer,
  'linear-add-issues-to-project': AddIssuesToProjectRenderer,
  'linear-remove-issues-from-project': RemoveIssuesFromProjectRenderer,
  // Labels
  'linear-list-labels': ListLabelsRenderer,
  'linear-create-label': CreateLabelRenderer,
  'linear-update-label': UpdateLabelRenderer,
  'linear-delete-label': DeleteLabelRenderer,
  'linear-add-labels-to-issue': AddLabelsToIssueRenderer,
  'linear-remove-labels-from-issue': RemoveLabelsFromIssueRenderer,
  // Teams / users / workflow
  'linear-list-teams': ListTeamsRenderer,
  'linear-list-users': ListUsersRenderer,
  'linear-list-workflow-states': ListWorkflowStatesRenderer,
};

// ============================================================================
// FallbackRenderer — dev-only warning
// ============================================================================

function FallbackRenderer({ toolName, input, status, output, error }: ToolCallRendererProps) {
  const shortName = getShortToolName(toolName);

  const badge = __DEV__ ? (
    <Badge text="no renderer" variant="error" />
  ) : status === 'completed' ? (
    <Badge text="done" variant="success" />
  ) : status === 'failed' ? (
    <Badge text="failed" variant="error" />
  ) : null;

  return (
    <ToolCallCard
      status={toolStatusForPrimitive(status)}
      verb={getToolLabel(toolName)}
      iconUri={LINEAR_ICON}
      badge={badge}
      animateExpand
    >
      {__DEV__ && (
        <YStack
          backgroundColor="rgba(239,68,68,0.12)"
          borderRadius={5}
          padding={8}
          borderWidth={1}
          borderColor="rgba(239,68,68,0.3)"
          gap={2}
          marginBottom={6}
        >
          <Text color={globalColors.badgeError.text} fontSize={10} fontWeight="600">
            [dev] Missing sub-renderer for "{shortName}"
          </Text>
          <Text color={globalColors.secondary} fontSize={9}>
            Register it in the RENDERERS map in LinearRenderer.tsx.
          </Text>
        </YStack>
      )}
      <FallbackBody status={status} input={input} output={output} error={error} />
    </ToolCallCard>
  );
}

// ============================================================================
// Entry point
// ============================================================================

function LinearRendererBase(props: ToolCallRendererProps) {
  const shortName = getShortToolName(props.toolName);
  const Renderer = RENDERERS[shortName] ?? FallbackRenderer;
  return <Renderer {...props} />;
}

export const LinearToolCallRenderer = withPermissionSupport(LinearRendererBase);
export default LinearToolCallRenderer;
