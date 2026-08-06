/**
 * Canva Renderer — Exports + Resizes (async jobs).
 *
 * Handles: export-design, get-export-job, create-resize-job, get-resize-job.
 *
 * Job pattern: ResourceCard + status-derived StatusDot + result polaroid
 * (or download link list) when completed.
 */

import { Download, ExternalLink, Maximize2 } from '../../primitives';
import { Linking } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';

import {
  ActionBadge,
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
  type CanvaDesign,
  type CanvaJob,
  CanvaToolShell,
  JOB_STATUS_ACCENTS,
  JOB_STATUS_LABELS,
  Polaroid,
  narrowObject,
} from './shared';

function jobMetaRows(input?: Record<string, unknown>): KeyValueRow[] {
  if (!input) return [];
  const rows: KeyValueRow[] = [];
  if (input.format) rows.push({ key: 'format', value: String(input.format) });
  if (input.designType) rows.push({ key: 'newType', value: String(input.designType) });
  if (input.width && input.height) rows.push({ key: 'size', value: `${input.width}×${input.height}` });
  if (input.transparentBackground) rows.push({ key: 'transparent', value: 'yes' });
  if (Array.isArray(input.pages) && input.pages.length > 0)
    rows.push({ key: 'pages', value: (input.pages as number[]).join(', ') });
  return rows;
}

function StatusChip({ status }: { status: string | null }) {
  const accent = (status && JOB_STATUS_ACCENTS[status]) ?? globalColors.muted;
  const text = (status && JOB_STATUS_LABELS[status]) ?? (status ?? '—').toUpperCase();
  return <IconChip text={text} accent={accent} />;
}

// ============================================================================
// export-design — kicks off the job
// ============================================================================

export function ExportDesignRenderer({
  toolName,
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const parsed = output ? parseOutput<unknown>(output) : null;
  const job = narrowObject<CanvaJob<{ urls: string[] }>>(parsed);
  const format = String(input?.format ?? '?');

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
              accent={CANVA_BRAND.coral}
              icon={<Download size={16} color={CANVA_BRAND.coral} />}
              size={28}
            />
          }
          title={`Export → ${format.toUpperCase()}`}
          subtitle={job.id ? `job ${job.id}` : undefined}
          meta={<StatusChip status={job.status} />}
        >
          <KeyValueGrid rows={jobMetaRows(input as Record<string, unknown>)} />
          {job.error && (
            <Text color={globalColors.failed} fontSize={10}>
              {job.error.message ?? job.error.code ?? 'Export failed'}
            </Text>
          )}
        </ResourceCard>
      )}
    </CanvaToolShell>
  );
}

// ============================================================================
// get-export-job — shows urls when status=success
// ============================================================================

export function GetExportJobRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const parsed = output ? parseOutput<unknown>(output) : null;
  const job = narrowObject<CanvaJob<{ urls: string[] }>>(parsed);
  const urls = job?.result?.urls ?? [];

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
              accent={JOB_STATUS_ACCENTS[job.status ?? ''] ?? globalColors.muted}
              icon={<Download size={16} color={JOB_STATUS_ACCENTS[job.status ?? ''] ?? globalColors.muted} />}
              size={28}
            />
          }
          title="Export job"
          subtitle={job.id ?? undefined}
          meta={<StatusChip status={job.status} />}
        >
          {job.error && (
            <Text color={globalColors.failed} fontSize={10}>
              {job.error.message ?? job.error.code ?? 'Job failed'}
            </Text>
          )}
          {urls.length > 0 && (
            <YStack gap={4}>
              <Text color={globalColors.secondary} fontSize={9} fontFamily="$mono" textTransform="uppercase">
                downloads ({urls.length})
              </Text>
              {urls.map((url: string, i: number) => (
                <XStack
                  // biome-ignore lint/suspicious/noArrayIndexKey: stable ordered
                  key={i}
                  gap={6}
                  alignItems="center"
                  onPress={() => Linking.openURL(url)}
                >
                  <ExternalLink size={10} color={CANVA_BRAND.teal} />
                  <Text color={CANVA_BRAND.teal} fontSize={10} fontFamily="$mono" numberOfLines={1}>
                    page {i + 1}
                  </Text>
                </XStack>
              ))}
            </YStack>
          )}
        </ResourceCard>
      )}
    </CanvaToolShell>
  );
}

// ============================================================================
// create-resize-job — kick off
// ============================================================================

export function CreateResizeJobRenderer({
  toolName,
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const parsed = output ? parseOutput<unknown>(output) : null;
  const job = narrowObject<CanvaJob<CanvaDesign>>(parsed);
  const designType = String(input?.designType ?? '?');

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
              accent={CANVA_BRAND.purple}
              icon={<Maximize2 size={16} color={CANVA_BRAND.purple} />}
              size={28}
            />
          }
          title={`Resize → ${designType}`}
          subtitle={job.id ? `job ${job.id}` : undefined}
          meta={<StatusChip status={job.status} />}
        >
          <KeyValueGrid rows={jobMetaRows(input as Record<string, unknown>)} />
        </ResourceCard>
      )}
    </CanvaToolShell>
  );
}

// ============================================================================
// get-resize-job — polaroid of the new design when success
// ============================================================================

export function GetResizeJobRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const parsed = output ? parseOutput<unknown>(output) : null;
  const job = narrowObject<CanvaJob<CanvaDesign>>(parsed);
  const design = job?.result ?? null;

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
            design?.thumbnailUrl ? (
              <Polaroid
                url={design.thumbnailUrl}
                width={120}
                height={90}
                thumbnailWidth={design.thumbnailWidth}
                thumbnailHeight={design.thumbnailHeight}
                alt={design.title}
              />
            ) : (
              <IconTile
                accent={JOB_STATUS_ACCENTS[job.status ?? ''] ?? globalColors.muted}
                icon={<Maximize2 size={16} color={JOB_STATUS_ACCENTS[job.status ?? ''] ?? globalColors.muted} />}
                size={36}
              />
            )
          }
          title={design?.title ?? 'Resize job'}
          subtitle={job.id ?? undefined}
          meta={<StatusChip status={job.status} />}
        >
          {job.error && (
            <Text color={globalColors.failed} fontSize={10}>
              {job.error.message ?? job.error.code ?? 'Job failed'}
            </Text>
          )}
          {design?.editUrl && (
            <XStack
              onPress={() => {
                if (design?.editUrl) void Linking.openURL(design.editUrl);
              }}
              cursor="pointer"
            >
              <IconChip
                text="Open new design"
                accent={CANVA_BRAND.teal}
                icon={<ExternalLink size={9} color={CANVA_BRAND.teal} />}
              />
            </XStack>
          )}
        </ResourceCard>
      )}
    </CanvaToolShell>
  );
}
