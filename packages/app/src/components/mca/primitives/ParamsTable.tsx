/**
 * Params Table — used by Fallback Body and Permission flow (Renderer UX
 * Guide v2 §0, §8).
 *
 * Two-column readout of a tool call's `input` params:
 *   • Label  — 9px mono uppercase, fixed 64px width.
 *   • Value  — 10px mono, theme-adaptive.
 *
 * Objects and arrays render as a compact placeholder (`{...}` / `[...]`),
 * never expanded — no nesting, no JSON tree. Background `bgInner`.
 *
 * This is intentionally small and dumb: zero conditional branches per row,
 * zero clickable behavior. The point is a legible "what was passed in"
 * readout. For richer detail views, write a custom renderer.
 */

import { Text, XStack, YStack } from 'tamagui';
import { useColors } from './useColors';

export interface ParamsTableProps {
  params?: Record<string, unknown> | null;
  /**
   * Label width in px. Default 64 — wide enough for `Description`,
   * narrow enough that the value gets generous space.
   */
  labelWidth?: number;
  /**
   * When `params` is empty/missing, show this hint. Default omits the
   * table entirely (renders nothing).
   */
  emptyHint?: string;
  /**
   * Hard cap on rows rendered. If `params` exceeds this, the first
   * `maxRows - 1` are shown and a final row says `[+N more]`. Without
   * this, a tool that returns 10K input fields would freeze the RN
   * bridge mapping ParamsRow components. Default 50.
   */
  maxRows?: number;
}

export function ParamsTable({
  params,
  labelWidth = 64,
  emptyHint,
  maxRows = 50,
}: ParamsTableProps) {
  const c = useColors();
  const entries = params ? Object.entries(params) : [];

  if (entries.length === 0) {
    if (!emptyHint) return null;
    return (
      <YStack
        backgroundColor={c.bgInner}
        paddingHorizontal={12}
        paddingVertical={10}
        borderRadius={6}
      >
        <Text color={c.text3} fontSize={11} fontStyle="italic">
          {emptyHint}
        </Text>
      </YStack>
    );
  }

  const overflow = entries.length > maxRows;
  const visible = overflow ? entries.slice(0, maxRows - 1) : entries;
  const remaining = entries.length - visible.length;

  return (
    <YStack
      backgroundColor={c.bgInner}
      paddingHorizontal={12}
      paddingVertical={10}
      borderRadius={6}
      gap={2}
    >
      {visible.map(([key, value]) => (
        <ParamsRow key={key} label={key} value={value} labelWidth={labelWidth} />
      ))}
      {overflow && (
        <Text
          color={c.text3}
          fontSize={9}
          fontFamily="$mono"
          textTransform="uppercase"
          letterSpacing={0.4}
          paddingTop={4}
        >
          [+{remaining} more]
        </Text>
      )}
    </YStack>
  );
}

function ParamsRow({
  label,
  value,
  labelWidth,
}: {
  label: string;
  value: unknown;
  labelWidth: number;
}) {
  const c = useColors();
  return (
    <XStack alignItems="baseline" gap={16} paddingVertical={2}>
      <Text
        color={c.text3}
        fontSize={9}
        fontFamily="$mono"
        textTransform="uppercase"
        letterSpacing={0.4}
        width={labelWidth}
        flexShrink={0}
        numberOfLines={1}
      >
        {label}
      </Text>
      <Text
        color={c.text2}
        fontSize={10}
        fontFamily="$mono"
        flex={1}
        numberOfLines={3}
      >
        {formatValue(value)}
      </Text>
    </XStack>
  );
}

/** @internal exported for unit tests only — do not import in renderers. */
export function formatValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return '—';
  if (typeof value === 'string') return value.length === 0 ? '""' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (typeof value === 'symbol') return value.toString();
  if (typeof value === 'function') return '[Function]';
  if (value instanceof Date) {
    // toISOString() throws on Invalid Date — fall back to a marker rather
    // than crash the whole table render.
    try {
      return value.toISOString();
    } catch {
      return '[Invalid Date]';
    }
  }
  if (Array.isArray(value)) return value.length === 0 ? '[]' : `[…${value.length}]`;
  if (typeof value === 'object') {
    // Detect circular references defensively. We don't deep-print
    // anyway (`{…}` is the contract for objects per UX Guide v2 §0),
    // so the only thing we need to avoid is an unhandled throw.
    try {
      JSON.stringify(value);
      return '{…}';
    } catch {
      return '{circular}';
    }
  }
  return String(value);
}
