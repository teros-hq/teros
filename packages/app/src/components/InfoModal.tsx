/**
 * InfoModal — primitivo de UX para retirar texto explicativo denso de la vista
 * principal. Renderiza un icono (i) accesible que abre un Tamagui Dialog
 * con el contenido completo (rich children).
 *
 * Cuándo usar:
 *   - Bloques educativos > 100 chars que el usuario solo necesita on-demand.
 *   - Metodologías / disclaimers que no caben en un tooltip de hover.
 *   - Notas técnicas que añaden contexto pero no son la acción principal.
 *
 * Cuándo NO usar (preferir tooltip):
 *   - Texto < 50 chars, una sola línea.
 *   - Operacionales tipo "p95 250ms · queue 0".
 *   - Hint repetitivo del estado actual (ej. duraciones).
 *
 * Patrón de uso:
 *
 *   <InfoModal title="How caching works" ariaLabel="Cache mechanism details">
 *     <Paragraph>...</Paragraph>
 *     <Paragraph>...</Paragraph>
 *   </InfoModal>
 *
 * Animación: usa la curva signature del proyecto (`animation="card"` +
 * `enterStyle={{ opacity: 0, scale: 0.96 }}`, `transformOrigin="top"`).
 * Driver `@tamagui/animations-css` (PWA-safe, ver CLAUDE.md).
 */

import { Info } from "@tamagui/lucide-icons"
import React, { useState, type ReactNode } from "react"
import {
  Button,
  Dialog,
  Paragraph,
  ScrollView,
  Unspaced,
  XStack,
  YStack,
} from "tamagui"

export interface InfoModalProps {
  /** Title shown at the top of the dialog. */
  title: string
  /**
   * Children rendered inside the dialog body. Free-form: use <Paragraph>,
   * <YStack>, lists, tables, etc. The wrapper applies a max-height +
   * ScrollView so long content stays accessible.
   */
  children: ReactNode
  /**
   * Accessible label for the trigger button. Defaults to
   * `"More information about: <title>"`. Pass a custom one when the title
   * is too generic.
   */
  ariaLabel?: string
  /**
   * Icon size in pixels. Default 14 (matches the 24×24 minimum touch target
   * once the surrounding padding is applied). 16-18 for prominent contexts.
   */
  iconSize?: number
  /**
   * Override the trigger appearance entirely. When provided, the default
   * (i) icon button is replaced by this node. The node must be pressable
   * — the modal wraps it with the open-state click handler.
   */
  trigger?: ReactNode
  /** Optional dismiss-button label. Defaults to common.close translation. */
  closeLabel?: string
}

export function InfoModal({
  title,
  children,
  ariaLabel,
  iconSize = 14,
  trigger,
  closeLabel = "Close",
}: InfoModalProps): React.ReactElement {
  const [open, setOpen] = useState(false)

  const triggerNode = trigger ?? (
    <Button
      size="$1"
      circular
      chromeless
      icon={<Info size={iconSize} color="$color9" />}
      aria-label={ariaLabel ?? `More information about: ${title}`}
      // role/button is implicit on Tamagui Button via the native element.
    />
  )

  return (
    <Dialog modal open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <YStack onPress={() => setOpen(true)} cursor="pointer">
          {triggerNode}
        </YStack>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay
          key="overlay"
          animation="card"
          opacity={0.5}
          enterStyle={{ opacity: 0 }}
          exitStyle={{ opacity: 0 }}
        />
        <Dialog.Content
          key="content"
          bordered
          elevate
          animation="card"
          enterStyle={{ opacity: 0, scale: 0.96 }}
          exitStyle={{ opacity: 0, scale: 0.96 }}
          transformOrigin="top"
          width={520}
          maxWidth="90%"
          padding="$5"
          gap="$4"
        >
          <Dialog.Title fontWeight="600" fontSize="$6">
            {title}
          </Dialog.Title>
          <ScrollView maxHeight={420} showsVerticalScrollIndicator={false}>
            <YStack gap="$3">{children}</YStack>
          </ScrollView>
          <XStack justifyContent="flex-end">
            <Dialog.Close asChild>
              <Button size="$3" onPress={() => setOpen(false)}>
                {closeLabel}
              </Button>
            </Dialog.Close>
          </XStack>
          <Unspaced>
            <Dialog.Close asChild>
              <Button
                position="absolute"
                top="$3"
                right="$3"
                size="$2"
                circular
                chromeless
                aria-label="Close dialog"
                onPress={() => setOpen(false)}
              >
                ×
              </Button>
            </Dialog.Close>
          </Unspaced>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog>
  )
}

/**
 * Convenience helper for inline use next to a section title:
 *
 *   <XStack gap="$2" alignItems="center">
 *     <H3>Cache & savings</H3>
 *     <InfoModal title="..." >...</InfoModal>
 *   </XStack>
 *
 * Bullet item shorthand for explainer lists.
 */
export function InfoBullet({
  marker = "●",
  color = "$color10",
  children,
}: {
  marker?: string
  color?: string
  children: ReactNode
}): React.ReactElement {
  return (
    <XStack gap="$2" alignItems="flex-start">
      <Paragraph color={color} fontSize="$2" lineHeight="$2">
        {marker}
      </Paragraph>
      <Paragraph flex={1} fontSize="$2" lineHeight="$2">
        {children}
      </Paragraph>
    </XStack>
  )
}
