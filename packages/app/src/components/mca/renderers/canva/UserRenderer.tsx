/**
 * Canva Renderer — User domain.
 *
 * Handles: get-user, get-user-profile, get-user-capabilities.
 */

import { Crown, ShieldCheck, User } from '../../primitives';
import { Text, XStack, YStack } from 'tamagui';
import {
  Empty,
  ErrorBlock,
  IconChip,
  IconTile,
  KeyValueGrid,
  type KeyValueRow,
  ResourceCard,
  colors as globalColors,
  parseOutput,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import { CANVA_BRAND, CanvaToolShell, narrowObject } from './shared';

interface UserShape {
  userId?: string | null;
  teamId?: string | null;
}
interface ProfileShape {
  displayName?: string | null;
}
interface CapabilitiesShape {
  capabilities?: string[];
}

export function GetUserRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<unknown>(output) : null;
  const u = narrowObject<UserShape>(parsed) ?? {};
  const rows: KeyValueRow[] = [];
  if (u.userId) rows.push({ key: 'userId', value: u.userId });
  if (u.teamId) rows.push({ key: 'teamId', value: u.teamId });

  return (
    <CanvaToolShell
      toolName={toolName}
      status={status}
      defaultExpanded={status === 'completed'}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && (
        <ResourceCard
          leading={
            <IconTile accent={CANVA_BRAND.teal} icon={<User size={16} color={CANVA_BRAND.teal} />} size={28} />
          }
          title={u.userId ?? 'Unknown user'}
          subtitle={u.teamId ? `team ${u.teamId}` : undefined}
        >
          {rows.length > 0 ? <KeyValueGrid rows={rows} /> : <Empty message="No user fields returned" />}
        </ResourceCard>
      )}
    </CanvaToolShell>
  );
}

export function GetUserProfileRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const parsed = output ? parseOutput<unknown>(output) : null;
  const profile = narrowObject<ProfileShape>(parsed);
  const displayName = profile?.displayName ?? null;

  return (
    <CanvaToolShell
      toolName={toolName}
      status={status}
      defaultExpanded={status === 'completed'}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && (
        <ResourceCard
          leading={
            <IconTile
              accent={CANVA_BRAND.purple}
              icon={<User size={16} color={CANVA_BRAND.purple} />}
              size={28}
            />
          }
          title={displayName ?? '—'}
          subtitle="Canva display name"
        />
      )}
    </CanvaToolShell>
  );
}

export function GetUserCapabilitiesRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const parsed = output ? parseOutput<unknown>(output) : null;
  const data = narrowObject<CapabilitiesShape>(parsed);
  const caps: string[] = data?.capabilities ?? [];

  return (
    <CanvaToolShell
      toolName={toolName}
      status={status}
      defaultExpanded={status === 'completed'}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && (
        <ResourceCard
          leading={
            <IconTile
              accent={CANVA_BRAND.sun}
              icon={<Crown size={16} color={CANVA_BRAND.sun} />}
              size={28}
            />
          }
          title={caps.length === 0 ? 'No capabilities' : `${caps.length} capability${caps.length === 1 ? '' : 'ies'}`}
          subtitle="Plan + role gating"
        >
          {caps.length === 0 ? (
            <Empty message="Account has no special capabilities (free tier)." />
          ) : (
            <YStack gap={4}>
              <Text color={globalColors.secondary} fontSize={9} fontFamily="$mono" textTransform="uppercase">
                granted
              </Text>
              <XStack flexWrap="wrap" gap={4}>
                {caps.map((cap: string) => (
                  <IconChip
                    key={cap}
                    text={cap}
                    accent={CANVA_BRAND.teal}
                    icon={<ShieldCheck size={9} color={CANVA_BRAND.teal} />}
                  />
                ))}
              </XStack>
            </YStack>
          )}
        </ResourceCard>
      )}
    </CanvaToolShell>
  );
}
