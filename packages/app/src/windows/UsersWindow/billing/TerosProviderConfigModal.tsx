/**
 * TerosProviderConfigModal — manage the Teros provider configs (list / create /
 * delete) an admin can assign to a user's subscription.
 *
 * Accessible + cross-native: it renders as an in-window absolute overlay (the
 * SAME pattern as `ConfirmDialog`, never `position:'fixed'`), moves focus to the
 * dialog on open, closes on Esc, and confirms deletes through `ConfirmDialog`
 * (no native alert/confirm dialogs). Failures surface as an inline `FormError`, not a
 * native dialog. Colours are monitoring tokens only.
 */

import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Text, XStack, YStack } from "tamagui"
import { tokens } from "../../../components/monitoring/colors"
import type { TerosProviderConfig } from "../../../services/AdminApi"
import { getTerosClient } from "../../../services/terosClientSingleton"
import { ConfirmDialog } from "../detail/ConfirmDialog"
import { Button, FieldLabel, FormError, TextField } from "./formPrimitives"

export interface TerosProviderConfigModalProps {
  open: boolean
  configs: TerosProviderConfig[]
  onClose: () => void
  onCreated: (config: TerosProviderConfig) => void
  onDeleted: (configId: string) => void
}

export function TerosProviderConfigModal({
  open,
  configs,
  onClose,
  onCreated,
  onDeleted,
}: TerosProviderConfigModalProps) {
  const { t } = useTranslation()
  const client = getTerosClient()
  const dialogRef = useRef<{ focus?: () => void } | null>(null)

  const [pendingDelete, setPendingDelete] = useState<TerosProviderConfig | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) dialogRef.current?.focus?.()
  }, [open])

  if (!open) return null

  const runDelete = async () => {
    if (!pendingDelete) return
    setBusy(true)
    setError(null)
    try {
      await client.admin.deleteTerosProviderConfig(pendingDelete._id)
      onDeleted(pendingDelete._id)
      setPendingDelete(null)
    } catch (e) {
      setError(
        (e as { message?: string })?.message ?? t("windows.usersPanel.billing.configDeleteFailed"),
      )
      setPendingDelete(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <YStack
      testID="teros-config-backdrop"
      position="absolute"
      top={0}
      left={0}
      right={0}
      bottom={0}
      ai="center"
      jc="center"
      padding={24}
      zIndex={1000}
      backgroundColor={`${tokens.bg}E6`}
      onPress={onClose}
    >
      <YStack
        ref={dialogRef as never}
        width="100%"
        maxWidth={460}
        maxHeight="80%"
        gap={16}
        padding={20}
        borderRadius={14}
        borderWidth={1}
        borderColor={tokens.borderHover}
        backgroundColor={tokens.bgPress}
        onPress={(e: { stopPropagation?: () => void }) => e.stopPropagation?.()}
        {...({
          role: "dialog",
          "aria-modal": true,
          "aria-label": t("windows.usersPanel.billing.configTitle"),
          tabIndex: -1,
          onKeyDown: (e: { key: string }) => {
            if (e.key === "Escape") onClose()
          },
        } as Record<string, unknown>)}
      >
        <XStack ai="center" jc="space-between">
          <Text fontSize={16} fontWeight="650" color={tokens.text}>
            {t("windows.usersPanel.billing.configTitle")}
          </Text>
          <XStack
            testID="teros-config-close"
            padding={4}
            cursor="pointer"
            onPress={onClose}
            {...({
              role: "button",
              tabIndex: 0,
              "aria-label": t("windows.usersPanel.billing.close"),
            } as Record<string, unknown>)}
          >
            <Text fontSize={16} color={tokens.textTertiary}>
              ✕
            </Text>
          </XStack>
        </XStack>

        {error ? <FormError message={error} testID="teros-config-error" /> : null}

        <YStack gap={8}>
          {configs.length === 0 ? (
            <Text fontSize={13} color={tokens.textMuted} paddingVertical={10} textAlign="center">
              {t("windows.usersPanel.billing.configEmpty")}
            </Text>
          ) : (
            configs.map((cfg) => (
              <ConfigRow
                key={cfg._id}
                config={cfg}
                defaultLabel={t("windows.usersPanel.billing.configDefault")}
                deleteLabel={t("windows.usersPanel.billing.delete")}
                onDelete={() => setPendingDelete(cfg)}
              />
            ))
          )}
        </YStack>

        <CreateConfigForm
          onCreated={onCreated}
          onError={setError}
          clearError={() => setError(null)}
        />
      </YStack>

      <ConfirmDialog
        open={pendingDelete != null}
        title={t("windows.usersPanel.billing.configDeleteTitle", {
          name: pendingDelete?.name ?? "",
        })}
        body={t("windows.usersPanel.billing.configDeleteBody")}
        confirmLabel={t("windows.usersPanel.billing.delete")}
        cancelLabel={t("windows.usersPanel.billing.cancel")}
        tone="danger"
        busy={busy}
        onConfirm={runDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </YStack>
  )
}

function ConfigRow({
  config,
  defaultLabel,
  deleteLabel,
  onDelete,
}: {
  config: TerosProviderConfig
  defaultLabel: string
  deleteLabel: string
  onDelete: () => void
}) {
  return (
    <XStack
      testID={`teros-config-row-${config._id}`}
      ai="center"
      jc="space-between"
      gap={10}
      padding={10}
      borderRadius={8}
      borderWidth={1}
      borderColor={tokens.border}
      backgroundColor={tokens.bgInner}
    >
      <YStack flex={1} minWidth={0} gap={2}>
        <XStack ai="center" gap={6}>
          <Text fontSize={13} fontWeight="600" color={tokens.text} numberOfLines={1}>
            {config.name}
          </Text>
          {config.isDefault ? (
            <Text fontSize={10} fontWeight="600" color={tokens.success}>
              {defaultLabel}
            </Text>
          ) : null}
        </XStack>
        <Text fontFamily="$mono" fontSize={10} color={tokens.textMuted} numberOfLines={1}>
          {config._id}
        </Text>
      </YStack>
      {config.isDefault ? null : (
        <Button
          testID={`teros-config-delete-${config._id}`}
          label={deleteLabel}
          tone="danger"
          onPress={onDelete}
        />
      )}
    </XStack>
  )
}

function CreateConfigForm({
  onCreated,
  onError,
  clearError,
}: {
  onCreated: (config: TerosProviderConfig) => void
  onError: (message: string) => void
  clearError: () => void
}) {
  const { t } = useTranslation()
  const client = getTerosClient()
  const [name, setName] = useState("")
  const [key, setKey] = useState("")
  const [busy, setBusy] = useState(false)

  const create = async () => {
    if (!name.trim() || !key.trim()) return
    setBusy(true)
    clearError()
    try {
      const res = await client.admin.createTerosProviderConfig(name.trim(), key.trim())
      onCreated(res.config)
      setName("")
      setKey("")
    } catch (e) {
      onError(
        (e as { message?: string })?.message ?? t("windows.usersPanel.billing.configCreateFailed"),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <YStack gap={8} paddingTop={14} borderTopWidth={1} borderTopColor={tokens.border}>
      <YStack>
        <FieldLabel>{t("windows.usersPanel.billing.configName")}</FieldLabel>
        <TextField
          testID="teros-config-name"
          value={name}
          onChangeText={setName}
          placeholder={t("windows.usersPanel.billing.configNamePlaceholder")}
        />
      </YStack>
      <YStack>
        <FieldLabel>{t("windows.usersPanel.billing.configKey")}</FieldLabel>
        <TextField
          testID="teros-config-key"
          value={key}
          onChangeText={setKey}
          placeholder={t("windows.usersPanel.billing.configKeyPlaceholder")}
          secure
        />
      </YStack>
      <Button
        testID="teros-config-create"
        label={t("windows.usersPanel.billing.configCreate")}
        tone="positive"
        busy={busy}
        disabled={!name.trim() || !key.trim()}
        onPress={create}
      />
    </YStack>
  )
}
