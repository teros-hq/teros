/**
 * DeleteAccountDialog — irreversible account erasure (profile.delete-account).
 *
 * The user re-authenticates inside the request: they always type their account
 * email (the confirm button stays disabled until it matches, case-insensitive),
 * plus an MFA code when MFA is on, or their password otherwise. OAuth-only
 * accounts without MFA confirm with the email alone.
 *
 * The app does not know up front whether the account has MFA or a password
 * (profile.get exposes neither), so the inputs adapt to the backend's answer:
 *   - start with an OPTIONAL password field (unless the props say otherwise),
 *   - MISSING_FIELDS → the password becomes required and is flagged,
 *   - MFA_REQUIRED   → the password field is swapped for an MFA code field.
 * ACCOUNT_DELETION_BLOCKED lists the shared workspaces the user owns that still
 * have other members (names resolved from workspace.list, ids as fallback).
 *
 * Same overlay pattern as ConfirmDialog / StepUpDialog (absolute positioning
 * inside the window, ds sheet on a scrim, `Field` inputs, `Btn` actions).
 */

import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { XStack, YStack } from "tamagui"
import { useColors } from "../../components/mca/primitives/useColors"
import { Btn, Field, FieldHelp, FieldLabel, T } from "../../components/ui/ds"
import type { DeleteAccountInput } from "../../services/ProfileApi"
import { getTerosClient } from "../../services/terosClientSingleton"
import { useScrimColor, useSheetWeb } from "../UsersWindow/detail/ConfirmDialog"

export interface DeleteAccountDialogProps {
  open: boolean
  /** The account email the user must type to confirm. */
  email: string
  /** Whether MFA is enabled. `undefined` = unknown (adapts on MFA_REQUIRED). */
  mfaEnabled?: boolean
  /** Whether the account has a password. `undefined` = unknown (field shown optional). */
  hasPassword?: boolean
  /** Called after the account was deleted (the caller clears the session). */
  onDeleted: () => void | Promise<void>
  /** Called when the user cancels (Cancel, Esc, backdrop). */
  onCancel: () => void
}

/** A blocked deletion: the shared workspaces to transfer or delete first. */
interface BlockedWorkspace {
  id: string
  name?: string
}

/**
 * The backend only sends the blocking workspace ids inside the message
 * ("…(they have other members): w_a, w_b"), so parse them from there.
 */
