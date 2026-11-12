/**
 * Figma Renderer — get-comments, create-comment, delete-comment.
 *
 * Read: `EntityRow` list with Avatar(handle).
 * Create: `ResourceCard` with `verb="created"` showing the new comment.
 * Delete: `EntityCard`-like compact card with `ActionBadge verb="deleted"`.
 */

import { MessageSquare, Trash2 } from "@tamagui/lucide-icons"
import { useTranslation } from "react-i18next"
import { ScrollView } from "react-native"
import { Text, XStack, YStack } from "tamagui"
import {
  Avatar,
  Empty,
  EntityCard,
  EntityRow,
  ErrorBlock,
  IconChip,
  IconTile,
  parseOutput,
  ResourceCard,
  useColors,
} from "../../primitives"
import type { ToolCallRendererProps } from "../../types"
import {
  FIGMA_PALETTE,
  type FigmaComment,
  FigmaToolShell,
  formatDate,
  formatDateTime,
  getCommentAuthor,
  scrollStyle,
  truncate,
  unwrapList,
} from "./shared"

// ============================================================================
// get-comments
// ============================================================================

export function GetCommentsRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const palette = useColors()
  const { t } = useTranslation()
  const parsed = output ? parseOutput(output) : null
  const { items, count } = unwrapList<FigmaComment>(parsed, "comments")

  return (
    <FigmaToolShell
      toolName={toolName}
      status={status}
      description={count != null ? `Comments (${count})` : undefined}
    >
      {error && <ErrorBlock error={error} />}
      {!error && items.length === 0 && <Empty message={t('mca.figma.noComments')} />}
      {!error && items.length > 0 && (
        <ScrollView style={scrollStyle(320)}>
          <YStack>
            {items.map((c) => {
              const author = getCommentAuthor(c)
              return (
                <EntityRow
                  key={c.id}
                  leading={<Avatar name={author} size={22} />}
                  title={author}
                  subtitle={truncate(c.message, 80)}
                  badges={
                    <XStack gap={3}>
                      {c.parentId && <IconChip text={t('mca.figma.reply')} accent={FIGMA_PALETTE.purple} />}
                      {c.resolved && <IconChip text={t('mca.figma.resolved')} accent={palette.text3} />}
                    </XStack>
                  }
                  meta={
                    <Text color={palette.text2} fontSize={9} fontFamily="$mono">
                      {formatDate(c.createdAt)}
                    </Text>
                  }
                />
              )
            })}
          </YStack>
        </ScrollView>
      )}
    </FigmaToolShell>
  )
}

// ============================================================================
// create-comment
// ============================================================================

export function CreateCommentRenderer({
  toolName,
  status,
  output,
  error,
  duration,
  input,
}: ToolCallRendererProps) {
  const c = useColors()
  const { t } = useTranslation()
  const comment = output ? (parseOutput<FigmaComment>(output) as FigmaComment | null) : null

  return (
    <FigmaToolShell
      toolName={toolName}
      status={status}
      defaultExpanded={status === "completed"}
    >
      {error && <ErrorBlock error={error} />}
      {!error && comment && (
        <ResourceCard
          leading={<Avatar name={getCommentAuthor(comment)} size={28} />}
          title={getCommentAuthor(comment)}
          subtitle={comment.parentId ? `Reply to ${comment.parentId}` : t('mca.figma.newComment')}
          verb="created"
          meta={
            <Text color={c.text2} fontSize={9} fontFamily="$mono">
              {formatDateTime(comment.createdAt)}
            </Text>
          }
        >
          <Text color={c.text} fontSize={11}>
            {comment.message}
          </Text>
          {input?.fileKey && (
            <Text color={c.text3} fontSize={9} fontFamily="$mono">
              file: {String(input.fileKey)}
            </Text>
          )}
        </ResourceCard>
      )}
    </FigmaToolShell>
  )
}

// ============================================================================
// delete-comment
// ============================================================================

export function DeleteCommentRenderer({
  toolName,
  status,
  output,
  error,
  duration,
  input,
}: ToolCallRendererProps) {
  const c = useColors()
  const { t } = useTranslation()
  const result = output
    ? (parseOutput<{ ok?: boolean; commentId?: string; fileKey?: string }>(output) as {
        ok?: boolean
        commentId?: string
        fileKey?: string
      } | null)
    : null
  const commentId = result?.commentId ?? (input?.commentId as string | undefined) ?? "—"
  const fileKey = result?.fileKey ?? (input?.fileKey as string | undefined) ?? "—"

  return (
    <FigmaToolShell toolName={toolName} status={status}>
      {error && <ErrorBlock error={error} />}
      {!error && status === "completed" && (
        <EntityCard title={t('mca.figma.commentDeleted')}>
          <XStack gap={8} alignItems="center" paddingHorizontal={10} paddingVertical={8}>
            <IconTile
              accent={FIGMA_PALETTE.red}
              icon={<Trash2 size={14} color={FIGMA_PALETTE.red} />}
              size={28}
            />
            <YStack flex={1} gap={2}>
              <Text color={c.text} fontSize={11} fontWeight="500">
                {t('mca.figma.commentDeleted')}
              </Text>
              <Text color={c.text2} fontSize={9} fontFamily="$mono">
                {commentId} · file {fileKey}
              </Text>
            </YStack>
            <IconChip
              text={t('mca.figma.deleted')}
              accent={FIGMA_PALETTE.red}
              icon={<MessageSquare size={9} color={FIGMA_PALETTE.red} />}
            />
          </XStack>
        </EntityCard>
      )}
    </FigmaToolShell>
  )
}
