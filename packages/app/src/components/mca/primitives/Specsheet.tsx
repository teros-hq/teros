import type React from "react"
import { XStack, YStack } from "tamagui"
import { T } from "../../ui/ds/Text"
import { useColors } from "./useColors"

export interface SpecsheetRow {
  key: string
  value: React.ReactNode
}

export interface SpecsheetSection {
  title: string
  rows: SpecsheetRow[]
}

interface SpecsheetProps {
  sections: SpecsheetSection[]
}

/**
 * Editorial datasheet. Sustituto del `KeyValueGrid` plano cuando hay datos
 * agrupados por dominio (Identity / Physical / Timeline en `stat`,
 * Roots / Diagnostics en `health-check`, etc.).
 *
 *   IDENTITY ──────────────────────
 *     name        photo.png
 *     type        file
 *     mime        image/png
 *
 *   PHYSICAL ──────────────────────
 *     size        12.4 KB
 *     ...
 *
 * Section labels are the prototype's codenote (mono 10 caps) with a
 * hairline; rows are the `.kvl` key/value list.
 */
export function Specsheet({ sections }: SpecsheetProps): React.ReactNode {
  const c = useColors()
  if (!sections || sections.length === 0) return null
  return (
    <YStack gap={12}>
      {sections.map((section, idx) => (
        <YStack
          // biome-ignore lint/suspicious/noArrayIndexKey: stable
          key={`${section.title}-${idx}`}
          gap={6}
        >
          <XStack alignItems="center" gap={8}>
            <T step="codenote" tone="text3">
              {section.title}
            </T>
            <YStack flex={1} height={1} backgroundColor={c.border} />
          </XStack>
          <YStack gap={6}>
            {section.rows.map((row, rowIdx) => (
              <XStack
                // biome-ignore lint/suspicious/noArrayIndexKey: stable
                key={`${row.key}-${rowIdx}`}
                gap={12}
                alignItems="flex-start"
              >
                <T
                  step="code"
                  tone="text3"
                  numberOfLines={1}
                  style={{ width: 110, flexShrink: 0, fontSize: 11, lineHeight: 18 }}
                >
                  {row.key}
                </T>
                <YStack flex={1} minWidth={0}>
                  {typeof row.value === "string" ? (
                    <T step="sm" tone="text2" style={{ lineHeight: 18 }} selectable>
                      {row.value}
                    </T>
                  ) : (
                    row.value
                  )}
                </YStack>
              </XStack>
            ))}
          </YStack>
        </YStack>
      ))}
    </YStack>
  )
}
