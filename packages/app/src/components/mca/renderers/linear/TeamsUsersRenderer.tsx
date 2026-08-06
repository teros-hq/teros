/**
 * Linear Renderer — Teams & Users
 *
 * Handles: list-teams, list-users.
 */

import { ScrollView } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';

import {
  Avatar,
  Empty,
  EntityRow,
  ErrorBlock,
  IconChip,
  parseOutput,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import {
  type LinearTeam,
  type LinearUser,
  LinearToolShell,
  shortId,
  teamKeyChipProps,
  unwrapList,
  useLinearColors,
  useScrollStyle,
} from './shared';

// ============================================================================
// ListTeamsRenderer
// ============================================================================

export function ListTeamsRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const c = useLinearColors();
  const scrollStyle = useScrollStyle(260);
  const parsed = output ? parseOutput<unknown>(output) : null;
  const { items: teams, nextCursor, total } = unwrapList<LinearTeam>(parsed, 'teams');

  return (
    <LinearToolShell
      toolName={toolName}
      status={status}
      defaultExpanded={false}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && (
        <>
          {teams.length === 0 ? (
            <Empty message="No teams" />
          ) : (
            <ScrollView style={scrollStyle} showsVerticalScrollIndicator>
              <YStack>
                {teams.map((t) => (
                  <EntityRow
                    key={t.id}
                    leading={<IconChip {...teamKeyChipProps(t)} />}
                    title={t.name}
                    subtitle={t.description ? t.description.slice(0, 80) : undefined}
                    badges={
                      t.private ? (
                        <IconChip text="private" accent={c.text3} outline />
                      ) : null
                    }
                  />
                ))}
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

// ============================================================================
// ListUsersRenderer
// ============================================================================

export function ListUsersRenderer({
  toolName,
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const c = useLinearColors();
  const scrollStyle = useScrollStyle(320);
  const parsed = output ? parseOutput<unknown>(output) : null;
  const { items: users, nextCursor, total } = unwrapList<LinearUser>(parsed, 'users');
  const description = input?.teamId
    ? `Users (team ${shortId(String(input.teamId))})`
    : undefined;

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
          {users.length === 0 ? (
            <Empty message="No users" />
          ) : (
            <ScrollView style={scrollStyle} showsVerticalScrollIndicator>
              <YStack>
                {users.map((u) => (
                  <EntityRow
                    key={u.id}
                    leading={
                      <Avatar src={u.avatarUrl ?? undefined} name={u.displayName ?? u.name} size={24} />
                    }
                    title={u.displayName ?? u.name}
                    subtitle={u.email}
                    badges={
                      <XStack gap={4}>
                        {u.admin ? <IconChip text="admin" accent="#F2994A" outline /> : null}
                        {u.active === false ? (
                          <IconChip text="inactive" accent={c.text3} />
                        ) : null}
                      </XStack>
                    }
                  />
                ))}
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
