import type React from "react"
import { View } from "react-native"
import { XStack } from "tamagui"
import { T } from "../../ui/ds/Text"

interface MetaItem {
  /** Short label (will be rendered muted, uppercase-tracked). */
  key: string
  /** Value text. Numbers are stringified by the caller. */
  value: string
  /** Optional accent dot before the key. */
  accent?: string
}

interface MetaStripProps {
  items: MetaItem[]
  /** Hide labels when only the values matter. Default false. */
  valuesOnly?: boolean
}

/**
 * Horizontal strip of compact key-value pills. Sustituto editorial del
 * `KeyValueGrid` cuando los pares son pocos (≤6) y caben en una línea.
 *
 * Cada pill:  [• KEY] value     [• KEY] value     ...
 *
 * Wrap si overflow. No background sólido — la jerarquía la da el contraste
 * tipográfico (key codenote text3, value mono 12 text).
 */
export function MetaStrip({ items, valuesOnly }: MetaStripProps): React.ReactNode {
  if (!items || items.length === 0) return null
  return (
    <XStack flexWrap="wrap" gap={14} alignItems="center" paddingVertical={2}>
      {items.map((item, idx) => (
        <XStack
          // biome-ignore lint/suspicious/noArrayIndexKey: stable order by caller
          key={`${item.key}-${idx}`}
          alignItems="center"
          gap={6}
        >
          {item.accent ? (
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: item.accent }} />
          ) : null}
          {!valuesOnly && (
            <T step="codenote" tone="text3">
              {item.key}
            </T>
          )}
          <T step="code" selectable>
            {item.value}
          </T>
        </XStack>
      ))}
    </XStack>
  )
}
