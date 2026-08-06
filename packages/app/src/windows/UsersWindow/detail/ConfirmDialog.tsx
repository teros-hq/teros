/**
 * ConfirmDialog — an accessible, cross-native confirmation modal.
 *
 * Reusable by every destructive/irreversible admin action (and by PR4's billing
 * edits). Renders as a Tamagui absolute overlay INSIDE the window (never fixed
 * positioning, so it can't escape the tiling layout), moves focus to the
 * dialog on open and closes on Esc. All colours derive from monitoring tokens
 * (no hardcoded hex/rgba) so theme work touches one file.
 */

import { type ReactNode, useEffect, useRef } from "react"
import { Text, XStack, YStack } from "tamagui"
import { tokens } from "../../../components/monitoring/colors"

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
  const dialogRef = useRef<{ focus?: () => void } | null>(null)

  // Move focus to the dialog on open so keyboard/AT users land inside it and Esc
  // (handled below) is captured without an extra tab.
  useEffect(() => {
    if (open) dialogRef.current?.focus?.()
  }, [open])

  if (!open) return null

  const accent = tone === "danger" ? tokens.error : tokens.accent

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
      // Scrim derived from the bg token (~90%), not a hardcoded rgba.
      backgroundColor={`${tokens.bg}E6`}
      onPress={onCancel}
    >
      <YStack
        ref={dialogRef as never}
        width="100%"
        maxWidth={380}
        gap={14}
        padding={22}
        borderRadius={14}
        borderWidth={1}
        borderColor={tokens.borderHover}
        backgroundColor={tokens.bgPress}
        onPress={(e: { stopPropagation?: () => void }) => e.stopPropagation?.()}
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
        <Text fontSize={16} fontWeight="650" color={tokens.text}>
          {title}
        </Text>
        {body != null ? (
          typeof body === "string" ? (
            <Text fontSize={13} lineHeight={20} color={tokens.textTertiary}>
              {body}
            </Text>
          ) : (
            <YStack>{body}</YStack>
          )
        ) : null}
        <XStack gap={8} jc="flex-end" ai="center">
          <DialogButton testID="confirm-dialog-cancel" label={cancelLabel} onPress={onCancel} />
          <DialogButton
            testID="confirm-dialog-confirm"
            label={confirmLabel}
            onPress={busy ? undefined : onConfirm}
            accent={accent}
            busy={busy}
          />
        </XStack>
      </YStack>
    </YStack>
  )
}

function DialogButton({
  testID,
  label,
  onPress,
  accent,
  busy,
}: {
  testID: string
  label: string
  onPress?: () => void
  accent?: string
  busy?: boolean
}) {
  const isPrimary = accent != null
  const color = accent ?? tokens.textSecondary
  const disabled = onPress == null

  return (
    <XStack
      testID={testID}
      paddingVertical={8}
      paddingHorizontal={14}
      borderRadius={8}
      borderWidth={1}
      borderColor={isPrimary ? `${color}55` : tokens.border}
      backgroundColor={isPrimary ? `${color}1A` : tokens.bgInner}
      opacity={busy ? 0.5 : 1}
      cursor={disabled ? "default" : "pointer"}
      hoverStyle={disabled ? {} : { backgroundColor: isPrimary ? `${color}26` : tokens.bgHover }}
      onPress={onPress}
      {...({ role: "button", tabIndex: disabled ? -1 : 0, "aria-disabled": disabled } as Record<
        string,
        unknown
      >)}
    >
      <Text fontSize={13} fontWeight="600" color={isPrimary ? color : tokens.textSecondary}>
        {label}
      </Text>
    </XStack>
  )
}
