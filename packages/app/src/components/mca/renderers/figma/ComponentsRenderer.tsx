/**
 * Figma Renderer — get-components, get-component-sets.
 *
 * Both return a list of library entities. Pattern: `EntityRow` per row in a
 * scrollable container, accent green (Figma's COMPONENT colour).
 */

import { Component, Layers } from "@tamagui/lucide-icons"
import { useTranslation } from "react-i18next"
import { ScrollView } from "react-native"
import { Text, YStack } from "tamagui"
import {
  Empty,
  EntityRow,
  ErrorBlock,
  colors as globalColors,
  IconChip,
  IconTile,
  parseOutput,
} from "../../primitives"
import type { ToolCallRendererProps } from "../../types"
import {
  FIGMA_PALETTE,
  type FigmaComponentRef,
  type FigmaComponentSetRef,
  FigmaToolShell,
  scrollStyle,
  shortId,
  truncate,
  unwrapList,
} from "./shared"

// ============================================================================
// get-components
// ============================================================================

export function GetComponentsRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const { t } = useTranslation()
  const parsed = output ? parseOutput(output) : null
  const { items, count } = unwrapList<FigmaComponentRef>(parsed, "components")

  return (
    <FigmaToolShell
      toolName={toolName}
      status={status}
      description={count != null ? `Components (${count})` : undefined}
    >
      {error && <ErrorBlock error={error} />}
      {!error && items.length === 0 && <Empty message={t('mca.figma.noComponents')} />}
      {!error && items.length > 0 && (
        <ScrollView style={scrollStyle(360)}>
          <YStack>
            {items.map((c) => (
              <EntityRow
                key={c.id}
                leading={
                  <IconTile
                    accent={FIGMA_PALETTE.green}
                    icon={<Component size={12} color={FIGMA_PALETTE.green} />}
                    size={24}
                  />
                }
                title={c.name}
                subtitle={shortId(c.key)}
                badges={
                  c.componentSetId ? <IconChip text={t('mca.figma.variant')} accent={FIGMA_PALETTE.green} /> : null
                }
                meta={
                  c.description ? (
                    <Text color={globalColors.muted} fontSize={9} numberOfLines={1}>
                      {truncate(c.description, 40)}
                    </Text>
                  ) : null
                }
              />
            ))}
          </YStack>
        </ScrollView>
      )}
    </FigmaToolShell>
  )
}

// ============================================================================
// get-component-sets
// ============================================================================

export function GetComponentSetsRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const { t } = useTranslation()
  const parsed = output ? parseOutput(output) : null
  const { items, count } = unwrapList<FigmaComponentSetRef>(parsed, "componentSets")

  return (
    <FigmaToolShell
      toolName={toolName}
      status={status}
      description={count != null ? `Component variants (${count})` : undefined}
    >
      {error && <ErrorBlock error={error} />}
      {!error && items.length === 0 && <Empty message={t('mca.figma.noComponentSets')} />}
      {!error && items.length > 0 && (
        <ScrollView style={scrollStyle(360)}>
          <YStack>
            {items.map((s) => (
              <EntityRow
                key={s.id}
                leading={
                  <IconTile
                    accent={FIGMA_PALETTE.green}
                    icon={<Layers size={12} color={FIGMA_PALETTE.green} />}
                    size={24}
                  />
                }
                title={s.name}
                subtitle={shortId(s.key)}
                meta={
                  s.description ? (
                    <Text color={globalColors.muted} fontSize={9} numberOfLines={1}>
                      {truncate(s.description, 40)}
                    </Text>
                  ) : null
                }
              />
            ))}
          </YStack>
        </ScrollView>
      )}
    </FigmaToolShell>
  )
}
