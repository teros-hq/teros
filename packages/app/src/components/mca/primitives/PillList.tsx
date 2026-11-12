import type React from "react"
import { XStack } from "tamagui"
import { T } from "../../ui/ds/Text"
import { useColors } from "./useColors"

interface PillListProps {
  /** Items simples como texto, o React nodes (Badge, IconChip) ya renderizados. */
  items: Array<string | React.ReactElement>
  /** Máximo a mostrar; el resto se resume como "+N more". */
  max?: number
  /** Accent para los pills auto-renderizados desde string. */
  accent?: string
}

/**
 * Lista horizontal de pills compactos (`.badge` neutral del prototipo: wash
 * de fondo, 10px, radio 5). Útil para tags, members, labels, roles,
 * categorías — cualquier lista plana que deba ser browseable en un solo
 * vistazo.
 *
 * Strings se convierten a pill simple; React elements (Badge, IconChip) se
 * insertan tal cual para permitir colores/iconos por item.
 */
export function PillList({ items, max = 8, accent }: PillListProps): React.ReactNode {
  const c = useColors()
  const visible = items.slice(0, max)
  const overflow = items.length - visible.length
  const bg = accent ? `${accent}1a` : c.wash
  const fg = accent ?? c.text2

  return (
    <XStack flexWrap="wrap" gap={5} alignItems="center">
      {visible.map((item, i) => {
        if (typeof item === "string") {
          return (
            <XStack
              // biome-ignore lint/suspicious/noArrayIndexKey: stable, no reorder
              key={`${i}-${item}`}
              backgroundColor={bg}
              borderRadius={5}
              paddingHorizontal={7}
              paddingVertical={2}
            >
              <T step="sm" color={fg} numberOfLines={1} style={{ fontSize: 10, lineHeight: 13 }}>
                {item}
              </T>
            </XStack>
          )
        }
        // React element — clonar con key
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: stable, no reorder
          <XStack key={i}>{item}</XStack>
        )
      })}
      {overflow > 0 && (
        <T step="codenote" tone="text3">
          +{overflow} more
        </T>
      )}
    </XStack>
  )
}
