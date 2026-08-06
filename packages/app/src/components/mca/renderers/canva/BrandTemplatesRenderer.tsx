/**
 * Canva Renderer — Brand Templates + Autofill domain.
 *
 * Handles: list-brand-templates, get-brand-template, get-brand-template-dataset,
 *          autofill-design, get-autofill-job.
 */

import { Database, ExternalLink, Layout, Sparkles } from '../../primitives';
import { Linking, ScrollView } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';

import {
  Empty,
  EntityRow,
  ErrorBlock,
  formatOutput,
  IconChip,
  IconTile,
  KeyValueGrid,
  type KeyValueRow,
  ResourceCard,
  colors as globalColors,
  parseOutput,
  useColors,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import {
  CANVA_BRAND,
  type CanvaBrandTemplate,
  type CanvaDesign,
  type CanvaJob,
  CanvaToolShell,
  JOB_STATUS_ACCENTS,
  JOB_STATUS_LABELS,
  Polaroid,
  formatTimestamp,
  narrowObject,
  useScrollStyle,
  unwrap,
  unwrapList,
} from './shared';

function StatusChip({ status }: { status: string | null }) {
  const accent = (status && JOB_STATUS_ACCENTS[status]) ?? globalColors.muted;
  const text = (status && JOB_STATUS_LABELS[status]) ?? (status ?? '—').toUpperCase();
  return <IconChip text={text} accent={accent} />;
}

function templateRows(t: CanvaBrandTemplate): KeyValueRow[] {
  const rows: KeyValueRow[] = [];
  if (t.id) rows.push({ key: 'id', value: t.id });
  if (t.createdAt) rows.push({ key: 'createdAt', value: formatTimestamp(t.createdAt) });
  if (t.updatedAt) rows.push({ key: 'updatedAt', value: formatTimestamp(t.updatedAt) });
  return rows;
}

export function ListBrandTemplatesRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const parsed = output ? parseOutput<unknown>(output) : null;
  const { items, total, nextCursor } = unwrapList<CanvaBrandTemplate>(parsed, 'templates');

  return (
    <CanvaToolShell
      toolName={toolName}
      status={status}
      defaultExpanded={status === 'completed' && items.length > 0}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && (
        <>
          {items.length === 0 ? (
            <Empty message="No brand templates" />
          ) : (
            <ScrollView style={useScrollStyle(360)} showsVerticalScrollIndicator>
              <XStack flexWrap="wrap" gap={8} padding={4}>
                {items.map((t) => (
                  <Polaroid
                    key={t.id ?? Math.random()}
                    url={t.thumbnailUrl}
                    width={140}
                    height={105}
                    caption={t.title ?? 'Untitled'}
                  />
                ))}
              </XStack>
            </ScrollView>
          )}
          {(typeof total === 'number' || nextCursor) && (
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

export function GetBrandTemplateRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const parsed = output ? parseOutput<unknown>(output) : null;
  const t = unwrap<CanvaBrandTemplate>(parsed, 'brand_template');

  return (
    <CanvaToolShell
      toolName={toolName}
      status={status}
      defaultExpanded={status === 'completed'}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && t && (
        <ResourceCard
          leading={
            t.thumbnailUrl ? (
              <Polaroid url={t.thumbnailUrl} width={140} height={105} alt={t.title ?? undefined} />
            ) : (
              <IconTile
                accent={CANVA_BRAND.purple}
                icon={<Layout size={16} color={CANVA_BRAND.purple} />}
                size={28}
              />
            )
          }
          title={t.title ?? 'Untitled template'}
          subtitle={t.id ?? undefined}
          meta={
            t.viewUrl ? (
              <XStack
                onPress={() => {
                  if (t.viewUrl) void Linking.openURL(t.viewUrl);
                }}
                cursor="pointer"
              >
                <IconChip
                  text="View"
                  accent={CANVA_BRAND.purple}
                  icon={<ExternalLink size={9} color={CANVA_BRAND.purple} />}
                />
              </XStack>
            ) : undefined
          }
        >
          <KeyValueGrid rows={templateRows(t)} />
        </ResourceCard>
      )}
    </CanvaToolShell>
  );
}

export function GetBrandTemplateDatasetRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const parsed = output ? parseOutput<unknown>(output) : null;

  return (
    <CanvaToolShell
      toolName={toolName}
      status={status}
      defaultExpanded={status === 'completed'}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && <DatasetCard parsed={parsed} />}
    </CanvaToolShell>
  );
}

function DatasetCard({ parsed }: { parsed: unknown }) {
  const c = useColors();
  return (
    <ResourceCard
      leading={
        <IconTile
          accent={CANVA_BRAND.mint}
          icon={<Database size={16} color={CANVA_BRAND.mint} />}
          size={28}
        />
      }
      title="Template dataset"
      subtitle="Field names ↔ types"
    >
      {parsed ? (
        // Guide §7 DON'T: never show raw JSON as default body. Pretty-print
        // structured fields inline with the same shape FallbackBody uses.
        <ScrollView style={{ maxHeight: 280 }} showsVerticalScrollIndicator>
          <Text
            color={c.text2}
            fontSize={10}
            fontFamily="$mono"
            paddingHorizontal={4}
          >
            {formatOutput(JSON.stringify(parsed))}
          </Text>
        </ScrollView>
      ) : (
        <Empty message="No dataset" />
      )}
    </ResourceCard>
  );
}

export function AutofillDesignRenderer({
  toolName,
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const parsed = output ? parseOutput<unknown>(output) : null;
  const job = narrowObject<CanvaJob<CanvaDesign>>(parsed);
  const fields = input?.data ? Object.keys(input.data as Record<string, unknown>).length : 0;

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
              icon={<Sparkles size={16} color={CANVA_BRAND.purple} />}
              size={28}
            />
          }
          title="Autofill template"
          subtitle={job.id ? `job ${job.id} · ${fields} field${fields === 1 ? '' : 's'}` : undefined}
          meta={<StatusChip status={job.status} />}
        />
      )}
    </CanvaToolShell>
  );
}

export function GetAutofillJobRenderer({
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
                icon={
                  <Sparkles size={16} color={JOB_STATUS_ACCENTS[job.status ?? ''] ?? globalColors.muted} />
                }
                size={36}
              />
            )
          }
          title={design?.title ?? 'Autofill job'}
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
