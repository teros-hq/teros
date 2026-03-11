/**
 * Linear Renderer - Actions
 *
 * Handles: linear-delete-issue, linear-archive-issue, linear-add-comment
 */

import type React from 'react';
import { useState } from 'react';

import type { ToolCallRendererProps } from '../../types';
import {
  Badge,
  ErrorBlock,
  ExpandedBody,
  ExpandedContainer,
  HeaderRow,
  isSuccessMessage,
  parseOutput,
  SuccessBlock,
  truncate,
} from './shared';

// ============================================================================
// Renderers
// ============================================================================

export function DeleteIssueRenderer({
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);
  const parsed = output ? parseOutput<string>(output) : null;
  const isSuccess = isSuccessMessage(parsed);

  const description = input?.issueId ? `Delete ${input.issueId}` : 'Delete issue';

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="deleted" variant="error" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  const headerProps = {
    status,
    description,
    duration,
    badge,
    expanded,
    onToggle: () => setExpanded(!expanded),
  };

  if (!expanded) return <HeaderRow {...headerProps} />;

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        {isSuccess && typeof parsed === 'string' && <SuccessBlock message={parsed} />}
        {error && <ErrorBlock error={error} />}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

export function ArchiveIssueRenderer({
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);
  const parsed = output ? parseOutput<string>(output) : null;
  const isSuccess = isSuccessMessage(parsed);

  const description = input?.issueId ? `Archive ${input.issueId}` : 'Archive issue';

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="archived" variant="warning" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  const headerProps = {
    status,
    description,
    duration,
    badge,
    expanded,
    onToggle: () => setExpanded(!expanded),
  };

  if (!expanded) return <HeaderRow {...headerProps} />;

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        {isSuccess && typeof parsed === 'string' && <SuccessBlock message={parsed} />}
        {error && <ErrorBlock error={error} />}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

export function AddCommentRenderer({
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);
  const parsed = output ? parseOutput<string>(output) : null;
  const isSuccess = isSuccessMessage(parsed);

  let description = input?.issueId ? `Comment on ${input.issueId}` : 'Add comment';
  if (input?.body) {
    description += `: ${truncate(input.body, 30)}`;
  }

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="added" variant="success" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  const headerProps = {
    status,
    description,
    duration,
    badge,
    expanded,
    onToggle: () => setExpanded(!expanded),
  };

  if (!expanded) return <HeaderRow {...headerProps} />;

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        {isSuccess && typeof parsed === 'string' && <SuccessBlock message={parsed} />}
        {error && <ErrorBlock error={error} />}
      </ExpandedBody>
    </ExpandedContainer>
  );
}
