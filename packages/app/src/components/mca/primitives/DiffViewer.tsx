import type React from 'react';
import { ScrollView } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';
import { diff as diffTokens } from './colors';
import type { AdaptiveColors } from './useColors';
import { useColors } from './useColors';

interface DiffViewerProps {
  /** Unified diff text (standard `diff -u` output). */
  diff: string;
  /** Max height in px before the body scrolls. Default 360. */
  maxHeight?: number;
}

interface ParsedLine {
  kind: 'add' | 'del' | 'context' | 'hunk' | 'meta';
  text: string;
  oldNo?: number;
  newNo?: number;
}

interface ParsedHunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: ParsedLine[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function parseDiff(diff: string): ParsedHunk[] {
  const lines = diff.split('\n');
  const hunks: ParsedHunk[] = [];
  let current: ParsedHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  for (const raw of lines) {
    if (raw.startsWith('+++') || raw.startsWith('---')) {
      // file header — not part of any hunk; skip silently
      continue;
    }
    const hm = HUNK_RE.exec(raw);
    if (hm) {
      current = {
        header: hm[5]?.trim() || '',
        oldStart: Number(hm[1]),
        oldCount: hm[2] ? Number(hm[2]) : 1,
        newStart: Number(hm[3]),
        newCount: hm[4] ? Number(hm[4]) : 1,
        lines: [],
      };
      oldNo = current.oldStart;
      newNo = current.newStart;
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (raw.startsWith('+')) {
      current.lines.push({ kind: 'add', text: raw.slice(1), newNo });
      newNo++;
    } else if (raw.startsWith('-')) {
      current.lines.push({ kind: 'del', text: raw.slice(1), oldNo });
      oldNo++;
    } else if (raw.startsWith('\\')) {
      current.lines.push({ kind: 'meta', text: raw });
    } else {
      const text = raw.startsWith(' ') ? raw.slice(1) : raw;
      current.lines.push({ kind: 'context', text, oldNo, newNo });
      oldNo++;
      newNo++;
    }
  }
  return hunks;
}

const KIND_BG: Record<ParsedLine['kind'], string | undefined> = {
  // Semantic theme-agnostic tints — green/red add/del backgrounds with
  // identical alpha in light + dark. Pulled from `diffTokens` so the
  // palette stays consolidated with the rest of the primitives.
  add: diffTokens.add.bg,
  del: diffTokens.del.bg,
  context: undefined,
  hunk: undefined,
  meta: undefined,
};

/**
 * Per-line foreground colors. Theme-adaptive — `context`/`hunk`/`meta`
 * pull from the surface text scale so they read on both light and dark
 * backgrounds. The `add`/`del` tints are semantic and stay constant.
 */
function kindColor(kind: ParsedLine['kind'], c: AdaptiveColors): string {
  switch (kind) {
    case 'add': return diffTokens.add.fg;
    case 'del': return diffTokens.del.fg;
    case 'context': return c.text;
    case 'hunk': return c.text2;
    case 'meta': return c.text3;
  }
}

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
 */
export function DiffViewer({ diff, maxHeight = 360 }: DiffViewerProps): React.ReactNode {
  const c = useColors();
  if (!diff || typeof diff !== 'string' || diff.trim().length === 0) return null;
  const hunks = parseDiff(diff);
  if (hunks.length === 0) {
    // Fallback: render the diff as a plain colored block (legacy behavior).
    return (
      <YStack
        backgroundColor={c.bgInner}
        borderRadius={4}
        padding={6}
        maxHeight={maxHeight}
        overflow="hidden"
      >
        <ScrollView style={{ maxHeight }}>
          {diff.split('\n').map((line, idx) => (
            <Text
              // biome-ignore lint/suspicious/noArrayIndexKey: diff lines stable
              key={idx}
              color={kindColor('context', c)}
              fontFamily="$mono"
              fontSize={11}
              lineHeight={16}
            >
              {line || ' '}
            </Text>
          ))}
        </ScrollView>
      </YStack>
    );
  }

  return (
    <YStack
      backgroundColor={c.bgInner}
      borderRadius={4}
      maxHeight={maxHeight}
      overflow="hidden"
    >
      <ScrollView style={{ maxHeight }} nestedScrollEnabled>
        <YStack gap={6} padding={4}>
          {hunks.map((hunk, hIdx) => {
            const changes = hunk.lines.filter((l) => l.kind === 'add' || l.kind === 'del').length;
            const oldRange = `${hunk.oldStart}–${hunk.oldStart + hunk.oldCount - 1}`;
            const newRange = `${hunk.newStart}–${hunk.newStart + hunk.newCount - 1}`;
            return (
              <YStack
                // biome-ignore lint/suspicious/noArrayIndexKey: hunks stable
                key={`h-${hIdx}`}
                gap={1}
              >
                <XStack
                  paddingHorizontal={6}
                  paddingVertical={3}
                  backgroundColor={c.badges.info.bg}
                  borderRadius={3}
                  alignItems="center"
                  gap={6}
                >
                  <Text color={kindColor('hunk', c)} fontSize={10} fontFamily="$mono" fontWeight="bold">
                    @@
                  </Text>
                  <Text color={c.text} fontSize={10} fontFamily="$mono">
                    Lines {oldRange} → {newRange}
                  </Text>
                  <Text color={c.text3} fontSize={10} fontFamily="$mono">
                    · {changes} change{changes === 1 ? '' : 's'}
                  </Text>
                  {hunk.header ? (
                    <Text color={c.text3} fontSize={10} fontFamily="$mono" numberOfLines={1}>
                      · {hunk.header}
                    </Text>
                  ) : null}
                </XStack>
                {hunk.lines.map((line, lIdx) => (
                  <XStack
                    // biome-ignore lint/suspicious/noArrayIndexKey: lines stable
                    key={`l-${lIdx}`}
                    gap={0}
                    paddingHorizontal={4}
                    backgroundColor={KIND_BG[line.kind]}
                    borderRadius={2}
                  >
                    <Text
                      width={32}
                      textAlign="right"
                      color={c.text3}
                      fontSize={10}
                      fontFamily="$mono"
                    >
                      {line.oldNo ?? ''}
                    </Text>
                    <Text
                      width={32}
                      textAlign="right"
                      color={c.text3}
                      fontSize={10}
                      fontFamily="$mono"
                    >
                      {line.newNo ?? ''}
                    </Text>
                    <Text
                      width={14}
                      textAlign="center"
                      color={kindColor(line.kind, c)}
                      fontSize={11}
                      fontFamily="$mono"
                      fontWeight="bold"
                    >
                      {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}
                    </Text>
                    <Text
                      flex={1}
                      color={kindColor(line.kind, c)}
                      fontSize={11}
                      fontFamily="$mono"
                      lineHeight={16}
                    >
                      {line.text || ' '}
                    </Text>
                  </XStack>
                ))}
              </YStack>
            );
          })}
        </YStack>
      </ScrollView>
    </YStack>
  );
}
