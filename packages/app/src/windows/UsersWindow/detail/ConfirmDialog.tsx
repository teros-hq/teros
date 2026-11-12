/**
 * ConfirmDialog — an accessible, cross-native confirmation modal.
 *
 * Reusable by every destructive/irreversible admin action (and by the billing
 * edits). Renders as a Tamagui absolute overlay INSIDE the window (never fixed
 * positioning, so it can't escape the tiling layout), moves focus to the
 * dialog on open and closes on Esc. The sheet is a ds `Card`-style surface on
 * a dim backdrop with `Btn` actions; colours come from `useColors()`.
 */

import { type ReactNode, useEffect, useRef } from "react"
import { Platform } from "react-native"
import { XStack, YStack } from "tamagui"
import { useColors, useMcaTheme } from "../../../components/mca/primitives/useColors"
import { colors as semantic } from "../../../components/mca/primitives/colors"
import { Btn, T } from "../../../components/ui/ds"

export interface ConfirmDialogProps {
  open: boolean
  title: string
  body?: ReactNode
  confirmLabel: string
  cancelLabel: string
  tone?: "default" | "danger"
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/** Backdrop scrim: Main/900 ink at 40% (light) / 60% (dark). */
export function useScrimColor(): string {
  const theme = useMcaTheme()
  return `${semantic.main900}${theme === "light" ? "66" : "99"}`
}

/** The web lift of a floating sheet (`elevRaised`), no-op on native. */
export function useSheetWeb(): Record<string, unknown> | undefined {
  const c = useColors()
  return Platform.OS === "web" ? { style: { boxShadow: c.elevRaised } } : undefined
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel,
  tone = "default",
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const c = useColors()
  const scrim = useScrimColor()
  const sheetWeb = useSheetWeb()
  const dialogRef = useRef<{ focus?: () => void } | null>(null)

  // Move focus to the dialog on open so keyboard/AT users land inside it and Esc
  // (handled below) is captured without an extra tab.
  useEffect(() => {
    if (open) dialogRef.current?.focus?.()
  }, [open])

  if (!open) return null

  return (
    <YStack
      testID="confirm-dialog-backdrop"
      position="absolute"
      top={0}
      left={0}
      right={0}
      bottom={0}
      ai="center"
      jc="center"
      padding={24}
      zIndex={1000}
      backgroundColor={scrim}
      onPress={onCancel}
    >
      <YStack
        ref={dialogRef as never}
        width="100%"
        maxWidth={400}
        gap={12}
        padding={20}
        borderRadius={16}
        backgroundColor={c.bgStep}
        onPress={(e: { stopPropagation?: () => void }) => e.stopPropagation?.()}
        {...sheetWeb}
        {...({
          role: "dialog",
          "aria-modal": true,
          "aria-label": title,
          tabIndex: -1,
          onKeyDown: (e: { key: string }) => {
            if (e.key === "Escape") onCancel()
          },
        } as Record<string, unknown>)}
      >
        <T step="xl">{title}</T>
        {body != null ? (
          typeof body === "string" ? (
            <T step="sm" tone="text2">
              {body}
            </T>
          ) : (
            <YStack>{body}</YStack>
          )
        ) : null}
        <XStack gap={8} jc="flex-end" ai="center" paddingTop={6}>
          <Btn testID="confirm-dialog-cancel" variant="ghost" onPress={onCancel}>
            {cancelLabel}
          </Btn>
          <Btn
            testID="confirm-dialog-confirm"
            variant={tone === "danger" ? "danger" : "primary"}
            disabled={busy}
            onPress={busy ? undefined : onConfirm}
            {...({ "aria-disabled": busy } as Record<string, unknown>)}
          >
            {confirmLabel}
          </Btn>
        </XStack>
      </YStack>
    </YStack>
  )
}
