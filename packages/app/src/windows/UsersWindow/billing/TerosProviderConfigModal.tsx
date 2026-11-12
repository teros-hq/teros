/**
 * TerosProviderConfigModal — manage the Teros provider configs (list / create /
 * delete) an admin can assign to a user's subscription.
 *
 * Accessible + cross-native: it renders as an in-window absolute overlay (the
 * SAME pattern as `ConfirmDialog`, never `position:'fixed'`), moves focus to the
 * dialog on open, closes on Esc, and confirms deletes through `ConfirmDialog`
 * (no native alert/confirm dialogs). Failures surface as an inline `FormError`, not a
 * native dialog. Presentation: a ds sheet on a scrim, hairline rows, `Field` /
 * `Btn` form controls; colours from `useColors()`.
 */

import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { View } from "react-native"
import { XStack, YStack } from "tamagui"
import { useColors } from "../../../components/mca/primitives/useColors"
import { Badge, Btn, IconBtn, T } from "../../../components/ui/ds"
import type { TerosProviderConfig } from "../../../services/AdminApi"
import { getTerosClient } from "../../../services/terosClientSingleton"
import { ConfirmDialog, useScrimColor, useSheetWeb } from "../detail/ConfirmDialog"
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
  const c = useColors()
  const scrim = useScrimColor()
  const sheetWeb = useSheetWeb()
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
      backgroundColor={scrim}
      onPress={onClose}
    >
      <YStack
        ref={dialogRef as never}
        width="100%"
        maxWidth={480}
        maxHeight="85%"
        gap={16}
        padding={20}
        borderRadius={16}
        backgroundColor={c.bgStep}
        onPress={(e: { stopPropagation?: () => void }) => e.stopPropagation?.()}
        {...sheetWeb}
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
        <XStack ai="center" jc="space-between" gap={12}>
          <T step="xl">{t("windows.usersPanel.billing.configTitle")}</T>
          <IconBtn
            testID="teros-config-close"
            icon="x"
            plain
            onPress={onClose}
            title={t("windows.usersPanel.billing.close")}
            aria-label={t("windows.usersPanel.billing.close")}
          />
        </XStack>

        {error ? <FormError message={error} testID="teros-config-error" /> : null}

        <View style={{ borderRadius: 12, backgroundColor: c.nest, overflow: "hidden" }}>
          {configs.length === 0 ? (
            <T step="sm" tone="text3" center style={{ paddingVertical: 14 }}>
              {t("windows.usersPanel.billing.configEmpty")}
            </T>
          ) : (
            configs.map((cfg, i) => (
              <ConfigRow
                key={cfg._id}
                config={cfg}
                first={i === 0}
                defaultLabel={t("windows.usersPanel.billing.configDefault")}
                deleteLabel={t("windows.usersPanel.billing.delete")}
                onDelete={() => setPendingDelete(cfg)}
              />
            ))
          )}
        </View>

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
  first,
  defaultLabel,
  deleteLabel,
  onDelete,
}: {
  config: TerosProviderConfig
  first: boolean
  defaultLabel: string
  deleteLabel: string
  onDelete: () => void
}) {
  const c = useColors()
  return (
    <View
      testID={`teros-config-row-${config._id}`}
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        paddingVertical: 10,
        paddingHorizontal: 14,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: c.border,
      }}
    >
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <T step="sm" ellipsis style={{ flexShrink: 1 }}>
            {config.name}
          </T>
          {config.isDefault ? (
            <Badge tone="g" sm>
              {defaultLabel}
            </Badge>
          ) : null}
        </View>
        <T step="code" tone="text3" ellipsis>
          {config._id}
        </T>
      </View>
      {config.isDefault ? null : (
        <Button
          testID={`teros-config-delete-${config._id}`}
          label={deleteLabel}
          tone="danger"
          icon="trash"
          onPress={onDelete}
        />
      )}
    </View>
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
  const c = useColors()
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

  const canCreate = !!name.trim() && !!key.trim()

  return (
    <View style={{ gap: 12, paddingTop: 16, borderTopWidth: 1, borderTopColor: c.border }}>
      <View>
        <FieldLabel>{t("windows.usersPanel.billing.configName")}</FieldLabel>
        <TextField
          testID="teros-config-name"
          value={name}
          onChangeText={setName}
          placeholder={t("windows.usersPanel.billing.configNamePlaceholder")}
        />
      </View>
      <View>
        <FieldLabel>{t("windows.usersPanel.billing.configKey")}</FieldLabel>
        <TextField
          testID="teros-config-key"
          value={key}
          onChangeText={setKey}
          placeholder={t("windows.usersPanel.billing.configKeyPlaceholder")}
          secure
        />
      </View>
      <View style={{ alignItems: "flex-start" }}>
        <Btn
          testID="teros-config-create"
          variant="primary"
          icon="plus"
          disabled={!canCreate}
          loading={busy}
          onPress={create}
        >
          {t("windows.usersPanel.billing.configCreate")}
        </Btn>
      </View>
    </View>
  )
}
