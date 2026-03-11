/**
 * Linear Renderer - Labels
 *
 * Handles: linear-list-labels, linear-add-labels-to-issue
 */

import type React from 'react';
import { useState } from 'react';
import { Text, View, XStack, YStack } from 'tamagui';

import type { ToolCallRendererProps } from '../../types';
import {
  Badge,
  colors,
  ErrorBlock,
  ExpandedBody,
  ExpandedContainer,
  HeaderRow,
  isSuccessMessage,
  type LinearLabel,
  parseOutput,
  SuccessBlock,
} from './shared';

// ============================================================================
// Content Blocks
// ============================================================================

function LabelListBlock({ labels }: { labels: LinearLabel[] }) {
  return (
    <XStack gap={6} flexWrap="wrap" padding={8} backgroundColor={colors.bgInner} borderRadius={5}>
      {labels.map((label) => (
        <XStack
          key={label.id}
          backgroundColor={label.color ? `${label.color}20` : colors.badgeInfo.bg}
          paddingHorizontal={6}
          paddingVertical={3}
          borderRadius={4}
          borderWidth={1}
          borderColor={label.color ? `${label.color}40` : 'rgba(255,255,255,0.1)'}
          alignItems="center"
          gap={4}
        >
          <View
            width={8}
            height={8}
            borderRadius={4}
            backgroundColor={label.color || colors.linearPurple}
          />
          <Text color={label.color || colors.primary} fontSize={10}>
            {label.name}
          </Text>
        </XStack>
      ))}
    </XStack>
  );
}

// ============================================================================
// Renderers
// ============================================================================

export function ListLabelsRenderer({
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);
  const parsed = output
    ? parseOutput<{ count?: number; labels?: LinearLabel[] } | LinearLabel[]>(output)
    : null;

  // Handle both { labels: [...] } and direct array formats
  const labels =
    parsed && typeof parsed === 'object' && 'labels' in parsed
      ? (parsed as { labels: LinearLabel[] }).labels
      : Array.isArray(parsed)
        ? parsed
        : null;
  const isLabelArray = Array.isArray(labels) && labels.length > 0 && 'name' in labels[0];

  let description = 'List labels';
  if (input?.teamId) description += ` (team)`;

  let badge: React.ReactNode = null;
  if (status === 'completed' && isLabelArray) {
    badge = <Badge text={`${labels!.length} labels`} variant="gray" />;
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
        {isLabelArray && <LabelListBlock labels={labels!} />}
        {error && <ErrorBlock error={error} />}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

export function AddLabelsToIssueRenderer({
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);
  const parsed = output ? parseOutput<string>(output) : null;
  const isSuccess = isSuccessMessage(parsed);

  const labelCount = input?.labelIds?.length || 0;
  const description = input?.issueId
    ? `Add ${labelCount} label${labelCount !== 1 ? 's' : ''} to ${input.issueId}`
    : 'Add labels to issue';

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
