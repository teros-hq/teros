import type React from "react"
import { XStack, YStack } from "tamagui"
import { T } from "../../ui/ds/Text"
import { useColors } from "./useColors"

interface EntityCardHeaderProps {
  /** Slot izquierdo (Avatar, IconTile). */
  leading?: React.ReactNode
  /** Título del card. String → estilo default (sans 13). ReactNode → control total. */
  title: string | React.ReactNode
  /** Subtítulo. String → mono 11 text3 single-line. ReactNode → control total. */
  subtitle?: string | React.ReactNode
  /** Chips/badges alineados a la derecha del header. */
  meta?: React.ReactNode
}

/**
 * Header visual rico para un card de entidad. Reutilizado por EntityCard y
 * por wrappers que quieran solo la pieza del header sin el body.
 *
 * `title` y `subtitle` aceptan string (estilo default) o ReactNode (cuando
 * el caller necesita decoraciones específicas — strikethrough, highlight,
 * inline tags). Compatible hacia atrás: pasar string sigue funcionando.
 */
export function EntityCardHeader({
  leading,
  title,
  subtitle,
  meta,
}: EntityCardHeaderProps): React.ReactNode {
  const c = useColors()
  return (
    <XStack
      gap={10}
      paddingHorizontal={12}
      paddingVertical={10}
      alignItems="center"
      borderBottomWidth={1}
      borderBottomColor={c.border}
    >
      {leading}
      <YStack flex={1} minWidth={0} gap={2}>
        {typeof title === "string" ? (
          <T step="sm" numberOfLines={1}>
            {title}
          </T>
        ) : (
          title
        )}
        {subtitle &&
          (typeof subtitle === "string" ? (
            <T step="code" tone="text3" numberOfLines={1} style={{ fontSize: 11, lineHeight: 14 }}>
              {subtitle}
            </T>
          ) : (
            subtitle
          ))}
      </YStack>
      {meta && (
        <XStack alignItems="center" gap={6} flexShrink={0}>
          {meta}
        </XStack>
      )}
    </XStack>
  )
}

interface EntityCardProps extends EntityCardHeaderProps {
  /** Contenido del card (KeyValueGrid, lista de secciones, etc.). */
  children?: React.ReactNode
}

/**
 * Card contenedor con header rico (leading slot + title + subtitle + meta) y
 * body opcional. Alternativa a ToolCallCard cuando se quiere un layout más
 * denso sin el estado expand/collapse. Pintado como step card (radius 10,
 * hairline) dentro del cuerpo de la tool card.
 */
export function EntityCard({
  leading,
  title,
  subtitle,
  meta,
  children,
}: EntityCardProps): React.ReactNode {
  const c = useColors()
  return (
    <YStack
      backgroundColor={c.bgStep}
      borderRadius={10}
      borderWidth={1}
      borderColor={c.border}
      overflow="hidden"
    >
      <EntityCardHeader leading={leading} title={title} subtitle={subtitle} meta={meta} />
      {children && (
        <YStack padding={12} gap={8}>
          {children}
        </YStack>
      )}
    </YStack>
  )
}
