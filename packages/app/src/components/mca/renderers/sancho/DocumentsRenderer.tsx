/**
 * Sancho Renderer — Brand Brain document tools.
 *
 *  - `list-documents` rows: path, title, size, updatedAt, hasMore pagination.
 *  - `get-document`  title + heading outline + markdown content in a
 *                    scrollable body; long content truncated with a char
 *                    counter (the tool itself pages via offset/maxChars).
 */

import { FileText } from '../../primitives';
import { ScrollView } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';

import {
  Badge,
  countBadgeVariant,
  Empty,
  EntityRow,
  ErrorBlock,
  formatCountBadge,
  IconChip,
  IconTile,
  ResourceCard,
  useColors,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import {
  formatBytes,
  formatDate,
  narrowObject,
  parseSanchoOutput,
  pickText,
  SanchoToolShell,
  truncate,
  unwrapList,
  useScrollStyle,
  type SanchoDocumentListItem,
} from './shared';

// ============================================================================
// list-documents — rows with path, title, size, updatedAt, hasMore
// ============================================================================

const MAX_DOCS = 50;

export function ListDocumentsRenderer({
  toolName,
  input,
  status,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useColors();
  // Hoisted above the conditional JSX below: hooks must run unconditionally,
  // or a status/items change flips the branch and the hook count with it.
  const scrollStyle = useScrollStyle(320);
  const parsed = parseSanchoOutput<unknown>(output);
  const { items: documents, matched, hasMore } = unwrapList<SanchoDocumentListItem>(
    parsed,
    'documents',
  );

  const filters: string[] = [];
  if (input?.pathPrefix) filters.push(String(input.pathPrefix));
  if (input?.query) filters.push(`"${String(input.query)}"`);
  const description = filters.length ? `Brand documents (${filters.join(', ')})` : 'Brand documents';

  return (
    <SanchoToolShell
      toolName={toolName}
      status={status}
      description={description}
      badge={
        status === 'completed' ? (
          <Badge
            text={formatCountBadge(matched ?? documents.length, 'document')}
            variant={countBadgeVariant(matched ?? documents.length)}
          />
        ) : undefined
      }
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && (
        <>
          {documents.length === 0 ? (
            <Empty
              message="No documents matched"
              hint={hasMore ? 'First page — narrow with pathPrefix or query.' : undefined}
            />
          ) : (
            <ScrollView style={scrollStyle} showsVerticalScrollIndicator>
              <YStack>
                {documents.slice(0, MAX_DOCS).map((d) => (
                  <EntityRow
                    key={d.path}
                    leading={<IconTile icon={<FileText size={12} color={c.accent} />} size={24} />}
                    title={d.title ?? d.path}
                    subtitle={d.title ? d.path : undefined}
                    meta={
                      <XStack gap={4} alignItems="center">
                        {formatBytes(d.size) && (
                          <IconChip text={formatBytes(d.size) ?? ''} accent={c.accent} />
                        )}
                        {formatDate(d.updatedAt) && (
                          <Text color={c.text3} fontSize={9} fontFamily="$mono">
                            {formatDate(d.updatedAt)}
                          </Text>
                        )}
                      </XStack>
                    }
                  />
                ))}
              </YStack>
            </ScrollView>
          )}
          {hasMore && (
            <XStack gap={6} justifyContent="flex-end" paddingHorizontal={4} paddingTop={2}>
              <Text color={c.text3} fontSize={9} fontFamily="$mono">
                first page — more documents available
              </Text>
            </XStack>
          )}
        </>
      )}
    </SanchoToolShell>
  );
}

// ============================================================================
// get-document — title + outline + scrollable content
// ============================================================================

const MAX_OUTLINE = 24;
const MAX_CONTENT_CHARS = 2000;

/** Outline entries arrive either as `{ number, text }` or plain strings. */
function outlineLabel(h: unknown): string {
  if (typeof h === 'string') return h;
  const o = narrowObject<Record<string, unknown>>(h);
  if (!o) return '';
  const num = pickText(o, ['number', 'id']);
  const text = pickText(o, ['text', 'title', 'heading']);
  return [num, text].filter(Boolean).join(' ');
}

export function GetDocumentRenderer({
  toolName,
  input,
  status,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useColors();
  // Hoisted above the conditional JSX below: hooks must run unconditionally,
  // or a status/items change flips the branch and the hook count with it.
  const scrollStyle = useScrollStyle(280);
  const parsed = parseSanchoOutput<unknown>(output);
  const o = narrowObject<Record<string, unknown>>(parsed);

  const title = pickText(o, ['title']) ?? (typeof input?.docPath === 'string' ? input.docPath : 'Document');
  const path = pickText(o, ['path']) ?? (typeof input?.docPath === 'string' ? input.docPath : undefined);
  const content = pickText(o, ['content', 'text']) ?? '';
  const outline = Array.isArray(o?.outline) ? (o.outline as unknown[]) : [];
  const nextOffset = typeof o?.nextOffset === 'number' ? o.nextOffset : undefined;
  const totalChars = typeof o?.totalChars === 'number' ? o.totalChars : undefined;

  const truncated = content.length > MAX_CONTENT_CHARS;
  const shownContent = truncated ? content.slice(0, MAX_CONTENT_CHARS) : content;

  return (
    <SanchoToolShell
      toolName={toolName}
      status={status}
      description={`Document · ${truncate(title, 44)}`}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && o && (
        <ResourceCard
          leading={<IconTile icon={<FileText size={16} color={c.accent} />} size={30} />}
          title={title}
          subtitle={path}
          meta={
            <IconChip
              text={totalChars != null ? `${totalChars} chars` : 'document'}
              accent={c.accent}
            />
          }
        >
          {outline.length > 0 && (
            <YStack gap={4}>
              <Text color={c.text3} fontSize={9} fontFamily="$mono">
                {`OUTLINE (${outline.length} HEADINGS)`}
              </Text>
              <YStack gap={2}>
                {outline.slice(0, MAX_OUTLINE).map((h, i) => (
                  <Text
                    // biome-ignore lint/suspicious/noArrayIndexKey: server-ordered
                    key={`${outlineLabel(h)}-${i}`}
                    color={c.text2}
                    fontSize={10}
                    fontFamily="$mono"
                    numberOfLines={1}
                  >
                    {outlineLabel(h) || '—'}
                  </Text>
                ))}
                {outline.length > MAX_OUTLINE && (
                  <Text color={c.text3} fontSize={9} fontFamily="$mono">
                    +{outline.length - MAX_OUTLINE} more headings
                  </Text>
                )}
              </YStack>
            </YStack>
          )}
          {shownContent && (
            <YStack gap={4}>
              <ScrollView style={scrollStyle} showsVerticalScrollIndicator>
                <Text color={c.text} fontSize={10} lineHeight={15}>
                  {shownContent}
                </Text>
              </ScrollView>
              {(truncated || nextOffset != null) && (
                <XStack gap={6} justifyContent="flex-end">
                  <Text color={c.text3} fontSize={9} fontFamily="$mono">
                    {truncated
                      ? `… ${content.length.toLocaleString()} chars — read more with offset`
                      : nextOffset != null
                        ? `more from offset ${nextOffset}`
                        : ''}
                  </Text>
                </XStack>
              )}
            </YStack>
          )}
        </ResourceCard>
      )}
    </SanchoToolShell>
  );
}
