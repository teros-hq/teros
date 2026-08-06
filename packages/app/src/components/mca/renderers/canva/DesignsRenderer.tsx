/**
 * Canva Renderer — Designs domain.
 *
 * Handles: list-designs, get-design, create-design,
 *          get-design-pages, get-design-export-formats.
 *
 * Polaroid pattern (TER-270): designs always render with thumbnail
 * preview when available; falls back to placeholder if Canva expired
 * the URL (30-day TTL per docs).
 */

import { ExternalLink, FileText, Image as ImageIcon, Plus } from '../../primitives';
import { Linking, ScrollView } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';

import {
  ActionBadge,
  Empty,
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
  type CanvaDesign,
  CanvaToolShell,
  DESIGN_TYPE_COLORS,
  Polaroid,
  formatTimestamp,
  narrowObject,
  useScrollStyle,
  unwrap,
  unwrapList,
} from './shared';

interface DesignPagesShape {
  pages?: Array<{ index?: number | null; thumbnailUrl?: string | null; width?: number | null; height?: number | null }>;
}
interface ExportFormatsShape {
  formats?: string[];
}

function designDetailRows(d: CanvaDesign): KeyValueRow[] {
  const rows: KeyValueRow[] = [];
  if (d.pageCount != null) rows.push({ key: 'pages', value: String(d.pageCount) });
  if (d.thumbnailWidth && d.thumbnailHeight)
    rows.push({ key: 'thumbnail', value: `${d.thumbnailWidth}×${d.thumbnailHeight}` });
  if (d.ownerUserId) rows.push({ key: 'ownerUserId', value: d.ownerUserId });
  if (d.ownerTeamId) rows.push({ key: 'ownerTeamId', value: d.ownerTeamId });
  if (d.createdAt) rows.push({ key: 'createdAt', value: formatTimestamp(d.createdAt) });
  if (d.updatedAt) rows.push({ key: 'updatedAt', value: formatTimestamp(d.updatedAt) });
  return rows;
}

// ============================================================================
// list-designs — polaroid grid
// ============================================================================

export function ListDesignsRenderer({
  toolName,
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const parsed = output ? parseOutput<unknown>(output) : null;
  const { items: designs, nextCursor, total } = unwrapList<CanvaDesign>(parsed, 'designs');

  const filters: string[] = [];
  if (input?.query) filters.push(`"${String(input.query)}"`);
  if (input?.ownership) filters.push(`ownership ${input.ownership}`);
  if (input?.sortBy) filters.push(`sort ${input.sortBy}`);
  const description = filters.length ? `Designs (${filters.join(', ')})` : undefined;

  return (
    <CanvaToolShell
      toolName={toolName}
      status={status}
      description={description}
      defaultExpanded={status === 'completed' && designs.length > 0}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && (
        <>
          {designs.length === 0 ? (
            <Empty message="No designs" />
          ) : (
            <ScrollView style={useScrollStyle(360)} showsVerticalScrollIndicator>
              <XStack flexWrap="wrap" gap={8} padding={4}>
                {designs.map((d) => (
                  <Polaroid
                    key={d.id ?? Math.random()}
                    url={d.thumbnailUrl}
                    width={140}
                    height={105}
                    thumbnailWidth={d.thumbnailWidth}
                    thumbnailHeight={d.thumbnailHeight}
                    caption={d.title ?? 'Untitled'}
                    subCaption={d.pageCount != null ? `${d.pageCount} page${d.pageCount === 1 ? '' : 's'}` : undefined}
                    alt={d.title}
                  />
                ))}
              </XStack>
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
                  · more · cursor available
                </Text>
              )}
            </XStack>
          )}
        </>
      )}
    </CanvaToolShell>
  );
}

// ============================================================================
// get-design — polaroid + key-values + open in Canva
// ============================================================================

export function GetDesignRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const parsed = output ? parseOutput<unknown>(output) : null;
  const d = unwrap<CanvaDesign>(parsed, 'design');

  return (
    <CanvaToolShell
      toolName={toolName}
      status={status}
      defaultExpanded={status === 'completed'}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && d && (
        <YStack gap={8}>
          <ResourceCard
            leading={
              <Polaroid
                url={d.thumbnailUrl}
                width={140}
                height={105}
                thumbnailWidth={d.thumbnailWidth}
                thumbnailHeight={d.thumbnailHeight}
                alt={d.title}
              />
            }
            title={d.title ?? 'Untitled design'}
            subtitle={d.id ? `id ${d.id}` : undefined}
            meta={
              d.editUrl ? (
                <XStack
                  onPress={() => {
                    if (d.editUrl) void Linking.openURL(d.editUrl);
                  }}
                  cursor="pointer"
                >
                  <IconChip
                    text="Edit in Canva"
                    accent={CANVA_BRAND.teal}
                    icon={<ExternalLink size={9} color={CANVA_BRAND.teal} />}
                  />
                </XStack>
              ) : undefined
            }
          >
            <KeyValueGrid rows={designDetailRows(d)} />
          </ResourceCard>
        </YStack>
      )}
    </CanvaToolShell>
  );
}

