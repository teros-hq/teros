/**
 * Linear Renderer - Issues
 *
 * Handles: linear-list-issues, linear-get-issue, linear-create-issue, linear-update-issue
 */

import { ExternalLink, UserCircle, Users } from '@tamagui/lucide-icons';
import type React from 'react';
import { useState } from 'react';
import { Linking, ScrollView } from 'react-native';
import { Text, View, XStack, YStack } from 'tamagui';

import type { ToolCallRendererProps } from '../../types';
import {
  Badge,
  colors,
  ErrorBlock,
  ExpandedBody,
  ExpandedContainer,
  HeaderRow,
  IssueStatusBadge,
  isSuccessMessage,
  type LinearIssue,
  PriorityBadge,
  parseOutput,
  SuccessBlock,
  truncate,
} from './shared';

// ============================================================================
// Content Blocks
// ============================================================================

interface IssueListBlockProps {
  issues: LinearIssue[];
  highlightId?: string;
}

function IssueListBlock({ issues, highlightId }: IssueListBlockProps) {
  return (
    <ScrollView
      style={{ maxHeight: 300, backgroundColor: colors.bgInner, borderRadius: 5 }}
      showsVerticalScrollIndicator={true}
    >
      <YStack paddingVertical={4}>
        {issues.map((issue) => {
          const isHighlighted = issue.id === highlightId;
          return (
            <XStack
              key={issue.id}
              alignItems="center"
              gap={8}
              paddingVertical={5}
              paddingHorizontal={8}
              backgroundColor={isHighlighted ? 'rgba(94,106,210,0.1)' : 'transparent'}
              hoverStyle={{ backgroundColor: 'rgba(255,255,255,0.02)' }}
              cursor="pointer"
              onPress={() => issue.url && Linking.openURL(issue.url)}
            >
              <Text color={colors.linearPurple} fontSize={9} fontFamily="$mono" width={50}>
                {issue.identifier}
              </Text>
              <Text
                flex={1}
                color={isHighlighted ? colors.linearPurple : colors.primary}
                fontSize={10}
                fontWeight={isHighlighted ? '600' : '400'}
                numberOfLines={1}
              >
                {issue.title}
              </Text>
              <IssueStatusBadge status={issue.status} />
              <PriorityBadge priority={issue.priority} />
            </XStack>
          );
        })}
      </YStack>
    </ScrollView>
  );
}

interface IssueDetailBlockProps {
  issue: LinearIssue;
  variant?: 'created' | 'updated' | 'default';
}

function IssueDetailBlock({ issue, variant = 'default' }: IssueDetailBlockProps) {
  const bgColors = {
    created: 'rgba(34,197,94,0.1)',
    updated: 'rgba(94,106,210,0.1)',
    default: colors.bgInner,
  };

  return (
    <YStack
      backgroundColor={bgColors[variant]}
      borderRadius={5}
      paddingVertical={8}
      paddingHorizontal={10}
      gap={6}
    >
      {/* Header with identifier and title */}
      <XStack alignItems="center" gap={8}>
        <Text color={colors.linearPurple} fontSize={10} fontFamily="$mono" fontWeight="600">
          {issue.identifier}
        </Text>
        <Text flex={1} color={colors.bright} fontSize={11} fontWeight="500" numberOfLines={2}>
          {issue.title}
        </Text>
        {issue.url && (
          <XStack
            cursor="pointer"
            onPress={() => Linking.openURL(issue.url!)}
            hoverStyle={{ opacity: 0.7 }}
          >
            <ExternalLink size={12} color={colors.secondary} />
          </XStack>
        )}
      </XStack>

      {/* Status and Priority row */}
      <XStack gap={8} alignItems="center">
        <IssueStatusBadge status={issue.status} />
        <PriorityBadge priority={issue.priority} />
        {issue.assignee && (
          <XStack alignItems="center" gap={4}>
            <UserCircle size={10} color={colors.secondary} />
            <Text color={colors.secondary} fontSize={9}>
              {issue.assignee}
            </Text>
          </XStack>
        )}
        {issue.team && (
          <XStack alignItems="center" gap={4}>
            <Users size={10} color={colors.secondary} />
            <Text color={colors.secondary} fontSize={9}>
              {issue.team}
            </Text>
          </XStack>
        )}
      </XStack>

      {/* Labels */}
      {issue.labels && issue.labels.length > 0 && (
        <XStack gap={4} flexWrap="wrap">
          {issue.labels.map((label, idx) => (
            <View key={idx}>
              <Badge text={label} variant="info" />
            </View>
          ))}
        </XStack>
      )}

      {/* Description preview */}
      {issue.description && (
        <Text color={colors.secondary} fontSize={9} numberOfLines={3}>
          {issue.description
            .replace(/!\[.*?\]\(.*?\)/g, '[image]')
            .replace(/\[.*?\]\(.*?\)/g, '[link]')}
        </Text>
      )}
    </YStack>
  );
}

