/**
 * Figma Renderer — get-file-styles, get-file-variables.
 *
 * - get-file-styles: flat list of style refs (FILL / TEXT / EFFECT / GRID).
 * - get-file-variables: collections of variables (design tokens). Rendered
 *   flat, with a collection-name separator above each group of variable rows.
 *   For COLOR variables, the first mode value is parsed as {r,g,b,a} and
 *   shown as an IconTile swatch in the meta slot.
 */

import { useTranslation } from "react-i18next"
import { ScrollView } from "react-native"
import { Text, XStack, YStack } from "tamagui"
import {
  Empty,
  EntityRow,
  ErrorBlock,
  colors as globalColors,
  IconChip,
  IconTile,
  parseOutput,
  useColors,
} from "../../primitives"
import type { ToolCallRendererProps } from "../../types"
import {
  type FigmaPaintColor,
  type FigmaStyleRef,
  FigmaToolShell,
  type FigmaVariable,
  type FigmaVariableCollection,
  rgbToHex,
  scrollStyle,
  shortId,
  styleTypeChipProps,
  unwrapList,
  variableTypeChipProps,
} from "./shared"

// ============================================================================
// get-file-styles
// ============================================================================

export function GetFileStylesRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const { t } = useTranslation()
  const parsed = output ? parseOutput(output) : null
  const { items, count } = unwrapList<FigmaStyleRef>(parsed, "styles")

  return (
    <FigmaToolShell
      toolName={toolName}
      status={status}
      description={count != null ? `File styles (${count})` : undefined}
    >
      {error && <ErrorBlock error={error} />}
      {!error && items.length === 0 && <Empty message={t('mca.figma.noStyles')} />}
      {!error && items.length > 0 && (
        <ScrollView style={scrollStyle(360)}>
          <YStack>
            {items.map((s) => {
              const chip = styleTypeChipProps(s.type)
              return (
                <EntityRow
                  key={s.id}
                  leading={<IconTile accent={chip.accent} label={chip.text[0]} size={24} />}
                  title={s.name}
                  subtitle={shortId(s.key)}
                  badges={<IconChip {...chip} />}
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
// get-file-variables
// ============================================================================

interface VariablesShape {
  collections?: FigmaVariableCollection[]
  collectionCount?: number
  variableCount?: number
}

export function GetFileVariablesRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const { t } = useTranslation()
  const c = useColors()
  const parsed = output ? (parseOutput<VariablesShape>(output) as VariablesShape | null) : null
  const collections = parsed?.collections ?? []
  const totalVars =
    parsed?.variableCount ?? collections.reduce((n, c) => n + (c.variables?.length ?? 0), 0)

  return (
    <FigmaToolShell
      toolName={toolName}
      status={status}
      description={`Design tokens (${totalVars})`}
    >
      {error && <ErrorBlock error={error} />}
      {!error && collections.length === 0 && <Empty message={t('mca.figma.noDesignTokens')} />}
      {!error && collections.length > 0 && (
        <ScrollView style={scrollStyle(420)}>
          <YStack>
            {collections.map((col) => (
              <YStack key={col.id} gap={2} marginBottom={6}>
                <XStack
                  paddingHorizontal={8}
                  paddingVertical={4}
                  backgroundColor={c.border}
                >
                  <Text
                    color={globalColors.secondary}
                    fontSize={9}
                    fontFamily="$mono"
                    textTransform="uppercase"
                  >
                    {col.name} · {col.variables?.length ?? 0} tokens
                  </Text>
                </XStack>
                {(col.variables ?? []).map((v) => {
                  const chip = variableTypeChipProps(v.type)
                  const swatch = colorSwatchFor(v)
                  return (
                    <EntityRow
                      key={v.id}
                      leading={
                        <IconTile
                          accent={chip.accent}
                          label={(v.name[0] ?? "?").toUpperCase()}
                          size={20}
                        />
                      }
                      title={v.name}
                      subtitle={`${Object.keys(v.values ?? {}).length} mode${Object.keys(v.values ?? {}).length === 1 ? "" : "s"}`}
                      badges={<IconChip {...chip} />}
                      meta={swatch ? <IconTile size={14} accent={swatch} radius={3} /> : null}
                    />
                  )
                })}
              </YStack>
            ))}
          </YStack>
        </ScrollView>
      )}
    </FigmaToolShell>
  )
}

function colorSwatchFor(v: FigmaVariable): string | null {
  if (v.type?.toUpperCase() !== "COLOR") return null
  const firstModeValue = Object.values(v.values ?? {})[0]
  if (!firstModeValue || typeof firstModeValue !== "object") return null
  const c = firstModeValue as Partial<FigmaPaintColor>
  if (typeof c.r !== "number" || typeof c.g !== "number" || typeof c.b !== "number") return null
  return rgbToHex({ r: c.r, g: c.g, b: c.b, a: typeof c.a === "number" ? c.a : 1 })
}
