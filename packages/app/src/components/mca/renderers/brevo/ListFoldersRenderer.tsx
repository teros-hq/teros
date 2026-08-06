/**
 * Brevo — list-folders.
 */

import { YStack } from 'tamagui';
import {
  Badge,
  Empty,
  EntityRow,
  ErrorBlock,
  Folder,
  IconChip,
  IconTile,
  MAX_ITEMS,
  ToolCallCard,
  parseOutput,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import { BREVO_BRAND, type ListFoldersResult, narrowObject, useBrevoColors } from './shared';

export function ListFoldersRenderer({ status, output, error, appIcon }: ToolCallRendererProps) {
  const c = useBrevoColors();
  const data = output ? narrowObject<ListFoldersResult>(parseOutput<ListFoldersResult>(output)) : null;
  const folders = data?.folders ?? [];
  const count = data?.count ?? folders.length;
  const displayError = error || (status === 'failed' ? output : null);

  const badge =
    status === 'failed' ? (
      <Badge text="failed" variant="error" />
    ) : (
      <Badge text={`${count} ${count === 1 ? 'folder' : 'folders'}`} variant={count > 0 ? 'info' : 'gray'} />
    );

  const visible = folders.slice(0, MAX_ITEMS);

  return (
    <ToolCallCard
      status={status}
      verb="List folders"
      badge={badge}
      iconUri={appIcon}
      animateExpand
      defaultExpanded={status === 'completed' && folders.length > 0}
    >
      {displayError ? (
        <ErrorBlock error={displayError} />
      ) : status === 'completed' ? (
        folders.length > 0 ? (
          <YStack
            backgroundColor={c.bgInner}
            borderRadius={6}
            borderWidth={1}
            borderColor={c.border}
            overflow="hidden"
          >
            {visible.map((f, i) => (
              <EntityRow
                key={f.id ?? f.name ?? i}
                leading={
                  <IconTile
                    accent={BREVO_BRAND.royalBlue}
                    icon={<Folder size={14} color={BREVO_BRAND.royalBlue} />}
                    size={24}
                  />
                }
                title={f.name ?? '(unnamed folder)'}
                subtitle={f.id != null ? `id ${f.id}` : undefined}
                meta={
                  f.totalSubscribers != null ? (
                    <IconChip text={`${f.totalSubscribers} contacts`} accent={BREVO_BRAND.green} />
                  ) : undefined
                }
              />
            ))}
          </YStack>
        ) : (
          <Empty icon={<Folder size={20} color={c.muted} />} message="No folders" />
        )
      ) : null}
    </ToolCallCard>
  );
}
