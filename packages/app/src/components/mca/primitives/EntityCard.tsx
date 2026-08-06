import type React from 'react';
import { Text, XStack, YStack } from 'tamagui';
import { useColors } from './useColors';

interface EntityCardHeaderProps {
  /** Slot izquierdo (Avatar, IconTile). */
  leading?: React.ReactNode;
  /** Título del card. String → estilo default (bold). ReactNode → control total. */
  title: string | React.ReactNode;
  /** Subtítulo. String → mono muted single-line. ReactNode → control total. */
  subtitle?: string | React.ReactNode;
  /** Chips/badges alineados a la derecha del header. */
  meta?: React.ReactNode;
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
  const c = useColors();
  return (
    <XStack
      gap={10}
      paddingHorizontal={10}
      paddingVertical={8}
      alignItems="center"
      borderBottomWidth={1}
      borderBottomColor={c.border}
    >
      {leading}
      <YStack flex={1} gap={2}>
        {typeof title === 'string' ? (
          <Text color={c.text} fontSize={12} fontWeight="600">
            {title}
          </Text>
        ) : (
          title
        )}
        {subtitle && (
          typeof subtitle === 'string' ? (
            <Text color={c.text2} fontSize={10} fontFamily="$mono" numberOfLines={1}>
              {subtitle}
            </Text>
          ) : (
            subtitle
          )
        )}
      </YStack>
      {meta && (
        <XStack alignItems="center" gap={4}>
          {meta}
        </XStack>
      )}
    </XStack>
  );
}

interface EntityCardProps extends EntityCardHeaderProps {
  /** Contenido del card (KeyValueGrid, lista de secciones, etc.). */
  children?: React.ReactNode;
}

/**
 * Card contenedor con header rico (leading slot + title + subtitle + meta) y
 * body opcional. Alternativa a ToolCallCard cuando se quiere un layout más
 * denso sin el estado expand/collapse.
 */
export function EntityCard({ leading, title, subtitle, meta, children }: EntityCardProps): React.ReactNode {
  const c = useColors();
  return (
    <YStack
      backgroundColor={c.bgInner}
      borderRadius={6}
      borderWidth={1}
      borderColor={c.border}
      overflow="hidden"
    >
      <EntityCardHeader leading={leading} title={title} subtitle={subtitle} meta={meta} />
      {children && <YStack padding={10} gap={8}>{children}</YStack>}
    </YStack>
  );
}
