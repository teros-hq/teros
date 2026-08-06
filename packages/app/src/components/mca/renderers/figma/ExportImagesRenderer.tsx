/**
 * Figma Renderer — export-images.
 *
 * URLs are pre-signed S3 links and expire ~30 minutes after generation.
 * The exported image IS the content (not metadata), so we use a polaroid
 * grid of large thumbnails (max-width 240, aspect ratio 3:2) instead of
 * the leading-icon EntityRow pattern that fits other Figma tools.
 *
 * PNG / JPG render as inline images. SVG / PDF use an icon placeholder
 * + external link button — RN Image cannot decode either cross-platform.
 */

import { ExternalLink, FileImage } from "@tamagui/lucide-icons"
import { useTranslation } from "react-i18next"
import { Linking } from "react-native"
import { Image, Text, XStack, YStack } from "tamagui"
import {
  Empty,
  ErrorBlock,
  colors as globalColors,
  IconChip,
  IconTile,
  parseOutput,
  useColors,
} from "../../primitives"
import type { ToolCallRendererProps } from "../../types"
import { FIGMA_PALETTE, type FigmaExportedImage, FigmaToolShell, unwrapList } from "./shared"

const INLINE_RENDER_CAP = 6
const THUMB_WIDTH = 240
const THUMB_HEIGHT = 160 // 3:2 aspect, fits typical Figma frame ratios

interface ExportImagesResponse {
  images?: FigmaExportedImage[]
  count?: number
  expiresInMinutes?: number
}

export function ExportImagesRenderer({
  toolName,
  status,
  output,
  error,
  duration,
  input,
}: ToolCallRendererProps) {
  const { t } = useTranslation()
  const parsed = output
    ? (parseOutput<ExportImagesResponse>(output) as ExportImagesResponse | null)
    : null
  const { items } = unwrapList<FigmaExportedImage>(parsed, "images")
  const fmt =
    (input?.format as string | undefined)?.toUpperCase() ?? items[0]?.format?.toUpperCase() ?? "PNG"
  const nodeIdsCount = Array.isArray(input?.nodeIds)
    ? (input.nodeIds as unknown[]).length
    : items.length

  return (
    <FigmaToolShell
      toolName={toolName}
      status={status}
      description={`Export ${nodeIdsCount} as ${fmt}`}
    >
      {error && <ErrorBlock error={error} />}
      {!error && items.length === 0 && <Empty message={t('mca.figma.noImagesReturned')} />}
      {!error && items.length > 0 && (
        <YStack gap={10}>
          <XStack gap={10} flexWrap="wrap">
            {items.slice(0, INLINE_RENDER_CAP).map((img) => (
              <PolaroidCard key={img.nodeId} img={img} />
            ))}
          </XStack>

          {items.length > INLINE_RENDER_CAP && (
            <Text color={globalColors.muted} fontSize={9}>
              + {items.length - INLINE_RENDER_CAP} more — see raw JSON for full list.
            </Text>
          )}

          <XStack gap={4}>
            <IconChip text={`${items.length} images`} accent={FIGMA_PALETTE.orange} />
            {parsed?.expiresInMinutes != null && (
              <IconChip text={`expires ~${parsed.expiresInMinutes}m`} accent={globalColors.muted} />
            )}
          </XStack>
        </YStack>
      )}
    </FigmaToolShell>
  )
}

// ============================================================================
// Polaroid card — image dominant, metadata below.
// ============================================================================

function PolaroidCard({ img }: { img: FigmaExportedImage }) {
  const c = useColors()
  const f = img.format?.toLowerCase() ?? "png"
  const renderable = f === "png" || f === "jpg" || f === "jpeg"

  return (
    <YStack
      width={THUMB_WIDTH}
      borderRadius={6}
      borderWidth={1}
      borderColor={globalColors.border}
      backgroundColor={c.bgInner}
      overflow="hidden"
    >
      {renderable && img.url ? (
        <Image
          source={{ uri: img.url }}
          width={THUMB_WIDTH}
          height={THUMB_HEIGHT}
          resizeMode="contain"
          backgroundColor={c.border}
        />
      ) : (
        <YStack
          width={THUMB_WIDTH}
          height={THUMB_HEIGHT}
          alignItems="center"
          justifyContent="center"
          backgroundColor={c.border}
        >
          <IconTile
            accent={FIGMA_PALETTE.orange}
            icon={<FileImage size={28} color={FIGMA_PALETTE.orange} />}
            size={56}
          />
          <Text color={globalColors.muted} fontSize={9} fontFamily="$mono" marginTop={6}>
            {f.toUpperCase()} · open externally
          </Text>
        </YStack>
      )}

      <XStack
        gap={6}
        paddingHorizontal={8}
        paddingVertical={6}
        alignItems="center"
        justifyContent="space-between"
      >
        <YStack flex={1} gap={2}>
          <Text color={globalColors.primary} fontSize={10} fontFamily="$mono" numberOfLines={1}>
            {img.nodeId}
          </Text>
          <Text color={globalColors.secondary} fontSize={9} fontFamily="$mono">
            {img.format.toUpperCase()} · {img.scale}x
          </Text>
        </YStack>
        {img.url && (
          <XStack
            cursor="pointer"
            onPress={() => Linking.openURL(img.url)}
            padding={5}
            borderRadius={3}
            hoverStyle={{ backgroundColor: c.borderStrong }}
          >
            <ExternalLink size={14} color={globalColors.secondary} />
          </XStack>
        )}
      </XStack>
    </YStack>
  )
}
