/**
 * Figma Renderer — get-file, get-node.
 *
 * `get-file` returns a curated `FigmaFileSummary` with the top-level pages.
 * `get-node` returns a single `FigmaSimplifiedNode` (root-level, NOT wrapped).
 */

import { File } from "@tamagui/lucide-icons"
import { useTranslation } from "react-i18next"
import { ScrollView } from "react-native"
import { Image, Text, XStack, YStack } from "tamagui"
import {
  Empty,
  EntityRow,
  ErrorBlock,
  colors as globalColors,
  IconChip,
  IconTile,
  KeyValueGrid,
  type KeyValueRow,
  PillList,
  parseOutput,
  ResourceCard,
} from "../../primitives"
import type { ToolCallRendererProps } from "../../types"
import {
  FIGMA_PALETTE,
  type FigmaFileSummary,
  type FigmaSimplifiedNode,
  FigmaToolShell,
  formatDateTime,
  getNodeBoundingBoxLabel,
  getNodeChildren,
  getNodeName,
  nodeIdText,
  nodeTileProps,
  nodeTypeChipProps,
  scrollStyle,
} from "./shared"

// ============================================================================
// get-file
// ============================================================================

export function GetFileRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const { t } = useTranslation()
  const file = output ? (parseOutput<FigmaFileSummary>(output) as FigmaFileSummary | null) : null
  const pages = getNodeChildren(file?.document)

  return (
    <FigmaToolShell toolName={toolName} status={status}>
      {error && <ErrorBlock error={error} />}
      {!error && file && (
        <ResourceCard
          leading={
            file.thumbnailUrl ? (
              <Image
                source={{ uri: file.thumbnailUrl }}
                width={80}
                height={56}
                borderRadius={6}
                resizeMode="cover"
              />
            ) : (
              <IconTile
                accent={FIGMA_PALETTE.purple}
                icon={<File size={20} color={FIGMA_PALETTE.purple} />}
                size={56}
              />
            )
          }
          title={file.name ?? t('mca.figma.unnamedFile')}
          subtitle={file.version ? formatVersion(file.version) : undefined}
          meta={
            <XStack gap={4} alignItems="center">
              {file.componentCount > 0 && (
                <IconChip text={`${file.componentCount} comp`} accent={FIGMA_PALETTE.green} />
              )}
              {file.styleCount > 0 && (
                <IconChip text={`${file.styleCount} styles`} accent={FIGMA_PALETTE.red} />
              )}
            </XStack>
          }
        >
          <KeyValueGrid rows={fileMetaRows(file, pages.length)} />
          {pages.length === 0 ? (
            <Empty message={t('mca.figma.emptyFile')} />
          ) : (
            <ScrollView style={scrollStyle(280)}>
              <YStack>
                {pages.map((page) => {
                  // Pages are always type=CANVAS in Figma — chip is redundant. Only show
                  // a type chip if the user got back something else (e.g. a frame at root).
                  const showTypeChip = page.type && page.type.toUpperCase() !== "CANVAS"
                  const childCount = page.children?.length ?? page.childCount ?? 0
                  return (
                    <EntityRow
                      key={page.id}
                      leading={<IconTile {...nodeTileProps(page)} size={32} />}
                      title={getNodeName(page)}
                      subtitle={getNodeBoundingBoxLabel(page) ?? undefined}
                      badges={
                        showTypeChip
                          ? (() => {
                              const props = nodeTypeChipProps(page.type)
                              return props ? <IconChip {...props} /> : null
                            })()
                          : null
                      }
                      meta={
                        <Text color={globalColors.secondary} fontSize={9} fontFamily="$mono">
                          {childCount === 0 ? t('mca.figma.empty') : t('mca.figma.children', { count: childCount })}
                        </Text>
                      }
                    />
                  )
                })}
              </YStack>
            </ScrollView>
          )}
          {pages.some((p) => (p.children?.length ?? 0) > 0 || (p.childCount ?? 0) > 0) && (
            <Text color={globalColors.muted} fontSize={9}>
              Tip: call get-node with a child id to explore deeper.
            </Text>
          )}
        </ResourceCard>
      )}
    </FigmaToolShell>
  )
}

// Figma versions are opaque internal numbers (~20 digits). The full string adds
// no value to the user — keep last 6 with an ellipsis prefix so the visual is
// "v…563508" instead of swallowing the entire subtitle.
function formatVersion(version: string): string {
  const cleaned = version.trim()
  if (cleaned.length <= 8) return `v${cleaned}`
  return `v…${cleaned.slice(-6)}`
}