// ============================================================================
// Renderers
// ============================================================================

export function ListIssuesRenderer({
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);
  const parsed = output
    ? parseOutput<{ count?: number; issues?: LinearIssue[] } | LinearIssue[]>(output)
    : null;

  // Handle both { issues: [...] } and direct array formats
  const issues =
    parsed && typeof parsed === 'object' && 'issues' in parsed
      ? (parsed as { issues: LinearIssue[] }).issues
      : Array.isArray(parsed)
        ? parsed
        : null;
  const isIssueArray = Array.isArray(issues) && issues.length > 0 && 'identifier' in issues[0];

  let description = 'List issues';
  if (input?.teamId) description += ` (team)`;
  if (input?.status) description += ` [${input.status}]`;

  let badge: React.ReactNode = null;
  if (status === 'completed' && isIssueArray) {
    badge = <Badge text={`${issues!.length} issues`} variant="gray" />;
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
        {isIssueArray && <IssueListBlock issues={issues!} />}
        {error && <ErrorBlock error={error} />}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

export function GetIssueRenderer({
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);
  const parsed = output ? parseOutput<LinearIssue>(output) : null;
  const isSingleIssue =
    parsed && !Array.isArray(parsed) && typeof parsed === 'object' && 'identifier' in parsed;

  const description = input?.issueId ? `Get ${input.issueId}` : 'Get issue';

  let badge: React.ReactNode = null;
  if (status === 'completed' && isSingleIssue) {
    badge = <Badge text={(parsed as LinearIssue).identifier} variant="info" />;
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
        {isSingleIssue && <IssueDetailBlock issue={parsed as LinearIssue} />}
        {error && <ErrorBlock error={error} />}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

export function CreateIssueRenderer({
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);
  const parsed = output ? parseOutput<LinearIssue | string>(output) : null;
  const isSingleIssue =
    parsed && !Array.isArray(parsed) && typeof parsed === 'object' && 'identifier' in parsed;
  const isSuccess = isSuccessMessage(parsed);

  const description = input?.title ? `Create: ${truncate(input.title, 35)}` : 'Create issue';

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="created" variant="success" />;
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
        {isSingleIssue && <IssueDetailBlock issue={parsed as LinearIssue} variant="created" />}
        {isSuccess && typeof parsed === 'string' && <SuccessBlock message={parsed} />}
        {error && <ErrorBlock error={error} />}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

export function UpdateIssueRenderer({
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);
  const parsed = output ? parseOutput<LinearIssue | string>(output) : null;
  const isSingleIssue =
    parsed && !Array.isArray(parsed) && typeof parsed === 'object' && 'identifier' in parsed;
  const isSuccess = isSuccessMessage(parsed);

  const description = input?.issueId ? `Update ${input.issueId}` : 'Update issue';

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="updated" variant="info" />;
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
        {isSingleIssue && <IssueDetailBlock issue={parsed as LinearIssue} variant="updated" />}
        {isSuccess && typeof parsed === 'string' && <SuccessBlock message={parsed} />}
        {error && <ErrorBlock error={error} />}
      </ExpandedBody>
    </ExpandedContainer>
  );
}
