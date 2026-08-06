/**
 * Linear Renderer — Workflow states
 *
 * Handles: list-workflow-states.
 */

import { ScrollView } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';

import {
  Empty,
  EntityRow,
  ErrorBlock,
  IconChip,
  parseOutput,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import {
  type LinearWorkflowState,
  LinearToolShell,
  shortId,
  unwrapList,
  useLinearColors,
  useScrollStyle,
  workflowStateChipProps,
} from './shared';

export function ListWorkflowStatesRenderer({
  toolName,
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const c = useLinearColors();
  const scrollStyle = useScrollStyle(260);
  const parsed = output ? parseOutput<unknown>(output) : null;
  const { items: statesRaw, nextCursor, total } = unwrapList<LinearWorkflowState>(parsed, 'states');
  const states = [...statesRaw].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const teamId = typeof input?.teamId === 'string' ? input.teamId : undefined;
  const description = teamId ? `Workflow states (team ${shortId(teamId)})` : undefined;

  return (
    <LinearToolShell
      toolName={toolName}
      status={status}
      description={description}
      defaultExpanded={false}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && (
        <>
          {states.length === 0 ? (
            <Empty message="No workflow states" />
          ) : (
            <ScrollView style={scrollStyle} showsVerticalScrollIndicator>
              <YStack>
                {states.map((s) => {
                  const chip = workflowStateChipProps(s);
                  return (
                    <EntityRow
                      key={s.id}
                      leading={chip ? <IconChip {...chip} /> : null}
                      title={s.name}
                      subtitle={s.type}
                      meta={
                        typeof s.position === 'number' ? (
                          <Text color={c.text3} fontSize={9} fontFamily="$mono">
                            pos {s.position.toFixed(1)}
                          </Text>
                        ) : undefined
                      }
                    />
                  );
                })}
              </YStack>
            </ScrollView>
          )}
          {(nextCursor || typeof total === 'number') && (
            <XStack justifyContent="flex-end" paddingTop={2}>
              <Text color={c.text3} fontSize={9} fontFamily="$mono">
                {typeof total === 'number' ? `${total} shown` : ''}
                {nextCursor ? ` · more · cursor ${shortId(nextCursor, 12)}` : ''}
              </Text>
            </XStack>
          )}
        </>
      )}
    </LinearToolShell>
  );
}