function fileMetaRows(file: FigmaFileSummary, pageCount: number): KeyValueRow[] {
  const rows: KeyValueRow[] = [
    { key: "lastModified", value: formatDateTime(file.lastModified) },
    { key: "pages", value: String(pageCount) },
  ]
  if (file.editorType) rows.push({ key: "editorType", value: file.editorType })
  if (file.role) rows.push({ key: "role", value: file.role })
  return rows
}

// ============================================================================
// get-node
// ============================================================================

export function GetNodeRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const { t } = useTranslation()
  const node = output
    ? (parseOutput<FigmaSimplifiedNode>(output) as FigmaSimplifiedNode | null)
    : null
  const children = getNodeChildren(node)

  return (
    <FigmaToolShell toolName={toolName} status={status}>
      {error && <ErrorBlock error={error} />}
      {!error && node && (
        <ResourceCard
          leading={<IconTile {...nodeTileProps(node)} size={32} />}
          title={getNodeName(node)}
          subtitle={node.id}
          meta={
            <XStack gap={4} alignItems="center">
              {(() => {
                const props = nodeTypeChipProps(node.type)
                return props ? <IconChip {...props} /> : null
              })()}
              {getNodeBoundingBoxLabel(node) && (
                <IconChip text={getNodeBoundingBoxLabel(node) ?? ""} accent={globalColors.muted} />
              )}
            </XStack>
          }
        >
          <KeyValueGrid rows={nodeMetaRows(node)} />
          {(node.fills?.length ?? 0) > 0 && (
            <YStack gap={4}>
              <Text
                color={globalColors.secondary}
                fontSize={9}
                fontFamily="$mono"
                textTransform="uppercase"
              >
                fills ({node.fills?.length})
              </Text>
              <PillList
                items={(node.fills ?? []).map((f, i) =>
                  f.color ? (
                    <IconChip
                      // biome-ignore lint/suspicious/noArrayIndexKey: stable index
                      key={i}
                      text={f.color}
                      accent={f.color}
                    />
                  ) : (
                    // biome-ignore lint/suspicious/noArrayIndexKey: stable index
                    <IconChip key={i} text={f.type} accent={globalColors.muted} />
                  ),
                )}
              />
            </YStack>
          )}
          {node.textStyle && (
            <YStack gap={4}>
              <Text
                color={globalColors.secondary}
                fontSize={9}
                fontFamily="$mono"
                textTransform="uppercase"
              >
                text style
              </Text>
              <KeyValueGrid rows={textStyleRows(node.textStyle)} />
            </YStack>
          )}
          {children.length > 0 && (
            <YStack gap={4}>
              <Text
                color={globalColors.secondary}
                fontSize={9}
                fontFamily="$mono"
                textTransform="uppercase"
              >
                children ({children.length})
              </Text>
              <ScrollView style={scrollStyle(240)}>
                <YStack>
                  {children.map((child) => (
                    <EntityRow
                      key={child.id}
                      leading={<IconTile {...nodeTileProps(child)} size={20} />}
                      title={getNodeName(child)}
                      subtitle={getNodeBoundingBoxLabel(child) ?? child.id}
                      badges={(() => {
                        const props = nodeTypeChipProps(child.type)
                        return props ? <IconChip {...props} /> : null
                      })()}
                      meta={nodeIdText(child.id)}
                    />
                  ))}
                </YStack>
              </ScrollView>
            </YStack>
          )}
        </ResourceCard>
      )}
    </FigmaToolShell>
  )
}

function nodeMetaRows(node: FigmaSimplifiedNode): KeyValueRow[] {
  const rows: KeyValueRow[] = []
  if (node.bounds) {
    rows.push({ key: "bounds", value: `${node.bounds.width} × ${node.bounds.height}` })
  }
  if (node.cornerRadius) rows.push({ key: "cornerRadius", value: `${node.cornerRadius}` })
  if (node.strokeWeight) rows.push({ key: "strokeWeight", value: `${node.strokeWeight}` })
  if (node.componentId) rows.push({ key: "componentId", value: node.componentId })
  if (node.componentSetId) rows.push({ key: "componentSetId", value: node.componentSetId })
  return rows
}

function textStyleRows(style: NonNullable<FigmaSimplifiedNode["textStyle"]>): KeyValueRow[] {
  const rows: KeyValueRow[] = [
    { key: "fontFamily", value: style.fontFamily },
    { key: "fontSize", value: `${style.fontSize}px` },
    { key: "fontWeight", value: `${style.fontWeight}` },
  ]
  if (style.lineHeight) rows.push({ key: "lineHeight", value: `${style.lineHeight}px` })
  if (style.letterSpacing) rows.push({ key: "letterSpacing", value: `${style.letterSpacing}px` })
  return rows
}
