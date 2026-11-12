import type React from "react"
import { ScrollView } from "react-native"
import { XStack, YStack } from "tamagui"
import { T } from "../../ui/ds/Text"
import { diff as diffTokens } from "./colors"
import type { AdaptiveColors } from "./useColors"
import { useColors } from "./useColors"

interface DiffViewerProps {
  /** Unified diff text (standard `diff -u` output). */
  diff: string
  /** Max height in px before the body scrolls. Default 360. */
  maxHeight?: number
}

interface ParsedLine {
  kind: "add" | "del" | "context" | "hunk" | "meta"
  text: string
  oldNo?: number
  newNo?: number
}

interface ParsedHunk {
  header: string
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: ParsedLine[]
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/

function parseDiff(diff: string): ParsedHunk[] {
  const lines = diff.split("\n")
  const hunks: ParsedHunk[] = []
  let current: ParsedHunk | null = null
  let oldNo = 0
  let newNo = 0

  for (const raw of lines) {
    if (raw.startsWith("+++") || raw.startsWith("---")) {
      // file header — not part of any hunk; skip silently
      continue
    }
    const hm = HUNK_RE.exec(raw)
    if (hm) {
      current = {
        header: hm[5]?.trim() || "",
        oldStart: Number(hm[1]),
        oldCount: hm[2] ? Number(hm[2]) : 1,
        newStart: Number(hm[3]),
        newCount: hm[4] ? Number(hm[4]) : 1,
        lines: [],
      }
      oldNo = current.oldStart
      newNo = current.newStart
      hunks.push(current)
      continue
    }
    if (!current) continue
    if (raw.startsWith("+")) {
      current.lines.push({ kind: "add", text: raw.slice(1), newNo })
      newNo++
    } else if (raw.startsWith("-")) {
      current.lines.push({ kind: "del", text: raw.slice(1), oldNo })
      oldNo++
    } else if (raw.startsWith("\\")) {
      current.lines.push({ kind: "meta", text: raw })
    } else {
      const text = raw.startsWith(" ") ? raw.slice(1) : raw
      current.lines.push({ kind: "context", text, oldNo, newNo })
      oldNo++
      newNo++
    }
  }
  return hunks
}

const KIND_BG: Record<ParsedLine["kind"], string | undefined> = {
  // Semantic theme-agnostic tints — green/red add/del backgrounds with
  // identical alpha in light + dark. Pulled from `diffTokens` so the
  // palette stays consolidated with the rest of the primitives.
  add: diffTokens.add.bg,
  del: diffTokens.del.bg,
  context: undefined,
  hunk: undefined,
  meta: undefined,
}

/**
 * Per-line foreground colors. Theme-adaptive — `context`/`hunk`/`meta`
 * pull from the surface text scale so they read on both light and dark
 * backgrounds. The `add`/`del` tints are semantic and stay constant.
 */
function kindColor(kind: ParsedLine["kind"], c: AdaptiveColors): string {
  switch (kind) {
    case "add":
      return diffTokens.add.fg
    case "del":
      return diffTokens.del.fg
    case "context":
      return c.text
    case "hunk":
      return c.text2
    case "meta":
      return c.text3
  }
}

/** Mono 11/16 — the diff body step (one below `.tc-json`'s 12). */
const LINE = { fontSize: 11, lineHeight: 16 } as const

/**
 * Pretty unified-diff viewer with:
 * - Two columns of line numbers (old / new).
 * - Hunk header banding with a summary ("Lines A–B → C–D · n changes").
 * - Background tint per change kind (+/-).
 *
 *   ┌── @@ Lines 12–17 → 12–18 · 2 changes ──┐
 *   │  12  12  context line                  │
 *   │  13      - removed line                 │
 *   │      13  + added line                   │
 *   └─────────────────────────────────────────┘
 *
 * Drawn as a step card (radius 10, hairline) like the prototype's `.tc-json`.
 */
export function DiffViewer({ diff, maxHeight = 360 }: DiffViewerProps): React.ReactNode {
  const c = useColors()
  if (!diff || typeof diff !== "string" || diff.trim().length === 0) return null
  const hunks = parseDiff(diff)
  if (hunks.length === 0) {
    // Fallback: render the diff as a plain mono block (legacy behavior).
    return (
      <YStack
        backgroundColor={c.bgStep}
        borderWidth={1}
        borderColor={c.border}
        borderRadius={10}
        paddingVertical={8}
        paddingHorizontal={10}
        maxHeight={maxHeight}
        overflow="hidden"
      >
        <ScrollView style={{ maxHeight }}>
          {diff.split("\n").map((line, idx) => (
            <T
              // biome-ignore lint/suspicious/noArrayIndexKey: diff lines stable
              key={idx}
              step="code"
              color={kindColor("context", c)}
              style={LINE}
              selectable
            >
              {line || " "}
            </T>
          ))}
        </ScrollView>
      </YStack>
    )
  }

  return (
    <YStack
      backgroundColor={c.bgStep}
      borderWidth={1}
      borderColor={c.border}
      borderRadius={10}
      maxHeight={maxHeight}
      overflow="hidden"
    >
      <ScrollView style={{ maxHeight }} nestedScrollEnabled>
        <YStack gap={6} padding={6}>
          {hunks.map((hunk, hIdx) => {
            const changes = hunk.lines.filter((l) => l.kind === "add" || l.kind === "del").length
            const oldRange = `${hunk.oldStart}–${hunk.oldStart + hunk.oldCount - 1}`
            const newRange = `${hunk.newStart}–${hunk.newStart + hunk.newCount - 1}`
            return (
              <YStack
                // biome-ignore lint/suspicious/noArrayIndexKey: hunks stable
                key={`h-${hIdx}`}
                gap={1}
              >
                <XStack
                  paddingHorizontal={8}
                  paddingVertical={4}
                  backgroundColor={c.tint.i.bg}
                  borderRadius={6}
                  alignItems="center"
                  gap={6}
                >
                  <T step="code" color={c.tint.i.tx} style={LINE}>
                    @@
                  </T>
                  <T step="code" style={LINE}>
                    Lines {oldRange} → {newRange}
                  </T>
                  <T step="code" tone="text3" style={LINE}>
                    · {changes} change{changes === 1 ? "" : "s"}
                  </T>
                  {hunk.header ? (
                    <T step="code" tone="text3" numberOfLines={1} style={[LINE, { flexShrink: 1 }]}>
                      · {hunk.header}
                    </T>
                  ) : null}
                </XStack>
                {hunk.lines.map((line, lIdx) => (
                  <XStack
                    // biome-ignore lint/suspicious/noArrayIndexKey: lines stable
                    key={`l-${lIdx}`}
                    gap={0}
                    paddingHorizontal={4}
                    backgroundColor={KIND_BG[line.kind]}
                    borderRadius={3}
                  >
                    <T step="code" tone="text3" style={[LINE, { width: 32, textAlign: "right" }]}>
                      {line.oldNo ?? ""}
                    </T>
                    <T step="code" tone="text3" style={[LINE, { width: 32, textAlign: "right" }]}>
                      {line.newNo ?? ""}
                    </T>
                    <T
                      step="code"
                      color={kindColor(line.kind, c)}
                      style={[LINE, { width: 16, textAlign: "center" }]}
                    >
                      {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
                    </T>
                    <T
                      step="code"
                      color={kindColor(line.kind, c)}
                      style={[LINE, { flex: 1, minWidth: 0 }]}
                      selectable
                    >
                      {line.text || " "}
                    </T>
                  </XStack>
                ))}
              </YStack>
            )
          })}
        </YStack>
      </ScrollView>
    </YStack>
  )
}
