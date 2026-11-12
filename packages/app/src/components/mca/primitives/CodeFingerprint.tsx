import type React from "react"
import { XStack, YStack } from "tamagui"
import { T } from "../../ui/ds/Text"
import { useColors } from "./useColors"

interface CodeFingerprintProps {
  /** Hex digest (any length). Common: SHA1=40, SHA256=64, SHA512=128, MD5=32. */
  hash: string
  /** Algorithm label rendered in the footer. */
  algorithm: string
  /** Optional file size or extra meta rendered alongside the algorithm. */
  size?: string
  /** Optional accent color for the bottom border of each cell. */
  accent?: string
  /**
   * Number of columns. Default auto-derived from `hash.length`:
   * 32 → 4, 40 → 5, 64 → 8, 128 → 8.
   */
  columns?: number
}

const GROUP = 8

function autoColumns(length: number): number {
  if (length <= 32) return 4
  if (length <= 40) return 5
  if (length <= 64) return 8
  return 8
}

/**
 * Renders a hash digest as a forensic fingerprint: cells of N hex chars in
 * a grid with a subtle bottom border. The digest IS the visual — designed
 * for `hash` tool output but reusable for any content-addressable id.
 *
 *   ┌──────────┬──────────┬──────────┬──────────┐
 *   │ 5891b5b5 │ 22d5df08 │ 6d0ff0b1 │ 10fbd9d2 │
 *   ├──────────┼──────────┼──────────┼──────────┤
 *   │ 1bb4fc71 │ 63af34d0 │ 8286a2e8 │ 46f6be03 │
 *   └──────────┴──────────┴──────────┴──────────┘
 *   SHA256                                  6 B
 */
export function CodeFingerprint({
  hash,
  algorithm,
  size,
  accent,
  columns,
}: CodeFingerprintProps): React.ReactNode {
  const c = useColors()
  if (!hash) return null
  const groups: string[] = []
  for (let i = 0; i < hash.length; i += GROUP) {
    groups.push(hash.slice(i, i + GROUP))
  }
  const cols = columns ?? autoColumns(hash.length)
  const rows: string[][] = []
  for (let i = 0; i < groups.length; i += cols) {
    rows.push(groups.slice(i, i + cols))
  }
  const accentColor = accent ?? c.borderStrong

  return (
    <YStack gap={6}>
      <YStack
        backgroundColor={c.bgStep}
        borderWidth={1}
        borderColor={c.border}
        borderRadius={10}
        paddingVertical={8}
        paddingHorizontal={8}
      >
        {rows.map((row, rIdx) => (
          <XStack
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are stable
            key={`r-${rIdx}`}
            gap={6}
            paddingVertical={3}
          >
            {row.map((group, cIdx) => (
              <YStack
                // biome-ignore lint/suspicious/noArrayIndexKey: cells stable
                key={`c-${cIdx}`}
                flex={1}
                paddingHorizontal={2}
                borderBottomWidth={1}
                borderBottomColor={accentColor}
                paddingBottom={3}
              >
                <T step="code13" center style={{ letterSpacing: 1.5 }} selectable>
                  {group}
                </T>
              </YStack>
            ))}
            {/* Pad incomplete trailing row with empty flex slots to keep alignment */}
            {row.length < cols
              ? Array.from({ length: cols - row.length }).map((_, padIdx) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: pads stable
                  <YStack key={`pad-${padIdx}`} flex={1} />
                ))
              : null}
          </XStack>
        ))}
      </YStack>
      <XStack justifyContent="space-between" paddingHorizontal={4}>
        <T step="codenote" tone="text3">
          {algorithm}
        </T>
        {size ? (
          <T step="code" tone="text3" style={{ fontSize: 11, lineHeight: 12 }}>
            {size}
          </T>
        ) : null}
      </XStack>
    </YStack>
  )
}
