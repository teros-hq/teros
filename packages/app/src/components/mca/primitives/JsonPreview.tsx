import type React from "react"
import { XStack, YStack } from "tamagui"
import { T } from "../../ui/ds/Text"
import { useColors } from "./useColors"

interface JsonPreviewProps {
  /** Valor a pintar. Puede ser objeto, array, string, number, etc. */
  value: unknown
  /** Máx. campos de un objeto a mostrar en línea. Default 10. */
  maxFields?: number
  /** Máx. items de array a mostrar. Default 5. */
  maxItems?: number
  /** Truncar strings largos a esta longitud. Default 80. */
  maxStringLen?: number
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
  const c = useColors()
  if (value === null) return <Scalar color={c.text3} text="null" />
  if (value === undefined) return <Scalar color={c.text3} text="—" />
  if (typeof value === "string")
    return <Scalar color={c.text} text={truncateStr(value, maxStringLen)} />
  if (typeof value === "number") return <Scalar color={c.tint.i.tx} text={String(value)} />
  if (typeof value === "boolean") return <Scalar color={c.tint.a.tx} text={String(value)} />
  if (Array.isArray(value)) return <ArrayView items={value} maxItems={maxItems} />
  if (typeof value === "object") {
    return (
      <ObjectView
        obj={value as Record<string, unknown>}
        maxFields={maxFields}
        maxStringLen={maxStringLen}
      />
    )
  }
  return <Scalar color={c.text3} text={String(value)} />
}

function Scalar({ text, color }: { text: string; color: string }): React.ReactNode {
  return (
    <T step="code" color={color} selectable>
      {text}
    </T>
  )
}

function truncateStr(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max)}…`
}

const INLINE_ARRAY_MAX = 5

function formatInline(v: unknown): string {
  if (v === null) return "null"
  if (v === undefined) return "—"
  if (typeof v === "string") return `"${truncateStr(v, 60)}"`
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]"
    // Inline si todos los items son primitivos y el total es corto.
    // Arrays largos o con objetos/arrays anidados: resumen '[N items]' para
    // no reventar la línea.
    const allPrimitive = v.every(
      (item) =>
        item === null ||
        typeof item === "string" ||
        typeof item === "number" ||
        typeof item === "boolean",
    )
    if (allPrimitive && v.length <= INLINE_ARRAY_MAX) {
      return `[${v.map((item) => formatInline(item)).join(", ")}]`
    }
    return `[${v.length} items]`
  }
  if (typeof v === "object") {
    const keys = Object.keys(v)
    if (keys.length === 0) return "{}"
    return `{${keys.slice(0, 3).join(", ")}${keys.length > 3 ? ", …" : ""}}`
  }
  return String(v)
}

function ObjectView({
  obj,
  maxFields,
  maxStringLen,
}: {
  obj: Record<string, unknown>
  maxFields: number
  maxStringLen: number
}): React.ReactNode {
  const entries = Object.entries(obj).slice(0, maxFields)
  const overflow = Object.keys(obj).length - entries.length

  return (
    <YStack gap={4}>
      {entries.map(([k, v]) => (
        <XStack key={k} gap={12}>
          <T
            step="code"
            tone="text3"
            numberOfLines={1}
            style={{ width: 110, flexShrink: 0, fontSize: 11, lineHeight: 16 }}
          >
            {k}
          </T>
          <T step="code" tone="text2" numberOfLines={2} style={{ flex: 1, minWidth: 0 }} selectable>
            {typeof v === "string" ? truncateStr(v, maxStringLen) : formatInline(v)}
          </T>
        </XStack>
      ))}
      {overflow > 0 && (
        <T step="codenote" tone="text3">
          + {overflow} more fields
        </T>
      )}
    </YStack>
  )
}

function ArrayView({ items, maxItems }: { items: unknown[]; maxItems: number }): React.ReactNode {
  const visible = items.slice(0, maxItems)
  const overflow = items.length - visible.length

  return (
    <YStack gap={4}>
      {visible.map((v, i) => (
        <XStack
          // biome-ignore lint/suspicious/noArrayIndexKey: stable list, no reorder
          key={i}
          gap={12}
        >
          <T
            step="code"
            tone="text3"
            style={{ width: 32, flexShrink: 0, fontSize: 11, lineHeight: 16 }}
          >
            [{i}]
          </T>
          <T step="code" tone="text2" numberOfLines={2} style={{ flex: 1, minWidth: 0 }} selectable>
            {formatInline(v)}
          </T>
        </XStack>
      ))}
      {overflow > 0 && (
        <T step="codenote" tone="text3">
          + {overflow} more items
        </T>
      )}
    </YStack>
  )
}
