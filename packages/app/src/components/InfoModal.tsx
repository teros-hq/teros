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
 * Look: the OS prototype's centred card (radius 24, serif title, pill
 * buttons). Animación: curva signature del proyecto (`animation="card"` +
 * `enterStyle={{ opacity: 0, scale: 0.96 }}`, `transformOrigin="top"`).
 */

import React, { useState, type ReactNode } from "react"
import { Platform, View } from "react-native"
import { Dialog, ScrollView, Unspaced, YStack } from "tamagui"
import { useColors } from "./mca/primitives/useColors"
import { Btn, IconBtn, T } from "./ui/ds"

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
  const c = useColors()

  const triggerNode = trigger ?? (
    <IconBtn
      icon="info"
      plain
      sm={iconSize <= 14}
      accessibilityLabel={ariaLabel ?? `More information about: ${title}`}
      onPress={() => setOpen(true)}
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
          backgroundColor={c.bgFrame}
          opacity={0.6}
          enterStyle={{ opacity: 0 }}
          exitStyle={{ opacity: 0 }}
        />
        <Dialog.Content
          key="content"
          animation="card"
          enterStyle={{ opacity: 0, scale: 0.96 }}
          exitStyle={{ opacity: 0, scale: 0.96 }}
          transformOrigin="top"
          width={520}
          maxWidth="92%"
          padding={0}
          borderWidth={0}
          borderRadius={24}
          backgroundColor={c.bgStep}
          style={Platform.OS === "web" ? ({ boxShadow: c.lift } as any) : undefined}
        >
          <View style={{ padding: 24, gap: 16 }}>
            <Dialog.Title asChild>
              <View style={{ paddingRight: 36 }}>
                <T step="xl">{title}</T>
              </View>
            </Dialog.Title>
            <ScrollView maxHeight={420} showsVerticalScrollIndicator={false}>
              <YStack gap="$3">{children}</YStack>
            </ScrollView>
            <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
              <Dialog.Close asChild>
                <Btn variant="sec" onPress={() => setOpen(false)}>
                  {closeLabel}
                </Btn>
              </Dialog.Close>
            </View>
          </View>
          <Unspaced>
            <View style={{ position: "absolute", top: 16, right: 16 }}>
              <Dialog.Close asChild>
                <IconBtn
                  icon="x"
                  plain
                  accessibilityLabel="Close dialog"
                  onPress={() => setOpen(false)}
                />
              </Dialog.Close>
            </View>
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
  color,
  children,
}: {
  marker?: string
  color?: string
  children: ReactNode
}): React.ReactElement {
  const c = useColors()
  return (
    <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
      <T step="sm" color={color ?? c.accent} style={{ fontSize: 9, lineHeight: 18 }}>
        {marker}
      </T>
      <T step="sm" tone="text2" style={{ flex: 1 }}>
        {children}
      </T>
    </View>
  )
}
