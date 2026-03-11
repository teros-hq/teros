/**
 * Feedback Renderer - Sub-renderers for each tool
 */

import { Bug, CheckCircle, Lightbulb } from '@tamagui/lucide-icons';
import type React from 'react';
import { useState } from 'react';
import { ScrollView } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';

import type { ToolCallRendererProps } from '../../types';
import {
  Badge,
  colors,
  ErrorBlock,
  ExpandedBody,
  ExpandedContainer,
  type Feedback,
  FeedbackRow,
  type FeedbackUpdate,
  formatDate,
  getShortToolName,
  HeaderRow,
  parseOutput,
  SeverityBadge,
  StatusBadge,
  SuccessBlock,
  TypeBadge,
  UnreadBadge,
  UpdateRow,
} from './shared';

// ============================================================================
// Report Bug Renderer
// ============================================================================

interface ReportBugOutput {
  success: boolean;
  feedbackId?: string;
  message?: string;
  error?: string;
}

export function ReportBugRenderer({ toolName, status, duration, output }: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);
  const parsed = output ? parseOutput<ReportBugOutput>(output) : null;
  const data = typeof parsed === 'object' ? parsed : null;

  const isSuccess = data?.success;
  const description = isSuccess
    ? 'Bug reported'
    : status === 'running'
      ? 'Reporting bug...'
      : 'Report bug';

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = isSuccess ? (
      <Badge text="submitted" variant="success" />
    ) : (
      <Badge text="failed" variant="error" />
    );
  } else if (status === 'failed') {
    badge = <Badge text="error" variant="error" />;
  }

  if (!expanded) {
    return (
      <HeaderRow
        status={status}
        description={description}
        duration={duration}
        badge={badge}
        expanded={false}
        onToggle={() => setExpanded(true)}
      />
    );
  }

  return (
    <ExpandedContainer>
      <HeaderRow
        status={status}
        description={description}
        duration={duration}
        badge={badge}
        expanded={true}
        onToggle={() => setExpanded(false)}
        isInContainer
      />
      <ExpandedBody>
        {status === 'failed' && <ErrorBlock error="Failed to report bug" />}
        {data?.error && <ErrorBlock error={data.error} />}
        {isSuccess && (
          <SuccessBlock
            message={data.message || 'Bug report submitted successfully'}
            feedbackId={data.feedbackId}
          />
        )}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// ============================================================================
// Report Suggestion Renderer
// ============================================================================

interface ReportSuggestionOutput {
  success: boolean;
  feedbackId?: string;
  message?: string;
  error?: string;
}

export function ReportSuggestionRenderer({
  toolName,
  status,
  duration,
  output,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);
  const parsed = output ? parseOutput<ReportSuggestionOutput>(output) : null;
  const data = typeof parsed === 'object' ? parsed : null;

  const isSuccess = data?.success;
  const description = isSuccess
    ? 'Suggestion submitted'
    : status === 'running'
      ? 'Submitting suggestion...'
      : 'Submit suggestion';

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = isSuccess ? (
      <Badge text="submitted" variant="success" />
    ) : (
      <Badge text="failed" variant="error" />
    );
  } else if (status === 'failed') {
    badge = <Badge text="error" variant="error" />;
  }

  if (!expanded) {
    return (
      <HeaderRow
        status={status}
        description={description}
        duration={duration}
        badge={badge}
        expanded={false}
        onToggle={() => setExpanded(true)}
      />
    );
  }

  return (
    <ExpandedContainer>
      <HeaderRow
        status={status}
        description={description}
        duration={duration}
        badge={badge}
        expanded={true}
        onToggle={() => setExpanded(false)}
        isInContainer
      />
      <ExpandedBody>
        {status === 'failed' && <ErrorBlock error="Failed to submit suggestion" />}
        {data?.error && <ErrorBlock error={data.error} />}
        {isSuccess && (
          <SuccessBlock
            message={data.message || 'Suggestion submitted successfully'}
            feedbackId={data.feedbackId}
          />
        )}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// ============================================================================
// List My Feedback Renderer
// ============================================================================

interface ListMyFeedbackOutput {
  count: number;
  unreadUpdates: number;
  feedbacks: Feedback[];
  error?: string;
}

export function ListMyFeedbackRenderer({
  toolName,
  status,
  duration,
  output,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(status === 'completed');
  const parsed = output ? parseOutput<ListMyFeedbackOutput>(output) : null;
  const data = typeof parsed === 'object' ? parsed : null;

  const count = data?.count ?? 0;
  const unread = data?.unreadUpdates ?? 0;
  const description =
    status === 'running'
      ? 'Loading feedback...'
      : `${count} feedback item${count !== 1 ? 's' : ''}`;

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    if (unread > 0) {
      badge = <Badge text={`${unread} unread`} variant="info" />;
    } else {
      badge = <Badge text={`${count}`} variant="gray" />;
    }
  } else if (status === 'failed') {
    badge = <Badge text="error" variant="error" />;
  }

  if (!expanded || !data?.feedbacks?.length) {
    return (
      <HeaderRow
        status={status}
        description={description}
        duration={duration}
        badge={badge}
        expanded={false}
        onToggle={() => setExpanded(true)}
      />
    );
  }

  return (
    <ExpandedContainer>
      <HeaderRow
        status={status}
        description={description}
        duration={duration}
        badge={badge}
        expanded={true}
        onToggle={() => setExpanded(false)}
        isInContainer
      />
      <ExpandedBody>
        {data.error && <ErrorBlock error={data.error} />}
        <ScrollView style={{ maxHeight: 300 }} showsVerticalScrollIndicator={false}>
          <YStack gap={6}>
            {data.feedbacks.map((feedback) => (
              <FeedbackRow key={feedback.feedbackId} feedback={feedback} />
            ))}
          </YStack>
        </ScrollView>
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// ============================================================================
// Get Feedback Renderer
// ============================================================================

interface GetFeedbackOutput {
  feedbackId: string;
  type: 'bug' | 'suggestion';
  title: string;
  description: string;
  severity?: string;
  status: string;
  hasUnreadUpdates: boolean;
  updates: FeedbackUpdate[];
  createdAt: string;
  updatedAt?: string;
  resolvedAt?: string;
  error?: string;
}

export function GetFeedbackRenderer({ toolName, status, duration, output }: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(status === 'completed');
  const parsed = output ? parseOutput<GetFeedbackOutput>(output) : null;
  const data = typeof parsed === 'object' ? parsed : null;

  const description =
    status === 'running' ? 'Loading feedback...' : data?.title || 'Feedback details';

  let badge: React.ReactNode = null;
  if (status === 'completed' && data) {
    badge = <StatusBadge status={data.status} />;
  } else if (status === 'failed') {
    badge = <Badge text="error" variant="error" />;
  }

  if (!expanded) {
    return (
      <HeaderRow
        status={status}
        description={description}
        duration={duration}
        badge={badge}
        expanded={false}
        onToggle={() => setExpanded(true)}
      />
    );
  }

  return (
    <ExpandedContainer>
      <HeaderRow
        status={status}
        description={description}
        duration={duration}
        badge={badge}
        expanded={true}
        onToggle={() => setExpanded(false)}
        isInContainer
      />
      <ExpandedBody>
        {status === 'failed' && <ErrorBlock error="Failed to load feedback" />}
        {data?.error && <ErrorBlock error={data.error} />}

        {data && !data.error && (
          <YStack gap={10}>
            {/* Header */}
            <YStack gap={6}>
              <XStack alignItems="center" gap={8}>
                <TypeBadge type={data.type} />
                {data.severity && <SeverityBadge severity={data.severity} />}
                {data.hasUnreadUpdates && <UnreadBadge />}
              </XStack>

              <Text color={colors.primary} fontSize={13} fontWeight="600">
                {data.title}
              </Text>

              <Text color={colors.secondary} fontSize={10} fontFamily="$mono">
                {data.feedbackId} • {formatDate(data.createdAt)}
              </Text>
            </YStack>

            {/* Description */}
            {data.description && (
              <YStack backgroundColor={colors.bgInner} borderRadius={6} padding={10}>
                <Text color={colors.primary} fontSize={11} lineHeight={18}>
                  {data.description}
                </Text>
              </YStack>
            )}

            {/* Updates */}
            {data.updates && data.updates.length > 0 && (
              <YStack gap={6}>
                <Text color={colors.secondary} fontSize={10} fontWeight="500">
                  UPDATES ({data.updates.length})
                </Text>
                <ScrollView style={{ maxHeight: 200 }} showsVerticalScrollIndicator={false}>
                  <YStack gap={6}>
                    {data.updates.map((update) => (
                      <UpdateRow key={update.updateId} update={update} />
                    ))}
                  </YStack>
                </ScrollView>
              </YStack>
            )}
          </YStack>
        )}
      </ExpandedBody>
    </ExpandedContainer>
  );
}
