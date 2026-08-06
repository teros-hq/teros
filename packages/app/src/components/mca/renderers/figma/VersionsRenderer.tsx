/**
 * Figma Renderer — list-file-versions.
 *
 * Returns a paginated history. Render as `EntityRow` list with Avatar of the
 * author + label / description.
 */

import { History } from "@tamagui/lucide-icons"
import { useTranslation } from "react-i18next"
import { ScrollView } from "react-native"
import { Text, XStack, YStack } from "tamagui"
import {
  Avatar,
  Empty,
  EntityRow,
  ErrorBlock,
  colors as globalColors,
  IconChip,
  parseOutput,
} from "../../primitives"
import type { ToolCallRendererProps } from "../../types"
import {
  FIGMA_PALETTE,
  FigmaToolShell,
  type FigmaVersion,
  formatDateTime,
  getVersionAuthor,
  scrollStyle,
  shortId,
  truncate,
  unwrapList,
} from "./shared"

interface VersionsResponse {
  versions?: FigmaVersion[]
  count?: number
  nextPage?: string | null
}

export function ListFileVersionsRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const { t } = useTranslation()
  const parsed = output ? (parseOutput<VersionsResponse>(output) as VersionsResponse | null) : null
  const { items, count } = unwrapList<FigmaVersion>(parsed, "versions")
  const nextPage = parsed?.nextPage ?? null

  return (
    <FigmaToolShell
      toolName={toolName}
      status={status}
      description={count != null ? `Version history (${count})` : undefined}
    >
      {error && <ErrorBlock error={error} />}
      {!error && items.length === 0 && <Empty message={t('mca.figma.noVersions')} />}
      {!error && items.length > 0 && (
        <YStack gap={4}>
          <ScrollView style={scrollStyle(360)}>
            <YStack>
              {items.map((v) => {
                const author = getVersionAuthor(v)
                return (
                  <EntityRow
                    key={v.id}
                    leading={<Avatar name={author} size={22} />}
                    title={v.label?.trim() || `Version ${shortId(v.id)}`}
                    subtitle={v.description?.trim() ? truncate(v.description, 80) : `by ${author}`}
                    badges={
                      <XStack gap={3}>
                        <IconChip
                          text={shortId(v.id, 6, 4)}
                          accent={FIGMA_PALETTE.purple}
                          icon={<History size={9} color={FIGMA_PALETTE.purple} />}
                        />
                      </XStack>
                    }
                    meta={
                      <Text color={globalColors.secondary} fontSize={9} fontFamily="$mono">
                        {formatDateTime(v.createdAt)}
                      </Text>
                    }
                  />
                )
              })}
            </YStack>
          </ScrollView>
          {nextPage && (
            <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
              More versions available — pass `before` cursor to paginate.
            </Text>
          )}
        </YStack>
      )}
    </FigmaToolShell>
  )
}
