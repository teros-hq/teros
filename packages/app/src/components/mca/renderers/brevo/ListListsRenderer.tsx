/**
 * Brevo — list-lists.
 */

import { YStack } from 'tamagui';
import {
  Badge,
  Empty,
  EntityRow,
  ErrorBlock,
  IconChip,
  IconTile,
  List,
  MAX_ITEMS,
  ToolCallCard,
  parseOutput,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import { BREVO_BRAND, type ListListsResult, narrowObject, useBrevoColors } from './shared';

export function ListListsRenderer({ status, output, error, appIcon }: ToolCallRendererProps) {
  const c = useBrevoColors();
  const data = output ? narrowObject<ListListsResult>(parseOutput<ListListsResult>(output)) : null;
  const lists = data?.lists ?? [];
  const count = data?.count ?? lists.length;
  const displayError = error || (status === 'failed' ? output : null);

  const badge =
    status === 'failed' ? (
      <Badge text="failed" variant="error" />
    ) : (
      <Badge text={`${count} ${count === 1 ? 'list' : 'lists'}`} variant={count > 0 ? 'info' : 'gray'} />
    );

  const visible = lists.slice(0, MAX_ITEMS);

  return (
    <ToolCallCard
      status={status}
      verb="List lists"
      badge={badge}
      iconUri={appIcon}
      animateExpand
      defaultExpanded={status === 'completed' && lists.length > 0}
    >
      {displayError ? (
        <ErrorBlock error={displayError} />
      ) : status === 'completed' ? (
        lists.length > 0 ? (
          <YStack
            backgroundColor={c.bgInner}
            borderRadius={6}
            borderWidth={1}
            borderColor={c.border}
            overflow="hidden"
          >
            {visible.map((l, i) => (
              <EntityRow
                key={l.id ?? l.name ?? i}
                leading={
                  <IconTile
                    accent={BREVO_BRAND.green}
                    icon={<List size={14} color={BREVO_BRAND.green} />}
                    size={24}
                  />
                }
                title={l.name ?? '(unnamed list)'}
                subtitle={l.id != null ? `id ${l.id}` : undefined}
                meta={
                  l.totalSubscribers != null ? (
                    <IconChip text={`${l.totalSubscribers} contacts`} accent={BREVO_BRAND.royalBlue} />
                  ) : undefined
                }
              />
            ))}
          </YStack>
        ) : (
          <Empty
            icon={<List size={20} color={c.muted} />}
            message="No lists"
            hint="Create one with create-list."
          />
        )
      ) : null}
    </ToolCallCard>
  );
}
