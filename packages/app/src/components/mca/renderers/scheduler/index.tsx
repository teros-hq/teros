/**
 * Scheduler MCA — Tool Call Renderer entry point.
 *
 * Dispatches each tool call to a dedicated sub-renderer by short name.
 * 19/19 tools covered (8 reminder + 7 recurring + parse + executions + health + stats).
 * Fallback is dev-only — every tool MUST have an entry below.
 */

import type React from 'react';
import { Text, YStack } from 'tamagui';
import { Badge, colors as globalColors, JsonPreview, ToolCallCard } from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import { withPermissionSupport } from '../../withPermissionSupport';
import { GetStatsRenderer } from './GetStatsRenderer';
import { HealthCheckRenderer } from './HealthCheckRenderer';
import { ListExecutionsRenderer } from './ExecutionsRenderer';
import { ParseTimeRenderer } from './ParseTimeRenderer';
import {
  CreateRecurringTaskRenderer,
  DeleteRecurringTaskRenderer,
  DisableRecurringTaskRenderer,
  EnableRecurringTaskRenderer,
  GetRecurringTaskRenderer,
  ListRecurringTasksRenderer,
  UpdateRecurringTaskRenderer,
} from './RecurringTasksRenderer';
import {
  BulkCancelRenderer,
  CancelReminderRenderer,
  GetReminderRenderer,
  ListRemindersRenderer,
  ListUpcomingRenderer,
  ScheduleReminderRenderer,
  SnoozeReminderRenderer,
  UpdateReminderRenderer,
} from './RemindersRenderer';
import { getShortToolName, SchedulerToolShell } from './shared';

const RENDERERS: Record<string, React.ComponentType<ToolCallRendererProps>> = {
  // SDK contract — shipped in every MCA
  '-health-check': HealthCheckRenderer,
  'get-stats': GetStatsRenderer,
  // Time tooling
  'parse-time-expression': ParseTimeRenderer,
  // Reminders
  'schedule-reminder': ScheduleReminderRenderer,
  'list-reminders': ListRemindersRenderer,
  'list-upcoming': ListUpcomingRenderer,
  'get-reminder': GetReminderRenderer,
  'update-reminder': UpdateReminderRenderer,
  'snooze-reminder': SnoozeReminderRenderer,
  'cancel-reminder': CancelReminderRenderer,
  'bulk-cancel': BulkCancelRenderer,
  // Recurring tasks
  'create-recurring-task': CreateRecurringTaskRenderer,
  'list-recurring-tasks': ListRecurringTasksRenderer,
  'get-recurring-task': GetRecurringTaskRenderer,
  'update-recurring-task': UpdateRecurringTaskRenderer,
  'enable-recurring-task': EnableRecurringTaskRenderer,
  'disable-recurring-task': DisableRecurringTaskRenderer,
  'delete-recurring-task': DeleteRecurringTaskRenderer,
  // Execution history
  'list-executions': ListExecutionsRenderer,
};

function FallbackRenderer({ toolName, status, output, error }: ToolCallRendererProps) {
  return (
    <ToolCallCard
      status={status === 'pending' ? 'running' : status}
      verb={`handle ${getShortToolName(toolName)}`}
      badge={<Badge text="DEV-FALLBACK" variant="warning" />}
      defaultExpanded
    >
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

function SchedulerRendererBase(props: ToolCallRendererProps) {
  const short = getShortToolName(props.toolName);
  const Renderer = RENDERERS[short] ?? FallbackRenderer;
  return <Renderer {...props} />;
}

export const SchedulerToolCallRenderer = withPermissionSupport(SchedulerRendererBase);
export const __TEST_RENDERERS = RENDERERS;
