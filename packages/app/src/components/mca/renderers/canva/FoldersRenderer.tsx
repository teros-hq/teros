/**
 * Canva Renderer — Folders domain.
 *
 * Handles: list-folders (folder items), get-folder, create-folder,
 *          update-folder, delete-folder, move-item.
 */

import { Edit3, File, FolderOpen, Pin, Plus, Trash2 } from '../../primitives';
import { ScrollView } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';

import {
  ActionBadge,
  DualEntity,
  Empty,
  EntityCard,
  EntityRow,
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
import {
  CANVA_BRAND,
  type CanvaFolder,
  type CanvaFolderItem,
  CanvaToolShell,
  Polaroid,
  diffFields,
  formatTimestamp,
  useScrollStyle,
  unwrap,
  unwrapList,
} from './shared';

const FOLDER_ITEM_ACCENTS: Record<string, string> = {
  design: CANVA_BRAND.teal,
  folder: CANVA_BRAND.sun,
  image: CANVA_BRAND.mint,
  video: CANVA_BRAND.coral,
};

function folderRows(f: CanvaFolder): KeyValueRow[] {
  const rows: KeyValueRow[] = [];
  if (f.id) rows.push({ key: 'id', value: f.id });
  if (f.createdAt) rows.push({ key: 'createdAt', value: formatTimestamp(f.createdAt) });
  if (f.updatedAt) rows.push({ key: 'updatedAt', value: formatTimestamp(f.updatedAt) });
  return rows;
}

// list-folders → folder items
export function ListFoldersRenderer({
  toolName,
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const parsed = output ? parseOutput<unknown>(output) : null;
  const { items, total, nextCursor } = unwrapList<CanvaFolderItem>(parsed, 'items');
  const folderId = String(input?.folderId ?? 'root');
  const description = `Items in folder ${folderId === 'root' ? '/' : folderId}`;

  return (
    <CanvaToolShell
      toolName={toolName}
      status={status}
      description={description}
      defaultExpanded={status === 'completed' && items.length > 0}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && (
        <>
          {items.length === 0 ? (
            <Empty message="Folder is empty" />
          ) : (
            <ScrollView style={useScrollStyle(360)} showsVerticalScrollIndicator>
              <YStack>
                {items.map((it) => {
                  const accent = (it.type && FOLDER_ITEM_ACCENTS[it.type]) ?? CANVA_BRAND.teal;
                  return (
                    <EntityRow
                      key={`${it.type}-${it.id}`}
                      leading={
                        it.thumbnailUrl ? (
                          <Polaroid url={it.thumbnailUrl} width={48} height={36} />
                        ) : (
                          <IconTile
                            accent={accent}
                            icon={<FolderOpen size={14} color={accent} />}
                            size={36}
                          />
                        )
                      }
                      title={it.name ?? '—'}
                      subtitle={it.id ?? undefined}
                      badges={
                        <XStack gap={4}>
                          <IconChip text={(it.type ?? 'item').toUpperCase()} accent={accent} />
                          {it.pinStatus === 'pinned' ? (
                            <IconChip
                              text="PINNED"
                              accent={CANVA_BRAND.sun}
                              icon={<Pin size={9} color={CANVA_BRAND.sun} />}
                            />
                          ) : null}
                        </XStack>
                      }
                    />
                  );
                })}
              </YStack>
            </ScrollView>
          )}
          {(nextCursor || typeof total === 'number') && (
            <XStack gap={6} justifyContent="flex-end" paddingHorizontal={4} paddingTop={2}>
              {typeof total === 'number' && (
                <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
                  {total} shown
                </Text>
              )}
              {nextCursor && (
                <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
                  · cursor available
                </Text>
              )}
            </XStack>
          )}
        </>
      )}
    </CanvaToolShell>
  );
}

export function GetFolderRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const parsed = output ? parseOutput<unknown>(output) : null;
  const f = unwrap<CanvaFolder>(parsed, 'folder');

  return (
    <CanvaToolShell
      toolName={toolName}
      status={status}
      defaultExpanded={status === 'completed'}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && f && (
        <ResourceCard
          leading={
            f.thumbnailUrl ? (
              <Polaroid url={f.thumbnailUrl} width={120} height={90} />
            ) : (
              <IconTile
                accent={CANVA_BRAND.sun}
                icon={<FolderOpen size={16} color={CANVA_BRAND.sun} />}
                size={28}
              />
            )
          }
          title={f.name ?? 'Untitled folder'}
        >
          <KeyValueGrid rows={folderRows(f)} />
        </ResourceCard>
      )}
    </CanvaToolShell>
  );
}

