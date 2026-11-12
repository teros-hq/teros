/**
 * Automate MCA — Tool Call Renderer entry point.
 *
 * Dispatches each tool call to a dedicated sub-renderer by short name.
 * 21/21 tools covered. Fallback is dev-only — every tool MUST have an entry.
 */

import type React from 'react';
import { Text, YStack } from 'tamagui';
import { Badge, colors as globalColors, JsonPreview, ToolCallCard } from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import { withPermissionSupport } from '../../withPermissionSupport';
import {
  BulkCancelRenderer,
  CancelReminderRenderer,
  CreateAutomationRenderer,
  CreateRecurringTaskRenderer,
  CreateWebhookRenderer,
  DeleteAutomationRenderer,
  DisableAutomationRenderer,
  EnableAutomationRenderer,
  GetAutomationRenderer,
  GetQuotaRenderer,
  HealthCheckRenderer,
  ListAutomationsRenderer,
  ListEventTopicsRenderer,
  ListExecutionsRenderer,
  ListUpcomingRenderer,
  ListWebhookCallsRenderer,
  ParseTimeRenderer,
  RegenerateWebhookUrlRenderer,
  ScheduleReminderRenderer,
  SnoozeReminderRenderer,
  TestWebhookRenderer,
  UpdateAutomationRenderer,
} from './AutomationRenderers';
import { getShortToolName, useAutomateDescription } from './shared';

const RENDERERS: Record<string, React.ComponentType<ToolCallRendererProps>> = {
  '-health-check': HealthCheckRenderer,
  // Query
  'list-automations': ListAutomationsRenderer,
  'get-automation': GetAutomationRenderer,
  'list-executions': ListExecutionsRenderer,
  'get-quota': GetQuotaRenderer,
  'list-webhook-calls': ListWebhookCallsRenderer,
  'list-upcoming': ListUpcomingRenderer,
  'list-event-topics': ListEventTopicsRenderer,
  'parse-time-expression': ParseTimeRenderer,
  // Create
  'create-automation': CreateAutomationRenderer,
  'schedule-reminder': ScheduleReminderRenderer,
  'create-recurring-task': CreateRecurringTaskRenderer,
  'create-webhook': CreateWebhookRenderer,
  // Modify
  'update-automation': UpdateAutomationRenderer,
  'enable-automation': EnableAutomationRenderer,
  'disable-automation': DisableAutomationRenderer,
  'snooze-reminder': SnoozeReminderRenderer,
  'regenerate-webhook-url': RegenerateWebhookUrlRenderer,
  'test-webhook': TestWebhookRenderer,
  // Delete
  'delete-automation': DeleteAutomationRenderer,
  'cancel-reminder': CancelReminderRenderer,
  'bulk-cancel': BulkCancelRenderer,
};

function FallbackRenderer({ toolName, status, output, error }: ToolCallRendererProps) {
  const description = useAutomateDescription('fallback', status);
  return (
    <ToolCallCard status={status === 'pending' ? 'running' : status} description={description} badge={<Badge text="DEV-FALLBACK" variant="warning" />} defaultExpanded>
      <YStack gap={4}>
        <Text color={globalColors.failed} fontSize={10} fontFamily="$mono">
          Missing renderer for {getShortToolName(toolName)} — add to RENDERERS map.
        </Text>
        {error && (
          <Text color={globalColors.failed} fontSize={10}>
            {error}
          </Text>
        )}
        {output && <JsonPreview value={output} />}
      </YStack>
    </ToolCallCard>
  );
}

function AutomateRendererBase(props: ToolCallRendererProps) {
  const short = getShortToolName(props.toolName);
  const Renderer = RENDERERS[short] ?? FallbackRenderer;
  return <Renderer {...props} />;
}

export const AutomateToolCallRenderer = withPermissionSupport(AutomateRendererBase);
export const __TEST_RENDERERS = RENDERERS;
