/**
 * KeyValueGrid — the OS prototype's `.kvl`: keys mono 11 text3 in a fixed
 * column, values sans 13 text2 (or mono for ids/paths), rows 6px apart.
 */
import type React from "react"
import { XStack, YStack } from "tamagui"
import { T } from "../../ui/ds/Text"

export interface KeyValueRow {
  key: string
  value: React.ReactNode
  /**
   * If true, renders the value in mono. Useful for IDs, hashes, paths,
   * code snippets. When `value` is already a React node, this prop is
   * ignored (the node controls its own font).
   */
  mono?: boolean
}

interface KeyValueGridProps {
  rows: KeyValueRow[]
  /** Key column width. Default 110 (`.kvl` grid-template-columns: 110px 1fr). */
  keyWidth?: number
}

export function KeyValueGrid({ rows, keyWidth = 110 }: KeyValueGridProps) {
  if (rows.length === 0) return null

  return (
    <YStack gap={6}>
      {rows.map(({ key, value, mono }) => (
        <XStack key={key} gap={12} alignItems="flex-start">
          <T
            step="code"
            tone="text3"
            numberOfLines={1}
            style={{ width: keyWidth, flexShrink: 0, fontSize: 11, lineHeight: 18 }}
          >
            {key}
          </T>
          {typeof value === "string" || typeof value === "number" ? (
            <T
              step={mono ? "code" : "sm"}
              tone="text2"
              style={{ flex: 1, minWidth: 0, lineHeight: 18 }}
              selectable
            >
              {value}
            </T>
          ) : (
            <YStack flex={1} minWidth={0}>
              {value}
            </YStack>
          )}
        </XStack>
      ))}
    </YStack>
  )
}
