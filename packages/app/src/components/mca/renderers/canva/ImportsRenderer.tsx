/**
 * Canva Renderer — Design imports (URL import).
 *
 * Handles: import-design, get-import-job.
 */

import { ExternalLink, Upload } from '../../primitives';
import { Linking } from 'react-native';
import { Text, XStack } from 'tamagui';
import {
  IconChip,
  IconTile,
  KeyValueGrid,
  type KeyValueRow,
  ResourceCard,
  colors as globalColors,
  parseOutput,
  ErrorBlock,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import {
  CANVA_BRAND,
  type CanvaJob,
  CanvaToolShell,
  JOB_STATUS_ACCENTS,
  JOB_STATUS_LABELS,
  narrowObject,
  shortId,
} from './shared';

function StatusChip({ status }: { status: string | null }) {
  const accent = (status && JOB_STATUS_ACCENTS[status]) ?? globalColors.muted;
  const text = (status && JOB_STATUS_LABELS[status]) ?? (status ?? '—').toUpperCase();
  return <IconChip text={text} accent={accent} />;
}

export function ImportDesignRenderer({
  toolName,
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const parsed = output ? parseOutput<unknown>(output) : null;
  const job = narrowObject<CanvaJob<{ designId: string | null }>>(parsed);
  const url = String(input?.url ?? '');
  const rows: KeyValueRow[] = [];
  if (input?.title) rows.push({ key: 'title', value: String(input.title) });
  if (input?.mimeType) rows.push({ key: 'mimeType', value: String(input.mimeType) });
  if (url) rows.push({ key: 'source', value: shortId(url, 36, 8) });

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
              accent={CANVA_BRAND.mint}
              icon={<Upload size={16} color={CANVA_BRAND.mint} />}
              size={28}
            />
          }
          title="Import design"
          subtitle={job.id ? `job ${job.id}` : undefined}
          meta={<StatusChip status={job.status} />}
        >
          <KeyValueGrid rows={rows} />
        </ResourceCard>
      )}
    </CanvaToolShell>
  );
}

export function GetImportJobRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const parsed = output ? parseOutput<unknown>(output) : null;
  const job = narrowObject<CanvaJob<{ designId: string | null }>>(parsed);
  const designId = job?.result?.designId ?? null;

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
              icon={<Upload size={16} color={JOB_STATUS_ACCENTS[job.status ?? ''] ?? globalColors.muted} />}
              size={28}
            />
          }
          title="Import job"
          subtitle={job.id ?? undefined}
          meta={<StatusChip status={job.status} />}
        >
          {job.error && (
            <Text color={globalColors.failed} fontSize={10}>
              {job.error.message ?? job.error.code ?? 'Job failed'}
            </Text>
          )}
          {designId && (
            <XStack
              onPress={() =>
                void Linking.openURL(`https://www.canva.com/design/${encodeURIComponent(designId)}`)
              }
              cursor="pointer"
            >
              <IconChip
                text={`Design ${shortId(designId)}`}
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
