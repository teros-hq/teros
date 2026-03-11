/**
 * Linear Renderer - Teams & Users
 *
 * Handles: linear-list-teams, linear-list-users
 */

import { UserCircle } from '@tamagui/lucide-icons';
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
  HeaderRow,
  type LinearTeam,
  type LinearUser,
  parseOutput,
} from './shared';

// ============================================================================
// Content Blocks
// ============================================================================

function TeamListBlock({ teams }: { teams: LinearTeam[] }) {
  return (
    <YStack backgroundColor={colors.bgInner} borderRadius={5} paddingVertical={4}>
      {teams.map((team) => (
        <XStack key={team.id} alignItems="center" gap={8} paddingVertical={4} paddingHorizontal={8}>
          <Text color={colors.linearPurple} fontSize={10} fontFamily="$mono" fontWeight="600">
            {team.key}
          </Text>
          <Text flex={1} color={colors.primary} fontSize={10}>
            {team.name}
          </Text>
        </XStack>
      ))}
    </YStack>
  );
}

function UserListBlock({ users }: { users: LinearUser[] }) {
  return (
    <ScrollView
      style={{ maxHeight: 200, backgroundColor: colors.bgInner, borderRadius: 5 }}
      showsVerticalScrollIndicator={true}
    >
      <YStack paddingVertical={4}>
        {users.map((user) => (
          <XStack
            key={user.id}
            alignItems="center"
            gap={8}
            paddingVertical={4}
            paddingHorizontal={8}
            opacity={user.active === false ? 0.5 : 1}
          >
            <UserCircle size={14} color={colors.linearPurple} />
            <Text flex={1} color={colors.primary} fontSize={10}>
              {user.name}
            </Text>
            {user.email && (
              <Text color={colors.muted} fontSize={9}>
                {user.email}
              </Text>
            )}
            {user.active === false && <Badge text="inactive" variant="gray" />}
          </XStack>
        ))}
      </YStack>
    </ScrollView>
  );
}

// ============================================================================
// Renderers
// ============================================================================

export function ListTeamsRenderer({ status, output, error, duration }: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);
  const parsed = output
    ? parseOutput<{ count?: number; teams?: LinearTeam[] } | LinearTeam[]>(output)
    : null;

  // Handle both { teams: [...] } and direct array formats
  const teams =
    parsed && typeof parsed === 'object' && 'teams' in parsed
      ? (parsed as { teams: LinearTeam[] }).teams
      : Array.isArray(parsed)
        ? parsed
        : null;
  const isTeamArray = Array.isArray(teams) && teams.length > 0 && 'key' in teams[0];

  const description = 'List teams';

  let badge: React.ReactNode = null;
  if (status === 'completed' && isTeamArray) {
    badge = <Badge text={`${teams!.length} teams`} variant="gray" />;
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
        {isTeamArray && <TeamListBlock teams={teams!} />}
        {error && <ErrorBlock error={error} />}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

export function ListUsersRenderer({
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);
  const parsed = output
    ? parseOutput<{ count?: number; users?: LinearUser[] } | LinearUser[]>(output)
    : null;

  // Handle both { users: [...] } and direct array formats
  const users =
    parsed && typeof parsed === 'object' && 'users' in parsed
      ? (parsed as { users: LinearUser[] }).users
      : Array.isArray(parsed)
        ? parsed
        : null;
  const isUserArray =
    Array.isArray(users) && users.length > 0 && ('email' in users[0] || 'name' in users[0]);

  let description = 'List users';
  if (input?.teamId) description += ` (team)`;

  let badge: React.ReactNode = null;
  if (status === 'completed' && isUserArray) {
    badge = <Badge text={`${users!.length} users`} variant="gray" />;
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
        {isUserArray && <UserListBlock users={users!} />}
        {error && <ErrorBlock error={error} />}
      </ExpandedBody>
    </ExpandedContainer>
  );
}
