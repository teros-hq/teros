/**
 * StepUpDialog — re-authentication modal for sensitive admin operations.
 *
 * When a sensitive admin action (grant-access, update-user-role, etc.) returns
 * `STEP_UP_REQUIRED`, this dialog prompts the caller to re-verify their identity
 * with either their password (no MFA) or a TOTP code (MFA enabled). On success,
 * the caller's session gets a 10-minute step-up window and the original action
 * is retried automatically.
 *
 * Uses the same overlay pattern as ConfirmDialog (absolute positioning inside
 * the window, ds sheet on a scrim, `Field` input, `Btn` actions).
 */

import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { XStack, YStack } from "tamagui"
import { useColors } from "../../../components/mca/primitives/useColors"
import { Btn, Field, FieldHelp, T } from "../../../components/ui/ds"
import { getTerosClient } from "../../../services/terosClientSingleton"
import { useScrimColor, useSheetWeb } from "./ConfirmDialog"

export interface StepUpDialogProps {
  open: boolean
  /** Whether the caller has MFA enabled — determines which input to show. */
  mfaEnabled: boolean
  /** Called after successful step-up verification. */
  onSuccess: () => void
  /** Called when the user cancels (close button, Esc, backdrop). */
  onCancel: () => void
}

export function StepUpDialog({ open, mfaEnabled, onSuccess, onCancel }: StepUpDialogProps) {
  const { t } = useTranslation()
  const client = getTerosClient()
  const c = useColors()
  const scrim = useScrimColor()
  const sheetWeb = useSheetWeb()
  const dialogRef = useRef<{ focus?: () => void } | null>(null)

  const [value, setValue] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset state each time the dialog opens
  useEffect(() => {
    if (open) {
      setValue("")
      setBusy(false)
      setError(null)
    }
  }, [open])

  // Move focus to the dialog on open
  useEffect(() => {
    if (open) dialogRef.current?.focus?.()
  }, [open])

  if (!open) return null

  const handleVerify = async () => {
    if (!value.trim()) return
    setBusy(true)
    setError(null)
    try {
      const payload = mfaEnabled ? { mfaCode: value.trim() } : { password: value }
      await client.admin.verifyStepUp(payload)
      onSuccess()
    } catch (e) {
      const err = e as Error & { code?: string }
      // Map known error codes to user-friendly messages
      if (err.code === "INVALID_CREDENTIALS") {
        setError(t("windows.usersPanel.actions.stepUp.wrongPassword"))
      } else if (err.code === "MFA_INVALID") {
        setError(t("windows.usersPanel.actions.stepUp.wrongMfa"))
      } else if (err.code === "MFA_REQUIRED") {
        setError(t("windows.usersPanel.actions.stepUp.mfaRequired"))
      } else {
        setError(err.message ?? t("windows.usersPanel.actions.stepUp.failed"))
      }
    } finally {
      setBusy(false)
    }
  }

  const title = mfaEnabled
    ? t("windows.usersPanel.actions.stepUp.mfaTitle")
    : t("windows.usersPanel.actions.stepUp.passwordTitle")

  const body = mfaEnabled
    ? t("windows.usersPanel.actions.stepUp.mfaBody")
    : t("windows.usersPanel.actions.stepUp.passwordBody")

  const placeholder = mfaEnabled
    ? t("windows.usersPanel.actions.stepUp.mfaPlaceholder")
    : t("windows.usersPanel.actions.stepUp.passwordPlaceholder")

  const confirmLabel = t("windows.usersPanel.actions.stepUp.confirm")
  const cancelLabel = t("windows.usersPanel.actions.cancel")
  const canVerify = !busy && value.trim().length > 0

  return (
    <YStack
      testID="stepup-dialog-backdrop"
      position="absolute"
      top={0}
      left={0}
      right={0}
      bottom={0}
      ai="center"
      jc="center"
      padding={24}
      zIndex={1001}
      backgroundColor={scrim}
      onPress={busy ? undefined : onCancel}
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
            if (e.key === "Escape" && !busy) onCancel()
          },
        } as Record<string, unknown>)}
      >
        <T step="xl">{title}</T>
        <T step="sm" tone="text2">
          {body}
        </T>

        <Field
          testID="stepup-input"
          icon={mfaEnabled ? "device-mobile" : "lock-key"}
          value={value}
          onChangeText={setValue}
          placeholder={placeholder}
          secureTextEntry={!mfaEnabled}
          mono={mfaEnabled}
          autoCapitalize="none"
          autoComplete="off"
          editable={!busy}
          error={!!error}
          onSubmitEditing={() => {
            if (canVerify) handleVerify()
          }}
        />

        {error ? (
          <FieldHelp error style={{ marginTop: -4 }}>
            <T step="12" testID="stepup-error" color={c.tint.r.tx}>
              {error}
            </T>
          </FieldHelp>
        ) : null}

        <XStack gap={8} jc="flex-end" ai="center" paddingTop={6}>
          <Btn
            testID="stepup-cancel"
            variant="ghost"
            disabled={busy}
            onPress={busy ? undefined : onCancel}
            {...({ "aria-disabled": busy } as Record<string, unknown>)}
          >
            {cancelLabel}
          </Btn>
          <Btn
            testID="stepup-confirm"
            variant="primary"
            icon="shield-check"
            disabled={!canVerify}
            onPress={canVerify ? handleVerify : undefined}
            {...({ "aria-disabled": !canVerify } as Record<string, unknown>)}
          >
            {busy ? t("windows.usersPanel.actions.stepUp.verifying") : confirmLabel}
          </Btn>
        </XStack>
      </YStack>
    </YStack>
  )
}
