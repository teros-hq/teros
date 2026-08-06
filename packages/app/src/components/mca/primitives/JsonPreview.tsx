import type React from 'react';
import { Text, XStack, YStack } from 'tamagui';
import type { AdaptiveColors } from './useColors';
import { useColors } from './useColors';

interface JsonPreviewProps {
  /** Valor a pintar. Puede ser objeto, array, string, number, etc. */
  value: unknown;
  /** Máx. campos de un objeto a mostrar en línea. Default 10. */
  maxFields?: number;
  /** Máx. items de array a mostrar. Default 5. */
  maxItems?: number;
  /** Truncar strings largos a esta longitud. Default 80. */
  maxStringLen?: number;
}

/**
 * **Debug-only**. Pinta un valor desconocido de forma legible (clave:valor
 * compacto con colores, strings truncados, resumen de arrays/objetos
 * anidados) — alternativa al `JSON.stringify(x, null, 2)` crudo.
 *
 * ⚠️ NO usar en renderers de producción. Cada tool del MCA debe tener un
 * renderer dedicado que presente sus datos con primitivos semánticos
 * (`ResourceCard`, `DualEntity`, `EntityRow`, `KeyValueGrid`, …). El
 * JsonPreview queda reservado para:
 *   - El caso explícito `includeRaw: true` del tool (debug del LLM).
 *   - El `FallbackRenderer` cuando cae un tool sin renderer (bug visible
 *     solo en dev).
 *
 * Este primitivo resume arrays de objetos como `[N items]`, lo cual es
 * inútil como señal para el usuario — refuerza por qué no debe usarse
 * fuera de debug.
 */
export function JsonPreview({
  value,
  maxFields = 10,
  maxItems = 5,
  maxStringLen = 80,
}: JsonPreviewProps): React.ReactNode {
  const c = useColors();
  if (value === null) return <Scalar color={c.text3} text="null" />;
  if (value === undefined) return <Scalar color={c.text3} text="—" />;
  if (typeof value === 'string') return <Scalar color={c.text} text={truncateStr(value, maxStringLen)} />;
  if (typeof value === 'number') return <Scalar color={c.badges.info.text} text={String(value)} />;
  if (typeof value === 'boolean') return <Scalar color={c.badges.warn.text} text={String(value)} />;
  if (Array.isArray(value)) return <ArrayView items={value} maxItems={maxItems} c={c} />;
  if (typeof value === 'object') {
    return <ObjectView obj={value as Record<string, unknown>} maxFields={maxFields} maxStringLen={maxStringLen} c={c} />;
  }
  return <Scalar color={c.text3} text={String(value)} />;
}

function Scalar({ text, color }: { text: string; color: string }): React.ReactNode {
  return (
    <Text color={color} fontSize={10} fontFamily="$mono">
      {text}
    </Text>
  );
}

function truncateStr(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

const INLINE_ARRAY_MAX = 5;

function formatInline(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return '—';
  if (typeof v === 'string') return `"${truncateStr(v, 60)}"`;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    // Inline si todos los items son primitivos y el total es corto.
    // Arrays largos o con objetos/arrays anidados: resumen '[N items]' para
    // no reventar la línea.
    const allPrimitive = v.every(
      (item) =>
        item === null ||
        typeof item === 'string' ||
        typeof item === 'number' ||
        typeof item === 'boolean',
    );
    if (allPrimitive && v.length <= INLINE_ARRAY_MAX) {
      return `[${v.map((item) => formatInline(item)).join(', ')}]`;
    }
    return `[${v.length} items]`;
  }
  if (typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.length === 0) return '{}';
    return `{${keys.slice(0, 3).join(', ')}${keys.length > 3 ? ', …' : ''}}`;
  }
  return String(v);
}

function ObjectView({
  obj,
  maxFields,
  maxStringLen,
  c,
}: {
  obj: Record<string, unknown>;
  maxFields: number;
  maxStringLen: number;
  c: AdaptiveColors;
}): React.ReactNode {
  const entries = Object.entries(obj).slice(0, maxFields);
  const overflow = Object.keys(obj).length - entries.length;

  return (
    <YStack gap={3}>
      {entries.map(([k, v]) => (
        <XStack key={k} gap={8}>
          <Text width={120} color={c.text2} fontSize={10} fontFamily="$mono" flexShrink={0} numberOfLines={1}>
            {k}
          </Text>
          <Text flex={1} color={c.text} fontSize={10} fontFamily="$mono" numberOfLines={2}>
            {typeof v === 'string' ? truncateStr(v, maxStringLen) : formatInline(v)}
          </Text>
        </XStack>
      ))}
      {overflow > 0 && (
        <Text color={c.text3} fontSize={9} fontFamily="$mono">
          + {overflow} more fields
        </Text>
      )}
    </YStack>
  );
}

function ArrayView({ items, maxItems, c }: { items: unknown[]; maxItems: number; c: AdaptiveColors }): React.ReactNode {
  const visible = items.slice(0, maxItems);
  const overflow = items.length - visible.length;

  return (
    <YStack gap={3}>
      {visible.map((v, i) => (
        <XStack
          // biome-ignore lint/suspicious/noArrayIndexKey: stable list, no reorder
          key={i}
          gap={8}
        >
          <Text width={30} color={c.text3} fontSize={10} fontFamily="$mono">
            [{i}]
          </Text>
          <Text flex={1} color={c.text} fontSize={10} fontFamily="$mono" numberOfLines={2}>
            {formatInline(v)}
          </Text>
        </XStack>
      ))}
      {overflow > 0 && (
        <Text color={c.text3} fontSize={9} fontFamily="$mono">
          + {overflow} more items
        </Text>
      )}
    </YStack>
  );
}

