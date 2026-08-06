/**
 * Feedback Renderer - Sub-renderers for each tool
 */

import type React from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';

import {
  Badge,
  countBadgeVariant,
  ErrorBlock,
  formatCountBadge,
  ToolCallCard,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import {
  useFeedbackColors,
  type Feedback,
  FeedbackRow,
  FeedbackSuccessBlock,
  type FeedbackUpdate,
  formatDate,
  parseOutput,
  SeverityBadge,
  StatusBadge,
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

export function ReportBugRenderer({ toolName, status, duration, output, appIcon }: ToolCallRendererProps) {
  const { t } = useTranslation();
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

  return (
    <ToolCallCard
      status={status}
      description={description}
      badge={badge}
      iconUri={appIcon}
      defaultExpanded
    >
      {status === 'failed' && <ErrorBlock error={t('errors.feedback.reportBugFailed')} />}
      {data?.error && <ErrorBlock error={data.error} />}
      {isSuccess && (
        <FeedbackSuccessBlock
          message={data.message || t('errors.feedback.bugReportSuccess')}
          feedbackId={data.feedbackId}
        />
      )}
    </ToolCallCard>
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
  output,
  appIcon,
}: ToolCallRendererProps) {
  const { t } = useTranslation();
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

  return (
    <ToolCallCard
      status={status}
      description={description}
      badge={badge}
      iconUri={appIcon}
      defaultExpanded
    >
      {status === 'failed' && <ErrorBlock error={t('errors.feedback.suggestionFailed')} />}
      {data?.error && <ErrorBlock error={data.error} />}
      {isSuccess && (
        <FeedbackSuccessBlock
          message={data.message || t('errors.feedback.suggestionSuccess')}
          feedbackId={data.feedbackId}
        />
      )}
    </ToolCallCard>
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
  output,
  appIcon,
}: ToolCallRendererProps) {
  const { t } = useTranslation();
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
      badge = <Badge text={formatCountBadge(count, 'item')} variant={countBadgeVariant(count)} />;
    }
  } else if (status === 'failed') {
    badge = <Badge text="error" variant="error" />;
  }

  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
      {data?.error && <ErrorBlock error={data.error} />}
      {data?.feedbacks && data.feedbacks.length > 0 && (
        <ScrollView style={{ maxHeight: 300 }} showsVerticalScrollIndicator={false}>
          <YStack gap={6}>
            {data.feedbacks.map((feedback) => (
              <FeedbackRow key={feedback.feedbackId} feedback={feedback} />
            ))}
          </YStack>
        </ScrollView>
      )}
    </ToolCallCard>
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

export function GetFeedbackRenderer({ toolName, status, output, appIcon }: ToolCallRendererProps) {
  const c = useFeedbackColors();
  const colors = useFeedbackColors();
  const { t } = useTranslation();
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

  return (
    <ToolCallCard
      status={status}
      description={description}
      badge={badge}
      iconUri={appIcon}
      defaultExpanded
    >
      {status === 'failed' && <ErrorBlock error={t('errors.feedback.loadFailed')} />}
      {data?.error && <ErrorBlock error={data.error} />}
      {data && (
        <YStack gap={8}>
          <Text color={c.text} fontSize={13} fontWeight="600">
            {data.title}
          </Text>

          <Text color={c.text2} fontSize={10} fontFamily="$mono">
            {data.feedbackId} • {formatDate(data.createdAt)}
          </Text>

          {/* Description */}
          {data.description && (
            <YStack backgroundColor={c.bgInner} borderRadius={6} padding={10}>
              <Text color={c.text} fontSize={11} lineHeight={18}>
                {data.description}
              </Text>
            </YStack>
          )}

          {/* Updates */}
          {data.updates && data.updates.length > 0 && (
            <YStack gap={6}>
              <Text color={c.text2} fontSize={10} fontWeight="500">
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
    </ToolCallCard>
  );
}
