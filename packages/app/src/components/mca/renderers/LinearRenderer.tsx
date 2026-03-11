/**
 * Linear MCA - Custom Tool Call Renderer
 *
 * Main entry point that delegates to specific sub-renderers based on tool name.
 */

import type React from 'react';

import type { ToolCallRendererProps } from '../types';
import { withPermissionSupport } from '../withPermissionSupport';
import {
  AddCommentRenderer,
  ArchiveIssueRenderer,
  DeleteIssueRenderer,
} from './linear/ActionsRenderer';

// Import sub-renderers
import {
  CreateIssueRenderer,
  GetIssueRenderer,
  ListIssuesRenderer,
  UpdateIssueRenderer,
} from './linear/IssuesRenderer';
import { AddLabelsToIssueRenderer, ListLabelsRenderer } from './linear/LabelsRenderer';

import { CreateProjectRenderer, ListProjectsRenderer } from './linear/ProjectsRenderer';
import { Badge, getShortToolName, HeaderRow } from './linear/shared';
import { ListTeamsRenderer, ListUsersRenderer } from './linear/TeamsUsersRenderer';
import { ListWorkflowStatesRenderer } from './linear/WorkflowRenderer';

// ============================================================================
// Tool Name to Renderer Mapping
// ============================================================================

const RENDERERS: Record<string, React.ComponentType<ToolCallRendererProps>> = {
  // Issues
  'linear-list-issues': ListIssuesRenderer,
  'linear-get-issue': GetIssueRenderer,
  'linear-create-issue': CreateIssueRenderer,
  'linear-update-issue': UpdateIssueRenderer,

  // Teams & Users
  'linear-list-teams': ListTeamsRenderer,
  'linear-list-users': ListUsersRenderer,

  // Projects
  'linear-list-projects': ListProjectsRenderer,
  'linear-create-project': CreateProjectRenderer,

  // Labels
  'linear-list-labels': ListLabelsRenderer,
  'linear-add-labels-to-issue': AddLabelsToIssueRenderer,

  // Workflow
  'linear-list-workflow-states': ListWorkflowStatesRenderer,

  // Actions
  'linear-delete-issue': DeleteIssueRenderer,
  'linear-archive-issue': ArchiveIssueRenderer,
  'linear-add-comment': AddCommentRenderer,
};

// ============================================================================
// Fallback Renderer
// ============================================================================

function FallbackRenderer({ toolName, status, duration }: ToolCallRendererProps) {
  const shortName = getShortToolName(toolName);

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="done" variant="success" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  return (
    <HeaderRow
      status={status}
      description={shortName}
      duration={duration}
      badge={badge}
      expanded={false}
      onToggle={() => {}}
    />
  );
}

// ============================================================================
// Main Renderer
// ============================================================================

function LinearRendererBase(props: ToolCallRendererProps) {
  const shortName = getShortToolName(props.toolName);
  const Renderer = RENDERERS[shortName] || FallbackRenderer;

  return <Renderer {...props} />;
}

export const LinearToolCallRenderer = withPermissionSupport(LinearRendererBase);
export default LinearToolCallRenderer;