// ============================================================================
// create-design — ResourceCard + ActionBadge('created') + polaroid if returned
// ============================================================================

export function CreateDesignRenderer({
  toolName,
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const parsed = output ? parseOutput<unknown>(output) : null;
  const d = unwrap<CanvaDesign>(parsed, 'design');
  const designType = String(input?.designType ?? 'custom');
  const accent = DESIGN_TYPE_COLORS[designType] ?? CANVA_BRAND.teal;

  return (
    <CanvaToolShell
      toolName={toolName}
      status={status}
      defaultExpanded={status === 'completed'}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && d && (
        <ResourceCard
          leading={
            d.thumbnailUrl ? (
              <Polaroid
                url={d.thumbnailUrl}
                width={120}
                height={90}
                thumbnailWidth={d.thumbnailWidth}
                thumbnailHeight={d.thumbnailHeight}
                alt={d.title}
              />
            ) : (
              <IconTile accent={accent} icon={<Plus size={16} color={accent} />} size={36} />
            )
          }
          title={d.title ?? input?.title ?? 'New design'}
          subtitle={`${designType} • ${d.id ?? '—'}`}
          meta={<ActionBadge verb="created" />}
        >
          <KeyValueGrid rows={designDetailRows(d)} />
          {d.editUrl ? (
            <XStack
              onPress={() => {
                if (d.editUrl) void Linking.openURL(d.editUrl);
              }}
              cursor="pointer"
            >
              <IconChip
                text="Open in Canva"
                accent={CANVA_BRAND.teal}
                icon={<ExternalLink size={9} color={CANVA_BRAND.teal} />}
              />
            </XStack>
          ) : null}
        </ResourceCard>
      )}
    </CanvaToolShell>
  );
}

// ============================================================================
// get-design-pages — grid of polaroids
// ============================================================================

export function GetDesignPagesRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const parsed = output ? parseOutput<unknown>(output) : null;
  const data = narrowObject<DesignPagesShape>(parsed);
  const pages = data?.pages ?? [];

  return (
    <CanvaToolShell
      toolName={toolName}
      status={status}
      defaultExpanded={status === 'completed' && pages.length > 0}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && (
        <>
          {pages.length === 0 ? (
            <Empty message="No pages" />
          ) : (
            <ScrollView style={useScrollStyle(320)} showsVerticalScrollIndicator>
              <XStack flexWrap="wrap" gap={8} padding={4}>
                {pages.map((p: { index?: number | null; thumbnailUrl?: string | null; width?: number | null; height?: number | null }, i: number) => (
                  <Polaroid
                    // biome-ignore lint/suspicious/noArrayIndexKey: ordered page list
                    key={i}
                    url={p.thumbnailUrl ?? null}
                    width={120}
                    height={90}
                    thumbnailWidth={p.width}
                    thumbnailHeight={p.height}
                    caption={`Page ${(p.index ?? i) + 1}`}
                    subCaption={p.width && p.height ? `${p.width}×${p.height}` : undefined}
                  />
                ))}
              </XStack>
            </ScrollView>
          )}
        </>
      )}
    </CanvaToolShell>
  );
}

// ============================================================================
// get-design-export-formats — chip list
// ============================================================================

export function GetDesignExportFormatsRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const parsed = output ? parseOutput<unknown>(output) : null;
  const data = narrowObject<ExportFormatsShape>(parsed);
  const formats = data?.formats ?? [];

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
              accent={CANVA_BRAND.mint}
              icon={<FileText size={16} color={CANVA_BRAND.mint} />}
              size={28}
            />
          }
          title={`${formats.length} supported format${formats.length === 1 ? '' : 's'}`}
        >
          {formats.length === 0 ? (
            <Empty message="No export formats reported." />
          ) : (
            <XStack flexWrap="wrap" gap={4}>
              {formats.map((f: string) => (
                <IconChip
                  key={f}
                  text={f.toUpperCase()}
                  accent={CANVA_BRAND.mint}
                  icon={<ImageIcon size={9} color={CANVA_BRAND.mint} />}
                />
              ))}
            </XStack>
          )}
        </ResourceCard>
      )}
    </CanvaToolShell>
  );
}
