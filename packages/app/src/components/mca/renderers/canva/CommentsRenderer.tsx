/**
 * Canva Renderer — Comments domain (threads + replies).
 *
 * Handles: create-thread, get-thread, list-replies, create-reply, get-reply.
 */

import { CheckCircle2, MessageCircle, MessageSquare, Reply as ReplyIcon } from '../../primitives';
import { ScrollView } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';

import { MarkdownContent } from '../../../chat/bubbles/MarkdownContent';
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
  type CanvaReply,
  type CanvaThread,
  CanvaToolShell,
  formatTimestamp,
  useScrollStyle,
  shortId,
  unwrap,
  unwrapList,
} from './shared';

function threadRows(t: CanvaThread): KeyValueRow[] {
  const rows: KeyValueRow[] = [];
  if (t.designId) rows.push({ key: 'designId', value: t.designId });
  if (t.authorUserId) rows.push({ key: 'authorUserId', value: t.authorUserId });
  if (typeof t.resolved === 'boolean') rows.push({ key: 'resolved', value: t.resolved ? 'yes' : 'no' });
  if (t.createdAt) rows.push({ key: 'createdAt', value: formatTimestamp(t.createdAt) });
  return rows;
}

export function CreateThreadRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const parsed = output ? parseOutput<unknown>(output) : null;
  const t = unwrap<CanvaThread>(parsed, 'thread');

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
            <IconTile
              accent={CANVA_BRAND.purple}
              icon={<MessageSquare size={16} color={CANVA_BRAND.purple} />}
              size={28}
            />
          }
          title={`Thread ${shortId(t.id)}`}
          subtitle={t.designId ? `design ${shortId(t.designId)}` : undefined}
          meta={<ActionBadge verb="created" />}
        >
          {t.messagePlaintext ? (
            <YStack gap={4}>
              <Text color={globalColors.secondary} fontSize={9} fontFamily="$mono" textTransform="uppercase">
                message
              </Text>
              <MarkdownContent text={t.messagePlaintext} />
            </YStack>
          ) : null}
        </ResourceCard>
      )}
    </CanvaToolShell>
  );
}

export function GetThreadRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const parsed = output ? parseOutput<unknown>(output) : null;
  const t = unwrap<CanvaThread>(parsed, 'thread');

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
            <IconTile
              accent={t.resolved ? globalColors.success : CANVA_BRAND.purple}
              icon={
                t.resolved ? (
                  <CheckCircle2 size={16} color={globalColors.success} />
                ) : (
                  <MessageSquare size={16} color={CANVA_BRAND.purple} />
                )
              }
              size={28}
            />
          }
          title={`Thread ${shortId(t.id)}`}
          subtitle={t.designId ? `design ${shortId(t.designId)}` : undefined}
          meta={
            <IconChip
              text={t.resolved ? 'RESOLVED' : 'OPEN'}
              accent={t.resolved ? globalColors.success : CANVA_BRAND.purple}
            />
          }
        >
          {t.messagePlaintext ? <MarkdownContent text={t.messagePlaintext} /> : null}
          <KeyValueGrid rows={threadRows(t)} />
        </ResourceCard>
      )}
    </CanvaToolShell>
  );
}

export function ListRepliesRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const parsed = output ? parseOutput<unknown>(output) : null;
  const { items, total, nextCursor } = unwrapList<CanvaReply>(parsed, 'replies');

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
            <Empty message="No replies yet" />
          ) : (
            <ScrollView style={useScrollStyle(320)} showsVerticalScrollIndicator>
              <YStack gap={6}>
                {items.map((r) => (
                  <YStack
                    key={r.id ?? Math.random()}
                    gap={4}
                    padding={8}
                    borderRadius={5}
                    backgroundColor="rgba(125,42,232,0.08)"
                    borderWidth={1}
                    borderColor="rgba(125,42,232,0.2)"
                  >
                    <XStack gap={6} alignItems="center">
                      <ReplyIcon size={10} color={CANVA_BRAND.purple} />
                      <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
                        {r.authorUserId ? shortId(r.authorUserId) : '—'} · {formatTimestamp(r.createdAt)}
                      </Text>
                    </XStack>
                    {r.messagePlaintext ? <MarkdownContent text={r.messagePlaintext} /> : null}
                  </YStack>
                ))}
              </YStack>
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

export function CreateReplyRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const parsed = output ? parseOutput<unknown>(output) : null;
  const r = unwrap<CanvaReply>(parsed, 'reply');

  return (
    <CanvaToolShell
      toolName={toolName}
      status={status}
      defaultExpanded={status === 'completed'}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && r && (
        <ResourceCard
          leading={
            <IconTile
              accent={CANVA_BRAND.purple}
              icon={<ReplyIcon size={16} color={CANVA_BRAND.purple} />}
              size={28}
            />
          }
          title={`Reply ${shortId(r.id)}`}
          subtitle={r.threadId ? `thread ${shortId(r.threadId)}` : undefined}
          meta={<ActionBadge verb="created" />}
        >
          {r.messagePlaintext ? <MarkdownContent text={r.messagePlaintext} /> : null}
        </ResourceCard>
      )}
    </CanvaToolShell>
  );
}

export function GetReplyRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const parsed = output ? parseOutput<unknown>(output) : null;
  const r = unwrap<CanvaReply>(parsed, 'reply');

  return (
    <CanvaToolShell
      toolName={toolName}
      status={status}
      defaultExpanded={status === 'completed'}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && r && (
        <ResourceCard
          leading={
            <IconTile
              accent={CANVA_BRAND.purple}
              icon={<MessageCircle size={16} color={CANVA_BRAND.purple} />}
              size={28}
            />
          }
          title={`Reply ${shortId(r.id)}`}
          subtitle={r.threadId ? `thread ${shortId(r.threadId)}` : undefined}
        >
          {r.messagePlaintext ? <MarkdownContent text={r.messagePlaintext} /> : null}
        </ResourceCard>
      )}
    </CanvaToolShell>
  );
}