export function CreateFolderRenderer({
  toolName,
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const parsed = output ? parseOutput<unknown>(output) : null;
  const f = unwrap<CanvaFolder>(parsed, 'folder');

  return (
    <CanvaToolShell
      toolName={toolName}
      status={status}
      defaultExpanded={status === 'completed'}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && f && (
        <ResourceCard
          leading={
            <IconTile
              accent={CANVA_BRAND.sun}
              icon={<Plus size={16} color={CANVA_BRAND.sun} />}
              size={28}
            />
          }
          title={f.name ?? input?.name ?? 'New folder'}
          subtitle={f.id ? `id ${f.id}` : undefined}
          meta={<ActionBadge verb="created" />}
        >
          <KeyValueGrid rows={folderRows(f)} />
        </ResourceCard>
      )}
    </CanvaToolShell>
  );
}

export function UpdateFolderRenderer({
  toolName,
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const parsed = output ? parseOutput<unknown>(output) : null;
  const f = unwrap<CanvaFolder>(parsed, 'folder');
  const diff = diffFields(input as Record<string, unknown>, ['name']);

  return (
    <CanvaToolShell
      toolName={toolName}
      status={status}
      defaultExpanded={status === 'completed'}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && f && (
        <ResourceCard
          leading={
            <IconTile
              accent={CANVA_BRAND.teal}
              icon={<Edit3 size={16} color={CANVA_BRAND.teal} />}
              size={28}
            />
          }
          title={f.name ?? input?.name ?? 'Folder'}
          subtitle={f.id ?? undefined}
          meta={<ActionBadge verb="updated" />}
        >
          {diff.length > 0 && <KeyValueGrid rows={diff} />}
        </ResourceCard>
      )}
    </CanvaToolShell>
  );
}

export function DeleteFolderRenderer({
  toolName,
  input,
  status,
  error,
  duration,
}: ToolCallRendererProps) {
  const folderId = String(input?.folderId ?? '');

  return (
    <CanvaToolShell
      toolName={toolName}
      status={status}
      defaultExpanded={status === 'completed'}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && (
        <EntityCard
          leading={
            <IconTile
              accent={globalColors.failed}
              icon={<Trash2 size={14} color={globalColors.failed} />}
              size={26}
            />
          }
          title={`Folder ${folderId || '?'}`}
          meta={<ActionBadge verb="deleted" />}
        />
      )}
    </CanvaToolShell>
  );
}

export function MoveItemRenderer({
  toolName,
  input,
  status,
  error,
  duration,
}: ToolCallRendererProps) {
  const itemId = String(input?.itemId ?? '');
  const toFolderId = String(input?.toFolderId ?? '');

  return (
    <CanvaToolShell
      toolName={toolName}
      status={status}
      defaultExpanded={status === 'completed'}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && (
        <DualEntity
          left={{
            visual: (
              <IconTile accent={CANVA_BRAND.teal} icon={<File size={14} color={CANVA_BRAND.teal} />} size={26} />
            ),
            title: itemId || 'item',
          }}
          right={{
            visual: (
              <IconTile
                accent={CANVA_BRAND.sun}
                icon={<FolderOpen size={14} color={CANVA_BRAND.sun} />}
                size={26}
              />
            ),
            title: toFolderId === 'root' ? '/ root' : toFolderId,
          }}
          action="transfer"
        />
      )}
    </CanvaToolShell>
  );
}
