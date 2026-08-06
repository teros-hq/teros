/**
 * Brevo — list-segments (saved contact filters).
 */

import { YStack } from 'tamagui';
import {
  Badge,
  Empty,
  EntityRow,
  ErrorBlock,
  IconChip,
  IconTile,
  Layers,
  MAX_ITEMS,
  ToolCallCard,
  parseOutput,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import { BREVO_BRAND, type ListSegmentsResult, narrowObject, useBrevoColors } from './shared';

export function ListSegmentsRenderer({ status, output, error, appIcon }: ToolCallRendererProps) {
  const c = useBrevoColors();
  const data = output ? narrowObject<ListSegmentsResult>(parseOutput<ListSegmentsResult>(output)) : null;
  const segments = data?.segments ?? [];
  const count = data?.count ?? segments.length;
  const displayError = error || (status === 'failed' ? output : null);

  const badge =
    status === 'failed' ? (
      <Badge text="failed" variant="error" />
    ) : (
      <Badge
        text={`${count} ${count === 1 ? 'segment' : 'segments'}`}
        variant={count > 0 ? 'info' : 'gray'}
      />
    );

  const visible = segments.slice(0, MAX_ITEMS);

  return (
    <ToolCallCard
      status={status}
      verb="List segments"
      badge={badge}
      iconUri={appIcon}
      animateExpand
      defaultExpanded={status === 'completed' && segments.length > 0}
    >
      {displayError ? (
        <ErrorBlock error={displayError} />
      ) : status === 'completed' ? (
        segments.length > 0 ? (
          <YStack
            backgroundColor={c.bgInner}
            borderRadius={6}
            borderWidth={1}
            borderColor={c.border}
            overflow="hidden"
          >
            {visible.map((s, i) => (
              <EntityRow
                key={s.id ?? s.segmentName ?? i}
                leading={
                  <IconTile
                    accent={BREVO_BRAND.green}
                    icon={<Layers size={13} color={BREVO_BRAND.green} />}
                    size={24}
                  />
                }
                title={s.segmentName ?? '(unnamed segment)'}
                subtitle={s.id != null ? `id ${s.id}` : undefined}
                meta={
                  s.categoryName ? (
                    <IconChip text={s.categoryName} accent={BREVO_BRAND.royalBlue} />
                  ) : undefined
                }
              />
            ))}
          </YStack>
        ) : (
          <Empty icon={<Layers size={20} color={c.muted} />} message="No segments" />
        )
      ) : null}
    </ToolCallCard>
  );
}
