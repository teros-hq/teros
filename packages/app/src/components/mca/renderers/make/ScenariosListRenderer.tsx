/**
 * mca.make — list-scenarios sub-renderer.
 *
 * One `EntityRow` per scenario: a brand-tinted IconTile (Make purple), the
 * scenario name, `#id · team N` subtitle, and a semantic state badge
 * (active/paused/inactive — omitted when the upstream didn't populate it).
 */

import type React from 'react';
import { Text, YStack } from 'tamagui';
import { Badge, Empty, EntityRow, ErrorBlock, IconTile } from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import {
  type ListScenariosOutput,
  MakeToolShell,
  parseMakeOutput,
  scenarioInitials,
  scenarioStateChip,
  useMakeColors,
} from './shared';

export function ScenariosListRenderer({
  status,
  output,
  error,
  appIcon,
}: ToolCallRendererProps): React.ReactNode {
  const c = useMakeColors();
  const data = parseMakeOutput<ListScenariosOutput>(output);
  const scenarios = data?.scenarios ?? [];
  const failed = status === 'failed';

  // Show "N+" when the upstream total is unknown but a full page suggests more.
  const countText = data ? `${data.total}${data.hasMore ? '+' : ''}` : '';
  const badge = failed ? (
    <Badge text="failed" variant="error" />
  ) : data ? (
    <Badge text={countText} variant="info" />
  ) : undefined;

  return (
    <MakeToolShell
      toolName="list-scenarios"
      status={status}
      appIcon={appIcon}
      badge={badge}
      defaultExpanded={scenarios.length > 0}
    >
      {failed ? (
        <ErrorBlock message={error || output || 'Failed to list scenarios'} title="List failed" />
      ) : scenarios.length === 0 ? (
        <Empty message="No scenarios found" hint={data?.teamId ? `team ${data.teamId}` : undefined} />
      ) : (
        <YStack gap={6}>
          <YStack
            backgroundColor={c.bgInner}
            borderRadius={6}
            borderWidth={1}
            borderColor={c.border}
            overflow="hidden"
          >
            {scenarios.map((s) => {
              const chip = scenarioStateChip(s);
              return (
                <EntityRow
                  key={s.id || s.name}
                  leading={<IconTile size={28} label={scenarioInitials(s.name)} accent={c.brand} />}
                  title={s.name}
                  subtitle={`#${s.id}${s.teamId ? ` · team ${s.teamId}` : ''}`}
                  badges={chip ? <Badge text={chip.text} variant={chip.variant} /> : undefined}
                />
              );
            })}
          </YStack>
          {data?.hasMore && data.nextOffset != null && (
            <Text color={c.text3} fontSize={10} fontFamily="$mono">
              showing {data.offset + data.returned} · more available (next offset {data.nextOffset})
            </Text>
          )}
        </YStack>
      )}
    </MakeToolShell>
  );
}
