/**
 * Canva Renderer — Assets domain.
 *
 * Handles: upload-asset, get-asset-upload-job, get-asset, update-asset,
 *          delete-asset.
 */

import { Edit3, Image as ImageIcon, Trash2, Upload } from '../../primitives';
import { Text, YStack } from 'tamagui';

import {
  ActionBadge,
  EntityCard,
  Empty,
  ErrorBlock,
  IconChip,
  IconTile,
  KeyValueGrid,
  type KeyValueRow,
  PillList,
  ResourceCard,
  colors as globalColors,
  parseOutput,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import {
  ASSET_TYPE_ACCENTS,
  ASSET_TYPE_ICONS,
  CANVA_BRAND,
  type CanvaAsset,
  type CanvaJob,
  CanvaToolShell,
  JOB_STATUS_ACCENTS,
  JOB_STATUS_LABELS,
  Polaroid,
  diffFields,
  formatTimestamp,
  narrowObject,
  shortId,
  unwrap,
} from './shared';

function StatusChip({ status }: { status: string | null }) {
  const accent = (status && JOB_STATUS_ACCENTS[status]) ?? globalColors.muted;
  const text = (status && JOB_STATUS_LABELS[status]) ?? (status ?? '—').toUpperCase();
  return <IconChip text={text} accent={accent} />;
}

function assetLeading(a: CanvaAsset, size = 28) {
  if (a.thumbnailUrl) {
    return (
      <Polaroid
        url={a.thumbnailUrl}
        width={120}
        height={90}
        thumbnailWidth={a.thumbnailWidth}
        thumbnailHeight={a.thumbnailHeight}
        alt={a.name}
      />
    );
  }
  const accent = (a.type && ASSET_TYPE_ACCENTS[a.type]) ?? CANVA_BRAND.teal;
  const IconComp = ASSET_TYPE_ICONS[a.type ?? ''] ?? ImageIcon;
  return <IconTile accent={accent} icon={<IconComp size={16} color={accent} />} size={size} />;
}

function assetRows(a: CanvaAsset): KeyValueRow[] {
  const rows: KeyValueRow[] = [];
  if (a.id) rows.push({ key: 'id', value: a.id });
  if (a.type) rows.push({ key: 'type', value: a.type });
  if (a.thumbnailWidth && a.thumbnailHeight)
    rows.push({ key: 'thumbnail', value: `${a.thumbnailWidth}×${a.thumbnailHeight}` });
  if (a.createdAt) rows.push({ key: 'createdAt', value: formatTimestamp(a.createdAt) });
  if (a.updatedAt) rows.push({ key: 'updatedAt', value: formatTimestamp(a.updatedAt) });
  return rows;
}

// upload-asset (POST → job)
export function UploadAssetRenderer({
  toolName,
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const parsed = output ? parseOutput<unknown>(output) : null;
  const job = narrowObject<CanvaJob<CanvaAsset>>(parsed);
  const url = String(input?.url ?? '');
  const name = String(input?.name ?? 'asset');

  return (
    <CanvaToolShell
      toolName={toolName}
      status={status}
      defaultExpanded={status === 'completed'}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && job && (
        <ResourceCard
          leading={
            <IconTile
              accent={CANVA_BRAND.teal}
              icon={<Upload size={16} color={CANVA_BRAND.teal} />}
              size={28}
            />
          }
          title={name}
          subtitle={job.id ? `job ${job.id}` : undefined}
          meta={<StatusChip status={job.status} />}
        >
          <KeyValueGrid rows={[{ key: 'source', value: shortId(url, 36, 8) }]} />
        </ResourceCard>
      )}
    </CanvaToolShell>
  );
}

export function GetAssetUploadJobRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const parsed = output ? parseOutput<unknown>(output) : null;
  const job = narrowObject<CanvaJob<CanvaAsset>>(parsed);
  const asset = job?.result ?? null;

  return (
    <CanvaToolShell
      toolName={toolName}
      status={status}
      defaultExpanded={status === 'completed'}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && job && (
        <ResourceCard
          leading={asset ? assetLeading(asset) : (
            <IconTile
              accent={JOB_STATUS_ACCENTS[job.status ?? ''] ?? globalColors.muted}
              icon={<Upload size={16} color={JOB_STATUS_ACCENTS[job.status ?? ''] ?? globalColors.muted} />}
              size={28}
            />
          )}
          title={asset?.name ?? 'Upload job'}
          subtitle={job.id ?? undefined}
          meta={<StatusChip status={job.status} />}
        >
          {job.error && (
            <Text color={globalColors.failed} fontSize={10}>
              {job.error.message ?? job.error.code ?? 'Job failed'}
            </Text>
          )}
          {asset && <KeyValueGrid rows={assetRows(asset)} />}
        </ResourceCard>
      )}
    </CanvaToolShell>
  );
}

export function GetAssetRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const parsed = output ? parseOutput<unknown>(output) : null;
  const a = unwrap<CanvaAsset>(parsed, 'asset');

  return (
    <CanvaToolShell
      toolName={toolName}
      status={status}
      defaultExpanded={status === 'completed'}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && a && (
        <ResourceCard leading={assetLeading(a)} title={a.name ?? '—'}>
          <KeyValueGrid rows={assetRows(a)} />
          {a.tags && a.tags.length > 0 && (
            <YStack gap={4}>
              <Text color={globalColors.secondary} fontSize={9} fontFamily="$mono" textTransform="uppercase">
                tags
              </Text>
              <PillList items={a.tags} />
            </YStack>
          )}
        </ResourceCard>
      )}
    </CanvaToolShell>
  );
}

export function UpdateAssetRenderer({
  toolName,
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const parsed = output ? parseOutput<unknown>(output) : null;
  const a = unwrap<CanvaAsset>(parsed, 'asset');
  const diff = diffFields(input as Record<string, unknown>, ['name', 'tags']);

  return (
    <CanvaToolShell
      toolName={toolName}
      status={status}
      defaultExpanded={status === 'completed'}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && a && (
        <ResourceCard
          leading={
            <IconTile
              accent={CANVA_BRAND.teal}
              icon={<Edit3 size={16} color={CANVA_BRAND.teal} />}
              size={28}
            />
          }
          title={a.name ?? input?.name ?? 'Asset'}
          subtitle={a.id ?? undefined}
          meta={<ActionBadge verb="updated" />}
        >
          {diff.length === 0 ? (
            <Empty message="No fields changed" />
          ) : (
            <KeyValueGrid rows={diff} />
          )}
        </ResourceCard>
      )}
    </CanvaToolShell>
  );
}

export function DeleteAssetRenderer({
  toolName,
  input,
  status,
  error,
  duration,
}: ToolCallRendererProps) {
  const assetId = String(input?.assetId ?? '');

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
          title={`Asset ${assetId || '?'}`}
          meta={<ActionBadge verb="deleted" />}
        />
      )}
    </CanvaToolShell>
  );
}
