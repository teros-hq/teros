import type React from 'react';
import { YStack } from 'tamagui';
import { ActionBadge, type ActionVerb } from './ActionBadge';
import { EntityCardHeader } from './EntityCard';
import { useColors } from './useColors';

interface ResourceCardProps {
  /** Slot izquierdo (Avatar, IconTile). */
  leading?: React.ReactNode;
  /** Título visible. String → estilo default; ReactNode → control total (strikethrough, highlights, etc.). */
  title: string | React.ReactNode;
  /** Subtítulo opcional. Same semantics as title. */
  subtitle?: string | React.ReactNode;
  /**
   * Verbo de la acción. Si se define, se pinta un ActionBadge a la derecha del
   * header. Si se omite, el card funciona como detail-view (get-*).
   */
  verb?: ActionVerb;
  /** Slot extra de metadatos a la derecha del header (chips, badges). */
  meta?: React.ReactNode;
  /** Contenido del card (KeyValueGrid, PillList, texto). */
  children?: React.ReactNode;
}

/**
 * Card de recurso: header con leading + title + subtitle + `ActionBadge`
 * opcional + meta, body compacto con el contenido. Pensado para:
 *
 *  - Mostrar el resultado de un `create-*` / `update-*` con el recurso
 *    resultante + badge verde/amber.
 *  - Mostrar un `get-*` como detail-view (sin `verb`, sin badge).
 *  - Mostrar un `delete-*` / `archive-*` con el recurso afectado + badge
 *    rojo/gris (leading opcional en compacto).
 *
 * Se apoya en `EntityCardHeader` (primitivo base) para mantener consistencia
 * visual con el resto del ecosistema de cards del MCA.
 */
export function ResourceCard({
  leading,
  title,
  subtitle,
  verb,
  meta,
  children,
}: ResourceCardProps): React.ReactNode {
  const c = useColors();
  const headerMeta =
    verb || meta ? (
      <>
        {verb && <ActionBadge verb={verb} />}
        {meta}
      </>
    ) : undefined;

  return (
    <YStack
      backgroundColor={c.bgInner}
      borderRadius={6}
      borderWidth={1}
      borderColor={c.border}
      overflow="hidden"
    >
      <EntityCardHeader leading={leading} title={title} subtitle={subtitle} meta={headerMeta} />
      {children && (
        <YStack padding={10} gap={8}>
          {children}
        </YStack>
      )}
    </YStack>
  );
}