export function parseBlockedWorkspaceIds(message: string | undefined): string[] {
  if (!message) return []
  const idx = message.lastIndexOf(":")
  if (idx === -1) return []
  return message
    .slice(idx + 1)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

export function DeleteAccountDialog({
  open,
  email,
  mfaEnabled,
  hasPassword,
  onDeleted,
  onCancel,
}: DeleteAccountDialogProps) {
  const { t } = useTranslation()
  const client = getTerosClient()
  const c = useColors()
  const scrim = useScrimColor()
  const sheetWeb = useSheetWeb()
  const dialogRef = useRef<{ focus?: () => void } | null>(null)

  const [confirmEmail, setConfirmEmail] = useState("")
  const [password, setPassword] = useState("")
  const [mfaCode, setMfaCode] = useState("")
  // Learned from the backend when the props don't say (MFA_REQUIRED / MISSING_FIELDS)
  const [useMfa, setUseMfa] = useState(!!mfaEnabled)
  const [passwordRequired, setPasswordRequired] = useState(hasPassword === true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [blocked, setBlocked] = useState<BlockedWorkspace[] | null>(null)

  // Reset state each time the dialog opens
  useEffect(() => {
    if (open) {
      setConfirmEmail("")
      setPassword("")
      setMfaCode("")
      setUseMfa(!!mfaEnabled)
      setPasswordRequired(hasPassword === true)
      setBusy(false)
      setError(null)
      setBlocked(null)
    }
  }, [open, mfaEnabled, hasPassword])

  // Move focus to the dialog on open
  useEffect(() => {
    if (open) dialogRef.current?.focus?.()
  }, [open])

  if (!open) return null

  const emailMatches =
    confirmEmail.trim().length > 0 &&
    confirmEmail.trim().toLowerCase() === email.trim().toLowerCase()
  const showPassword = !useMfa && hasPassword !== false
  const secretMissing = useMfa ? !mfaCode.trim() : showPassword && passwordRequired && !password
  const canConfirm = !busy && emailMatches && !secretMissing

  const resolveBlocked = async (ids: string[]): Promise<BlockedWorkspace[]> => {
    try {
      const { workspaces } = await client.workspace.listWorkspaces()
      const names = new Map(workspaces.map((w) => [w.workspaceId, w.name]))
      return ids.map((id) => ({ id, name: names.get(id) }))
    } catch {
      return ids.map((id) => ({ id }))
    }
  }

  const handleConfirm = async () => {
    if (!canConfirm) return
    setBusy(true)
    setError(null)
    setBlocked(null)
    const payload: DeleteAccountInput = { confirmEmail: confirmEmail.trim() }
    if (useMfa) payload.mfaCode = mfaCode.trim()
    else if (showPassword && password) payload.password = password
    try {
      await client.profile.deleteAccount(payload)
      await onDeleted()
      return
    } catch (e) {
      const err = e as Error & { code?: string }
      switch (err.code) {
        case "CONFIRMATION_MISMATCH":
          setError(t("profile.deleteAccount.errors.confirmationMismatch"))
          break
        case "MFA_REQUIRED":
          setUseMfa(true)
          setError(t("profile.deleteAccount.errors.mfaRequired"))
          break
        case "MFA_INVALID":
          setError(t("profile.deleteAccount.errors.mfaInvalid"))
          break
        case "MISSING_FIELDS":
          setPasswordRequired(true)
          setError(t("profile.deleteAccount.errors.passwordRequired"))
          break
        case "INVALID_CREDENTIALS":
          setError(t("profile.deleteAccount.errors.invalidCredentials"))
          break
        case "ACCOUNT_DELETION_BLOCKED": {
          const ids = parseBlockedWorkspaceIds(err.message)
          setBlocked(await resolveBlocked(ids))
          setError(t("profile.deleteAccount.errors.blocked"))
          break
        }
        case "USER_NOT_FOUND":
          setError(t("profile.deleteAccount.errors.userNotFound"))
          break
        default:
          setError(err.message || t("profile.deleteAccount.errors.failed"))
      }
    }
    setBusy(false)
  }

  const title = t("profile.deleteAccount.dialogTitle")

  return (
    <YStack
      testID="delete-account-backdrop"
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
        maxWidth={440}
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
          {t("profile.deleteAccount.dialogBody")}
        </T>

        <YStack>
          <FieldLabel>{t("profile.deleteAccount.emailLabel", { email })}</FieldLabel>
          <Field
            testID="delete-account-email"
            icon="envelope-simple"
            value={confirmEmail}
            onChangeText={setConfirmEmail}
            placeholder={email}
            autoCapitalize="none"
            autoComplete="off"
            keyboardType="email-address"
            editable={!busy}
          />
        </YStack>

        {useMfa ? (
          <YStack>
            <FieldLabel>{t("profile.deleteAccount.mfaLabel")}</FieldLabel>
            <Field
              testID="delete-account-mfa"
              icon="device-mobile"
              value={mfaCode}
              onChangeText={setMfaCode}
              placeholder={t("profile.deleteAccount.mfaPlaceholder")}
              mono
              autoCapitalize="none"
              autoComplete="off"
              editable={!busy}
            />
          </YStack>
        ) : showPassword ? (
          <YStack>
            <FieldLabel>
              {passwordRequired
                ? t("profile.deleteAccount.passwordLabel")
                : t("profile.deleteAccount.passwordLabelOptional")}
            </FieldLabel>
            <Field
              testID="delete-account-password"
              icon="lock-key"
              value={password}
              onChangeText={setPassword}
              placeholder={t("profile.deleteAccount.passwordPlaceholder")}
              secureTextEntry
              autoCapitalize="none"
              autoComplete="off"
              editable={!busy}
              error={passwordRequired && !password && !!error}
            />
            {!passwordRequired ? (
              <FieldHelp>{t("profile.deleteAccount.passwordHint")}</FieldHelp>
            ) : null}
          </YStack>
        ) : null}

        {error ? (
          <FieldHelp error style={{ marginTop: -4 }}>
            <T step="12" testID="delete-account-error" color={c.tint.r.tx}>
              {error}
            </T>
          </FieldHelp>
        ) : null}

        {blocked && blocked.length > 0 ? (
          <YStack testID="delete-account-blocked" gap={4}>
            {blocked.map((w) => (
              <T key={w.id} step="sm" testID={`delete-account-blocked-${w.id}`}>
                {`• ${w.name ?? w.id}`}
              </T>
            ))}
          </YStack>
        ) : null}

        <XStack gap={8} jc="flex-end" ai="center" paddingTop={6}>
          <Btn
            testID="delete-account-cancel"
            variant="ghost"
            disabled={busy}
            onPress={busy ? undefined : onCancel}
            {...({ "aria-disabled": busy } as Record<string, unknown>)}
          >
            {t("common.cancel")}
          </Btn>
          <Btn
            testID="delete-account-confirm"
            variant="danger"
            icon="trash"
            disabled={!canConfirm}
            onPress={canConfirm ? handleConfirm : undefined}
            {...({ "aria-disabled": !canConfirm } as Record<string, unknown>)}
          >
            {busy ? t("profile.deleteAccount.deleting") : t("profile.deleteAccount.confirm")}
          </Btn>
        </XStack>
      </YStack>
    </YStack>
  )
}
