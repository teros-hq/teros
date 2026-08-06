/**
 * Scheduler — list-executions renderer.
 */

import type React from 'react';
import { ScrollView, Text, XStack, YStack } from 'tamagui';
import {
  colors as globalColors,
  Empty,
  EntityRow,
  ErrorBlock,
  IconTile,
  parseOutput,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import {
  clockIcon,
  type ExecutionShape,
  executionLeadingIcon,
  SchedulerToolShell,
  STATUS_ACCENT,
  unwrapList,
  useScrollStyle,
} from './shared';

export function ListExecutionsRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<{ taskId?: number }>(output) : null;
  const taskId = (parsed && typeof parsed === 'object' && 'taskId' in parsed ? parsed.taskId : undefined) as number | undefined;
  const { items, nextCursor } = unwrapList<ExecutionShape>(parsed, 'items');
  const scrollStyle = useScrollStyle(360);

  return (
    <SchedulerToolShell toolName={toolName} status={status} duration={duration}>
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && (
        <YStack gap={6}>
          {taskId !== undefined && (
            <Text color={globalColors.secondary} fontSize={9} fontFamily="$mono" textTransform="uppercase">
              task #{taskId}
            </Text>
          )}
          {items.length === 0 ? (
            <Empty icon={clockIcon()} message="No executions yet." />
          ) : (
            <ScrollView style={scrollStyle} showsVerticalScrollIndicator>
              <YStack gap={4}>
                {items.map((e, i) => (
                  <EntityRow
                    // biome-ignore lint/suspicious/noArrayIndexKey: timestamp + index stable for execution log
                    key={`${e.ranAt}-${i}`}
                    leading={
                      <IconTile
                        icon={executionLeadingIcon(e.status)}
                        accent={
                          e.status === 'success'
                            ? STATUS_ACCENT.success
                            : e.status === 'failure'
                              ? STATUS_ACCENT.failure
                              : STATUS_ACCENT.skipped
                        }
                        size={24}
                      />
                    }
                    title={e.ranAtIso ?? new Date(e.ranAt).toISOString()}
                    subtitle={e.error}
                    badges={
                      <XStack gap={4}>
                        <Text color={globalColors.secondary} fontSize={9} fontFamily="$mono" textTransform="uppercase">
                          {e.status}
                        </Text>
                      </XStack>
                    }
                  />
                ))}
              </YStack>
            </ScrollView>
          )}
          {nextCursor && (
            <Text color={globalColors.secondary} fontSize={9} fontFamily="$mono">
              nextCursor: {nextCursor}
            </Text>
          )}
        </YStack>
      )}
    </SchedulerToolShell>
  );
}
