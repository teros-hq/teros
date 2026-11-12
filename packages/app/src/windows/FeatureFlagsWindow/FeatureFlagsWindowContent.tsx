/**
 * Feature Flags Window Content
 *
 * Admin panel for managing feature flags:
 * - List all registered flags with search/filter
 * - View/edit flag detail (default value, overrides)
 * - Add/edit/delete overrides
 * - Real-time updates with row highlighting
 *
 * Only accessible to users with role "super".
 *
 * Presentation follows the OS prototype (design-testing): `Page` + `PageHead`
 * on the sheet, flags as `LGroup`/`LRow` rows (boolean flags are a `Switch`
 * list), the detail as `Card` sections, modals restyled as cards inside the
 * Tamagui Sheet. All colours come from `useColors()`.
 */

import * as React from "react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Platform, Pressable, ScrollView, View } from "react-native"
import { Sheet, XStack, YStack } from "tamagui"
import { AppSpinner, FullscreenLoader } from "../../components/ui"
import {
  Badge,
  Btn,
  ChipBtn,
  Card,
  EmptyState,
  Field,
  FieldHelp,
  FieldLabel,
  IconBtn,
  LGroup,
  LRow,
  Page,
  PageHead,
  Ph,
  SectionLabel,
  Switch,
  T,
} from "../../components/ui/ds"
import type { BadgeTone } from "../../components/ui/ds"
import { useToast } from "../../components/Toast"
import { getTerosClient } from "../../services/terosClientSingleton"
import type { FeatureFlagItem, FeatureFlagOverrideItem } from "../../services/FeatureFlagApi"
import type { FeatureFlagsWindowProps } from "./definition"
import { useColors } from "../../components/mca/primitives/useColors"

// ============================================================================
// Types
// ============================================================================

interface Props extends FeatureFlagsWindowProps {
  windowId: string
}

type Screen = "list" | "detail"

interface FlagWithHighlight extends FeatureFlagItem {
  highlight?: boolean
}

interface ConfirmModalState {
  open: boolean
  flagKey: string
  newValue: unknown
  oldValue: unknown
  type: string
  onConfirm: () => void
}

// ============================================================================
// Helpers
// ============================================================================

function formatValue(value: unknown, type: string): string {
  if (value === undefined || value === null) return "—"
  if (type === "boolean") return value ? "true" : "false"
  if (type === "string[]") return (value as string[]).join(", ")
  return String(value)
}

/** Badge tone per flag type — boolean green, number violet, string mint, list amber. */
function getTypeTone(type: string): BadgeTone {
  switch (type) {
    case "boolean":
      return "g"
    case "number":
      return "i"
    case "string":
      return "m"
    case "string[]":
      return "a"
    default:
      return "neutral"
  }
}

function getDefaultForType(type: string): unknown {
  switch (type) {
    case "boolean":
      return false
    case "number":
      return 0
    case "string":
      return ""
    case "string[]":
      return []
    default:
      return null
  }
}

const EYEBROW_KEY = "admin.platformEyebrow"
const EYEBROW_DEFAULT = "Administración de la plataforma"

// ============================================================================
// Component
// ============================================================================

export function FeatureFlagsWindowContent({ windowId, search: initialSearch }: Props) {
  const { t } = useTranslation()
  const c = useColors()
  const client = getTerosClient()
  const toast = useToast()

  // -- Navigation state --
  const [screen, setScreen] = useState<Screen>("list")
  const [selectedFlagKey, setSelectedFlagKey] = useState<string | null>(null)

  // -- List state --
  const [flags, setFlags] = useState<FlagWithHighlight[]>([])
  const [searchQuery, setSearchQuery] = useState(initialSearch || "")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // -- Detail state --
  const [detailFlag, setDetailFlag] = useState<FeatureFlagItem | null>(null)
  const [overrides, setOverrides] = useState<FeatureFlagOverrideItem[]>([])
  const [detailLoading, setDetailLoading] = useState(false)
  const [defaultValueDraft, setDefaultValueDraft] = useState<unknown>(undefined)
  const [hasDefaultChanged, setHasDefaultChanged] = useState(false)
  const [savingDefault, setSavingDefault] = useState(false)
  const [resettingDefault, setResettingDefault] = useState(false)

  // -- Override edit state --
  const [editingOverride, setEditingOverride] = useState<FeatureFlagOverrideItem | null>(null)
  const [editDraftValue, setEditDraftValue] = useState<unknown>(undefined)
  const [editDraftNote, setEditDraftNote] = useState("")
  const [savingOverride, setSavingOverride] = useState(false)
  const [deletingOverride, setDeletingOverride] = useState<string | null>(null)

  // -- Add override modal state --
  const [showAddModal, setShowAddModal] = useState(false)
  const [addTargetType, setAddTargetType] = useState<"workspace" | "user" | "company">("workspace")
  const [addTargetId, setAddTargetId] = useState("")
  const [addValue, setAddValue] = useState<unknown>(undefined)
  const [addNote, setAddNote] = useState("")
  const [addSaving, setAddSaving] = useState(false)

  // -- Confirmation modal state --
  const [confirmModal, setConfirmModal] = useState<ConfirmModalState>({
    open: false,
    flagKey: "",
    newValue: undefined,
    oldValue: undefined,
    type: "boolean",
    onConfirm: () => {},
  })

  // -- Connection state --
  const [connected, setConnected] = useState(client.isConnected())

  // -- Highlight refs --
  const highlightTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  // ==========================================================================
  // Load initial data
  // ==========================================================================

  const loadFlags = useCallback(async () => {
    try {
      const result = await client.featureFlags.list()
      setFlags((prev) => {
        // Preserve highlights from previous state
        const prevMap = new Map(prev.map((f) => [f.key, f]))
        return result.flags.map((f) => ({
          ...f,
          highlight: prevMap.get(f.key)?.highlight ?? false,
        }))
      })
      setError(null)
    } catch (err: any) {
      setError(
        err.code === "FORBIDDEN"
          ? t("featureFlags.adminPrivilegesRequired")
          : err.message || t("featureFlags.failedToLoadFlags"),
      )
    } finally {
      setLoading(false)
    }
  }, [client])

  useEffect(() => {
    const tryLoad = async () => {
      if (client.isConnected()) {
        loadFlags()
      } else {
        const onConnected = () => {
          client.off("connected", onConnected)
          loadFlags()
        }
        client.on("connected", onConnected)
      }
    }
    tryLoad()

    // Connection monitoring
    const onConnected = () => setConnected(true)
    const onDisconnected = () => setConnected(false)
    client.on("connected", onConnected)
    client.on("disconnected", onDisconnected)

    return () => {
      client.off("connected", onConnected)
      client.off("disconnected", onDisconnected)
    }
  }, [client, loadFlags])

  // ==========================================================================
  // Real-time updates
  // ==========================================================================

  useEffect(() => {
    const handleFlagChange = (data: any) => {
      if (!data?.changes) return

      const changedKeys = new Set(data.changes.map((c: any) => c.flagKey))

      // Refresh flags list
      loadFlags()

      // Highlight changed rows
      setFlags((prev) =>
        prev.map((f) => {
          if (changedKeys.has(f.key)) {
            // Clear existing timer for this key
            const existing = highlightTimers.current.get(f.key)
            if (existing) clearTimeout(existing)

            // Set new timer
            const timer = setTimeout(() => {
              setFlags((p) => p.map((ff) => (ff.key === f.key ? { ...ff, highlight: false } : ff)))
              highlightTimers.current.delete(f.key)
            }, 3000)
            highlightTimers.current.set(f.key, timer)

            return { ...f, highlight: true }
          }
          return f
        }),
      )

      // If viewing detail of changed flag, refresh overrides
      if (selectedFlagKey && changedKeys.has(selectedFlagKey)) {
        loadDetail(selectedFlagKey)
      }
    }

    client.on("featureFlags.changed", handleFlagChange)
    return () => {
      client.off("featureFlags.changed", handleFlagChange)
    }
  }, [client, loadFlags, selectedFlagKey])

  // ==========================================================================
  // Detail loading
  // ==========================================================================

  const loadDetail = useCallback(
    async (key: string) => {
      setDetailLoading(true)
      try {
        const [flagResult, overridesResult] = await Promise.all([
          client.featureFlags.list().then((r) => r.flags.find((f) => f.key === key)),
          client.featureFlags.getOverrides(key),
        ])

        if (flagResult) {
          setDetailFlag(flagResult)
          setDefaultValueDraft(flagResult.defaultValue)
          setHasDefaultChanged(false)
        }
        setOverrides(overridesResult.overrides)
      } catch (err: any) {
        toast.error(t("featureFlags.error"), err.message || t("featureFlags.failedToLoadDetail"))
      } finally {
        setDetailLoading(false)
      }
    },
    [client, toast],
  )

  const handleSelectFlag = (flag: FeatureFlagItem) => {
    setSelectedFlagKey(flag.key)
    setDetailFlag(flag)
    setDefaultValueDraft(flag.defaultValue)
    setHasDefaultChanged(false)
    setOverrides([])
    setEditingOverride(null)
    setScreen("detail")
    loadDetail(flag.key)
  }

  const handleBackToList = () => {
    setScreen("list")
    setSelectedFlagKey(null)
    setDetailFlag(null)
    setEditingOverride(null)
  }

  // ==========================================================================
  // Confirmation helpers
  // ==========================================================================

  const openConfirmModal = useCallback(
    (
      flagKey: string,
      oldValue: unknown,
      newValue: unknown,
      type: string,
      onConfirm: () => void,
    ) => {
      setConfirmModal({
        open: true,
        flagKey,
        newValue,
        oldValue,
        type,
        onConfirm,
      })
    },
    [],
  )

  const closeConfirmModal = useCallback(() => {
    setConfirmModal((prev) => ({ ...prev, open: false }))
  }, [])

  // ==========================================================================
  // Default value management
  // ==========================================================================

  const handleSaveDefault = async () => {
    if (!detailFlag || defaultValueDraft === undefined) return
    setSavingDefault(true)
    try {
      await client.featureFlags.update(detailFlag.key, defaultValueDraft as any)
      toast.success(
        t("featureFlags.saved"),
        t("featureFlags.defaultValueUpdated", { flagKey: detailFlag.key }),
      )
      setHasDefaultChanged(false)
      // Refresh the flag in the list
      loadFlags()
    } catch (err: any) {
      toast.error(t("featureFlags.error"), err.message || t("featureFlags.failedToUpdateDefault"))
    } finally {
      setSavingDefault(false)
    }
  }

  const handleResetDefault = async () => {
    if (!detailFlag) return
    setResettingDefault(true)
    try {
      await client.featureFlags.resetDefault(detailFlag.key)
      toast.success(
        t("featureFlags.reset"),
        t("featureFlags.resetToDefault", { flagKey: detailFlag.key }),
      )
      setHasDefaultChanged(false)
      loadDetail(detailFlag.key)
      loadFlags()
    } catch (err: any) {
      toast.error(t("featureFlags.error"), err.message || t("featureFlags.failedToResetDefault"))
    } finally {
      setResettingDefault(false)
    }
  }

  // ==========================================================================
  // Override management
  // ==========================================================================

  const handleSaveOverrideEdit = async () => {
    if (!detailFlag || !editingOverride) return
    setSavingOverride(true)
    try {
      await client.featureFlags.setOverride(
        detailFlag.key,
        editingOverride.targetType,
        editingOverride.targetId,
        editDraftValue as any,
        editDraftNote,
      )
      toast.success(t("featureFlags.saved"), t("featureFlags.overrideUpdated"))
      setEditingOverride(null)
      loadDetail(detailFlag.key)
      loadFlags()
    } catch (err: any) {
      toast.error(t("featureFlags.error"), err.message || t("featureFlags.failedToUpdateOverride"))
    } finally {
      setSavingOverride(false)
    }
  }

  const handleDeleteOverride = async (override: FeatureFlagOverrideItem) => {
    if (!detailFlag) return
    setDeletingOverride(`${override.targetType}-${override.targetId}`)
    try {
      await client.featureFlags.deleteOverride(
        detailFlag.key,
        override.targetType,
        override.targetId,
      )
      toast.success(t("featureFlags.deleted"), t("featureFlags.overrideRemoved"))
      setEditingOverride(null)
      loadDetail(detailFlag.key)
      loadFlags()
    } catch (err: any) {
      toast.error(t("featureFlags.error"), err.message || t("featureFlags.failedToDeleteOverride"))
    } finally {
      setDeletingOverride(null)
    }
  }

  const handleAddOverride = async () => {
    if (!detailFlag || addValue === undefined || !addTargetId.trim()) return
    setAddSaving(true)
    try {
      await client.featureFlags.setOverride(
        detailFlag.key,
        addTargetType,
        addTargetId.trim(),
        addValue as any,
        addNote.trim() || undefined,
      )
      toast.success(t("featureFlags.created"), t("featureFlags.overrideAdded"))
      setShowAddModal(false)
      resetAddModal()
      loadDetail(detailFlag.key)
      loadFlags()
    } catch (err: any) {
      toast.error(t("featureFlags.error"), err.message || t("featureFlags.failedToCreateOverride"))
    } finally {
      setAddSaving(false)
    }
  }

  const resetAddModal = () => {
    setAddTargetType("workspace")
    setAddTargetId("")
    setAddValue(undefined)
    setAddNote("")
  }

  // ==========================================================================
  // Filtering
  // ==========================================================================

  const filteredFlags = useMemo(() => {
    if (!searchQuery.trim()) return flags
    const q = searchQuery.toLowerCase()
    return flags.filter(
      (f) =>
        f.key.toLowerCase().includes(q) ||
        f.description?.toLowerCase().includes(q) ||
        f.category?.toLowerCase().includes(q),
    )
  }, [flags, searchQuery])

  // ==========================================================================
  // Connection banner
  // ==========================================================================

  const ConnectionBanner = !connected ? (
    <XStack
      backgroundColor={c.tint.a.bg}
      borderWidth={1}
      borderColor={c.tint.a.bd}
      borderRadius={12}
      paddingHorizontal={14}
      paddingVertical={10}
      alignItems="center"
      gap={8}
      marginBottom={16}
    >
      <Ph name="arrows-clockwise" size={14} color={c.tint.a.tx} />
      <T step="sm" color={c.tint.a.tx}>
        {t("featureFlags.connectionLost")}
      </T>
    </XStack>
  ) : null

  const eyebrow = t(EYEBROW_KEY, { defaultValue: EYEBROW_DEFAULT })

  // ==========================================================================
  // Error screen
  // ==========================================================================

  if (error && screen === "list") {
    return (
      <Page>
        <PageHead
          eyebrow={eyebrow}
          title={t("featureFlags.title")}
          lead={t("windows.featureFlagsSub")}
        />
        <Card pad>
          <EmptyState icon="shield-check" title={error} text={t("featureFlags.adminRequired")} />
        </Card>
      </Page>
    )
  }

  // ==========================================================================
  // LIST SCREEN
  // ==========================================================================

  if (screen === "list") {
    return (
      <Page>
        <PageHead
          eyebrow={eyebrow}
          title={t("featureFlags.title")}
          lead={t("windows.featureFlagsSub")}
          actions={
            <Field
              icon="magnifying-glass"
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder={t("featureFlags.searchPlaceholder")}
              containerStyle={{ width: 260 }}
              right={
                searchQuery ? (
                  <IconBtn
                    icon="x"
                    plain
                    sm
                    onPress={() => setSearchQuery("")}
                    title={t("common.close")}
                  />
                ) : null
              }
            />
          }
        />

        {ConnectionBanner}

        {loading ? (
          <FullscreenLoader variant="default" label={t("featureFlags.loadingFlags")} />
        ) : filteredFlags.length === 0 ? (
          <Card pad>
            <EmptyState
              icon="flag"
              title={
                searchQuery
                  ? t("featureFlags.noFlagsMatch", { query: searchQuery })
                  : t("featureFlags.noFlagsRegistered")
              }
              text={searchQuery ? undefined : t("featureFlags.addFlagsHint")}
            />
          </Card>
        ) : (
          <>
            <SectionLabel label={t("featureFlags.title")} count={filteredFlags.length} />
            <LGroup>
              {filteredFlags.map((flag) => (
                <LRow
                  key={flag.key}
                  padV={12}
                  gap={12}
                  style={
                    [
                      { alignItems: "center" },
                      flag.highlight ? { backgroundColor: c.navActive } : null,
                      Platform.OS === "web" ? ({ transition: "background 0.6s" } as any) : null,
                    ] as any
                  }
                >
                  {/* Left: key, type badge, override count, description — tap → detail */}
                  <Pressable
                    onPress={() => handleSelectFlag(flag)}
                    disabled={!connected}
                    accessibilityRole="button"
                    style={[
                      { flex: 1, minWidth: 0 },
                      Platform.OS === "web" ? ({ cursor: "pointer" } as any) : null,
                    ]}
                  >
                    <XStack alignItems="center" gap={8} flexWrap="wrap">
                      <T step="code">{flag.key}</T>
                      <Badge mono sm tone={getTypeTone(flag.type)}>
                        {flag.type}
                      </Badge>
                      {flag.overrideCount > 0 ? (
                        <Badge tone="i" sm mono>
                          {t("featureFlags.overrideCount", {
                            count: flag.overrideCount,
                            defaultValue: "{{count}} overrides",
                          })}
                        </Badge>
                      ) : null}
                    </XStack>
                    {flag.description ? (
                      <T
                        step="12"
                        tone="text3"
                        numberOfLines={2}
                        style={{ marginTop: 3, maxWidth: 640 }}
                      >
                        {flag.description}
                      </T>
                    ) : null}
                  </Pressable>

                  {/* Right: editable value widget */}
                  <View style={{ alignItems: "flex-end", justifyContent: "center", flexShrink: 0 }}>
                    <ValueWidget
                      type={flag.type}
                      enumValues={flag.enumValues}
                      value={flag.defaultValue}
                      onCommit={(newValue) => {
                        openConfirmModal(
                          flag.key,
                          flag.defaultValue,
                          newValue,
                          flag.type,
                          async () => {
                            try {
                              await client.featureFlags.update(flag.key, newValue as any)
                              toast.success(
                                t("common.saved"),
                                t("featureFlags.defaultValueUpdated", { flagKey: flag.key }),
                              )
                              loadFlags()
                            } catch (err: any) {
                              toast.error(
                                t("common.error"),
                                err.message || t("errors.featureFlags.updateDefaultFailed"),
                              )
                            }
                          },
                        )
                      }}
                      disabled={!connected}
                    />
                  </View>

                  <IconBtn
                    icon="caret-right"
                    plain
                    sm
                    onPress={() => handleSelectFlag(flag)}
                    disabled={!connected}
                    title={
                      flag.overrideCount === 0
                        ? t("featureFlags.addOverride")
                        : t("featureFlags.manageOverrides", { count: flag.overrideCount })
                    }
                  />
                </LRow>
              ))}
            </LGroup>
          </>
        )}

        {/* Confirmation Modal */}
        <ConfirmValueModal
          open={confirmModal.open}
          onClose={closeConfirmModal}
          flagKey={confirmModal.flagKey}
          oldValue={confirmModal.oldValue}
          newValue={confirmModal.newValue}
          type={confirmModal.type}
          onConfirm={confirmModal.onConfirm}
        />
      </Page>
    )
  }

  // ==========================================================================
  // DETAIL SCREEN
  // ==========================================================================

  return (
    <Page>
      <View style={{ flexDirection: "row", marginBottom: 14 }}>
        <Btn variant="ghost" size="sm" icon="arrow-left" onPress={handleBackToList}>
          {t("common.back")}
        </Btn>
      </View>

      <PageHead
        eyebrow={eyebrow}
        eyebrowRight={
          detailFlag ? (
            <XStack alignItems="center" gap={8}>
              <Badge mono sm tone={getTypeTone(detailFlag.type)}>
                {detailFlag.type}
              </Badge>
              {detailFlag.category ? (
                <T step="codenote" tone="text3">
                  {detailFlag.category}
                </T>
              ) : null}
            </XStack>
          ) : null
        }
        title={detailFlag?.key || t("featureFlags.flagDetail")}
        lead={detailFlag?.description || undefined}
      />

      {ConnectionBanner}

      {detailLoading && !detailFlag ? (
        <FullscreenLoader variant="default" label={t("common.loading")} />
      ) : detailFlag ? (
        <YStack gap={20}>
          {/* Global Default Section */}
          <Card pad>
            <T step="base">{t("featureFlags.globalDefault")}</T>
            <View style={{ marginTop: 12 }}>
              <ValueInput
                type={detailFlag.type}
                enumValues={detailFlag.enumValues}
                value={defaultValueDraft}
                onChange={(v) => {
                  setDefaultValueDraft(v)
                  setHasDefaultChanged(true)
                }}
              />
            </View>

            <XStack gap={8} justifyContent="flex-end" marginTop={16} flexWrap="wrap">
              <Btn
                variant="sec"
                size="sm"
                icon="arrows-clockwise"
                onPress={handleResetDefault}
                disabled={!connected || resettingDefault}
                loading={resettingDefault}
              >
                {t("featureFlags.resetToRegistryDefault")}
              </Btn>
              <Btn
                variant="primary"
                size="sm"
                icon="floppy-disk"
                onPress={() => {
                  if (!detailFlag || defaultValueDraft === undefined) return
                  openConfirmModal(
                    detailFlag.key,
                    detailFlag.defaultValue,
                    defaultValueDraft,
                    detailFlag.type,
                    handleSaveDefault,
                  )
                }}
                disabled={!connected || !hasDefaultChanged || savingDefault}
                loading={savingDefault}
              >
                {t("common.save")}
              </Btn>
            </XStack>
          </Card>

          {/* Overrides Section */}
          <View>
            <SectionLabel
              label={t("featureFlags.overrides")}
              count={overrides.length}
              right={
                <Btn
                  variant="primary"
                  size="sm"
                  icon="plus"
                  onPress={() => {
                    resetAddModal()
                    setAddValue(getDefaultForType(detailFlag.type))
                    setShowAddModal(true)
                  }}
                  disabled={!connected}
                  style={{ marginRight: 10 }}
                >
                  {t("featureFlags.addOverrideButton")}
                </Btn>
              }
            />

            {overrides.length === 0 ? (
              <Card pad>
                <EmptyState
                  icon="sliders-horizontal"
                  title={t("featureFlags.noOverrides")}
                  style={{ paddingVertical: 28 }}
                />
              </Card>
            ) : (
              <LGroup>
                {overrides.map((override) => {
                  const isEditing =
                    editingOverride?.targetType === override.targetType &&
                    editingOverride?.targetId === override.targetId
                  const isDeleting =
                    deletingOverride === `${override.targetType}-${override.targetId}`

                  if (isEditing) {
                    return (
                      <LRow
                        key={`${override.targetType}-${override.targetId}`}
                        padV={14}
                        style={{ flexDirection: "column", alignItems: "stretch", gap: 12 }}
                      >
                        <XStack alignItems="center" gap={8}>
                          <Badge tone="i" cap>
                            {override.targetType}
                          </Badge>
                          <T step="code">{override.targetId}</T>
                        </XStack>
                        <View>
                          <FieldLabel>{t("featureFlags.valueLabel")}</FieldLabel>
                          <ValueInput
                            type={detailFlag.type}
                            enumValues={detailFlag.enumValues}
                            value={editDraftValue}
                            onChange={setEditDraftValue}
                          />
                        </View>
                        <View>
                          <FieldLabel>{t("featureFlags.noteOptional")}</FieldLabel>
                          <Field
                            value={editDraftNote}
                            onChangeText={setEditDraftNote}
                            placeholder={t("featureFlags.noteOptional")}
                          />
                        </View>
                        <XStack gap={8} justifyContent="flex-end">
                          <Btn variant="sec" size="sm" onPress={() => setEditingOverride(null)}>
                            {t("common.cancel")}
                          </Btn>
                          <Btn
                            variant="primary"
                            size="sm"
                            icon="floppy-disk"
                            onPress={handleSaveOverrideEdit}
                            disabled={savingOverride}
                            loading={savingOverride}
                          >
                            {t("common.save")}
                          </Btn>
                        </XStack>
                      </LRow>
                    )
                  }

                  return (
                    <LRow key={`${override.targetType}-${override.targetId}`} padV={12} gap={12}>
                      <Badge tone="i" cap>
                        {override.targetType}
                      </Badge>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <T step="code" numberOfLines={1}>
                          {override.targetId}
                        </T>
                        <XStack alignItems="center" gap={6} marginTop={2} flexWrap="wrap">
                          <T step="12" tone="text3">
                            {t("featureFlags.valueLabel")}
                          </T>
                          <T step="code" tone="text2">
                            {formatValue(override.value, detailFlag.type)}
                          </T>
                        </XStack>
                        {override.note ? (
                          <T step="12" tone="text3" style={{ fontStyle: "italic", marginTop: 2 }}>
                            {t("featureFlags.noteLabel", { note: override.note })}
                          </T>
                        ) : null}
                      </View>
                      <IconBtn
                        icon="pencil-simple"
                        plain
                        sm
                        title={t("common.edit")}
                        onPress={() => {
                          setEditingOverride(override)
                          setEditDraftValue(override.value)
                          setEditDraftNote(override.note || "")
                        }}
                        disabled={!connected}
                      />
                      {isDeleting ? (
                        <View
                          style={{
                            width: 28,
                            height: 28,
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          <AppSpinner size="sm" />
                        </View>
                      ) : (
                        <IconBtn
                          icon="trash"
                          plain
                          sm
                          danger
                          title={t("common.delete")}
                          onPress={() => handleDeleteOverride(override)}
                          disabled={!connected}
                        />
                      )}
                    </LRow>
                  )
                })}
              </LGroup>
            )}
          </View>
        </YStack>
      ) : null}

      {/* Add Override Modal */}
      <AddOverrideModal
        open={showAddModal}
        onClose={() => setShowAddModal(false)}
        flagType={detailFlag?.type || "boolean"}
        flagEnumValues={detailFlag?.enumValues}
        targetType={addTargetType}
        onTargetTypeChange={setAddTargetType}
        targetId={addTargetId}
        onTargetIdChange={setAddTargetId}
        value={addValue}
        onValueChange={setAddValue}
        note={addNote}
        onNoteChange={setAddNote}
        onSave={handleAddOverride}
        saving={addSaving}
        connected={connected}
      />

      {/* Confirmation Modal */}
      <ConfirmValueModal
        open={confirmModal.open}
        onClose={closeConfirmModal}
        flagKey={confirmModal.flagKey}
        oldValue={confirmModal.oldValue}
        newValue={confirmModal.newValue}
        type={confirmModal.type}
        onConfirm={confirmModal.onConfirm}
      />
    </Page>
  )
}

// ============================================================================
// ValueWidget — Compact editable widget for list view
// ============================================================================

function ValueWidget({
  type,
  value,
  onCommit,
  disabled,
  enumValues,
}: {
  type: string
  value: unknown
  onCommit: (v: unknown) => void
  disabled?: boolean
  enumValues?: string[]
}) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const serialize = (v: unknown) =>
    v !== undefined ? (type === "json" || type === "default" ? JSON.stringify(v) : String(v)) : ""
  // Local draft state for text inputs so we only commit on blur
  const [draft, setDraft] = useState(() => serialize(value))

  // Keep draft in sync when external value changes
  useEffect(() => {
    if (value !== undefined) setDraft(serialize(value))
  }, [value, type])

  // Boolean → the ds Switch; toggling opens the confirm modal (via onCommit).
  if (type === "boolean") {
    return <Switch on={!!value} onToggle={(v) => onCommit(v)} disabled={disabled} />
  }

  // Read mode: the value in mono + a pencil to edit in place.
  if (!editing) {
    return (
      <XStack alignItems="center" gap={4}>
        <T step="code" numberOfLines={1} style={{ maxWidth: 220 }}>
          {formatValue(value, type)}
        </T>
        <IconBtn
          icon="pencil-simple"
          plain
          sm
          title={t("common.edit")}
          onPress={() => setEditing(true)}
          disabled={disabled}
        />
      </XStack>
    )
  }

  const finish = (next: unknown, changed: boolean) => {
    setEditing(false)
    if (changed) onCommit(next)
  }

  switch (type) {
    case "number": {
      const commitNumber = () => {
        const num = parseFloat(draft)
        finish(Number.isNaN(num) ? draft : num, draft !== serialize(value))
      }
      return (
        <Field
          mono
          autoFocus
          value={draft}
          onChangeText={setDraft}
          onBlur={commitNumber}
          onSubmitEditing={commitNumber}
          keyboardType="numeric"
          editable={!disabled}
          containerStyle={{ width: 140 }}
          style={{ textAlign: "right" }}
        />
      )
    }

    case "string": {
      // Closed value set → segmented selector, commit on tap (TER-645/#1).
      if (enumValues && enumValues.length > 0) {
        return (
          <XStack gap={4} flexWrap="wrap" alignItems="center" justifyContent="flex-end">
            {enumValues.map((opt) => {
              const selected = value === opt
              return (
                <ChipBtn
                  key={opt}
                  on={selected}
                  mono
                  disabled={disabled}
                  onPress={() => finish(opt, !selected)}
                  aria-label={`Set value to ${opt}${selected ? " (selected)" : ""}`}
                >
                  {opt}
                </ChipBtn>
              )
            })}
            <IconBtn
              icon="x"
              plain
              sm
              title={t("common.cancel")}
              onPress={() => setEditing(false)}
            />
          </XStack>
        )
      }
      const commitString = () => finish(draft, draft !== serialize(value))
      return (
        <Field
          mono
          autoFocus
          value={draft}
          onChangeText={setDraft}
          onBlur={commitString}
          onSubmitEditing={commitString}
          editable={!disabled}
          containerStyle={{ width: 220 }}
        />
      )
    }

    default: {
      // JSON / fallback — compact textarea
      const commitJson = () => {
        const changed = draft !== serialize(value)
        try {
          finish(JSON.parse(draft), changed)
        } catch {
          finish(draft, changed)
        }
      }
      return (
        <Field
          mono
          area
          autoFocus
          minHeight={64}
          value={draft}
          onChangeText={setDraft}
          onBlur={commitJson}
          editable={!disabled}
          containerStyle={{ width: 260 }}
        />
      )
    }
  }
}

// ============================================================================
// ValueInput — Full editable input for detail view
// ============================================================================

function ValueInput({
  type,
  value,
  onChange,
  enumValues,
}: {
  type: string
  value: unknown
  onChange: (v: unknown) => void
  enumValues?: string[]
}) {
  const [stringValue, setStringValue] = useState("")
  const [jsonError, setJsonError] = useState<string | null>(null)

  useEffect(() => {
    if (type === "string[]") {
      if (Array.isArray(value)) {
        setStringValue((value as string[]).join(", "))
      }
    }
  }, [value, type])

  switch (type) {
    case "boolean":
      return (
        <XStack alignItems="center" gap={12}>
          <Switch on={!!value} onToggle={onChange} />
          <T step="code">{value ? "true" : "false"}</T>
        </XStack>
      )

    case "number":
      return (
        <Field
          mono
          value={value !== undefined ? String(value) : ""}
          onChangeText={(text) => {
            const num = parseFloat(text)
            onChange(Number.isNaN(num) ? text : num)
          }}
          keyboardType="numeric"
        />
      )

    case "string":
      // Closed value set (e.g. teros.fallback: off|on-error|cutover) → segmented
      // selector instead of free text, so the value can't be mistyped (TER-645/#1).
      if (enumValues && enumValues.length > 0) {
        return (
          <XStack gap={6} flexWrap="wrap">
            {enumValues.map((opt) => {
              const selected = value === opt
              return (
                <ChipBtn
                  key={opt}
                  on={selected}
                  mono
                  onPress={() => onChange(opt)}
                  aria-label={`Set value to ${opt}${selected ? " (selected)" : ""}`}
                >
                  {opt}
                </ChipBtn>
              )
            })}
          </XStack>
        )
      }
      return <Field value={value !== undefined ? String(value) : ""} onChangeText={onChange} />

    case "string[]":
      return (
        <View>
          <Field
            mono
            value={stringValue}
            onChangeText={(text) => {
              setStringValue(text)
              const parts = text
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
              onChange(parts)
            }}
            placeholder={"Value (comma-separated)"}
          />
          <FieldHelp>Comma-separated values</FieldHelp>
        </View>
      )

    default:
      return (
        <View>
          <Field
            mono
            area
            minHeight={72}
            error={!!jsonError}
            value={value !== undefined ? JSON.stringify(value) : ""}
            onChangeText={(text) => {
              try {
                const parsed = JSON.parse(text)
                onChange(parsed)
                setJsonError(null)
              } catch {
                onChange(text)
                setJsonError("Invalid JSON")
              }
            }}
          />
          {jsonError ? <FieldHelp error>{jsonError}</FieldHelp> : null}
        </View>
      )
  }
}

// ============================================================================
// Modal frame — the Tamagui Sheet with the card look of the prototype
// ============================================================================

function ModalSheet({
  open,
  onClose,
  snapPoints,
  children,
}: {
  open: boolean
  onClose: () => void
  snapPoints: number[]
  children: React.ReactNode
}) {
  const c = useColors()
  return (
    <Sheet
      modal
      open={open}
      onOpenChange={(o: boolean) => {
        if (!o) onClose()
      }}
      snapPoints={snapPoints}
      dismissOnSnapToBottom
      zIndex={100000}
    >
      <Sheet.Overlay
        animation={"lazy" as any}
        enterStyle={{ opacity: 0 }}
        exitStyle={{ opacity: 0 }}
        backgroundColor={c.inkPill}
        opacity={0.45}
      />
      <Sheet.Frame
        backgroundColor={c.bgSheet}
        borderTopLeftRadius={24}
        borderTopRightRadius={24}
        padding={0}
      >
        <Sheet.Handle backgroundColor={c.borderStrong} />
        <View
          style={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: 24, alignItems: "center" }}
        >
          <Card pad={24} style={{ width: "100%", maxWidth: 560 }}>
            {children}
          </Card>
        </View>
      </Sheet.Frame>
    </Sheet>
  )
}

// ============================================================================
// ConfirmValueModal
// ============================================================================

function ConfirmValueModal({
  open,
  onClose,
  flagKey,
  oldValue,
  newValue,
  type,
  onConfirm,
}: {
  open: boolean
  onClose: () => void
  flagKey: string
  oldValue: unknown
  newValue: unknown
  type: string
  onConfirm: () => void
}) {
  const [confirming, setConfirming] = useState(false)

  const handleConfirm = async () => {
    setConfirming(true)
    try {
      await onConfirm()
    } finally {
      setConfirming(false)
      onClose()
    }
  }

  return (
    <ModalSheet open={open} onClose={onClose} snapPoints={[40]}>
      <T step="xl">Cambiar valor</T>

      <T step="sm" tone="text2" style={{ marginTop: 12, lineHeight: 20 }}>
        ¿Cambiar <T step="code">{flagKey}</T> de <T step="code">{formatValue(oldValue, type)}</T> a{" "}
        <T step="code">{formatValue(newValue, type)}</T>? Esto afectará a todos los usuarios que no
        tengan un override activo.
      </T>

      <XStack gap={8} justifyContent="flex-end" marginTop={20}>
        <Btn variant="sec" onPress={onClose} disabled={confirming}>
          Cancelar
        </Btn>
        <Btn
          variant="primary"
          icon="floppy-disk"
          onPress={handleConfirm}
          disabled={confirming}
          loading={confirming}
        >
          Confirmar
        </Btn>
      </XStack>
    </ModalSheet>
  )
}

// ============================================================================
// AddOverrideModal
// ============================================================================

function AddOverrideModal({
  open,
  onClose,
  flagType,
  flagEnumValues,
  targetType,
  onTargetTypeChange,
  targetId,
  onTargetIdChange,
  value,
  onValueChange,
  note,
  onNoteChange,
  onSave,
  saving,
  connected,
}: {
  open: boolean
  onClose: () => void
  flagType: string
  flagEnumValues?: string[]
  targetType: "workspace" | "user" | "company"
  onTargetTypeChange: (t: "workspace" | "user" | "company") => void
  targetId: string
  onTargetIdChange: (id: string) => void
  value: unknown
  onValueChange: (v: unknown) => void
  note: string
  onNoteChange: (n: string) => void
  onSave: () => void
  saving: boolean
  connected: boolean
}) {
  const { t } = useTranslation()
  return (
    <ModalSheet open={open} onClose={onClose} snapPoints={[60]}>
      <XStack justifyContent="space-between" alignItems="center" marginBottom={16}>
        <T step="xl">Add Override</T>
        <IconBtn icon="x" plain sm title={t("common.close")} onPress={onClose} />
      </XStack>

      <ScrollView style={{ maxHeight: 500 }}>
        <YStack gap={18}>
          {/* Target Type */}
          <View>
            <FieldLabel required>Target Type</FieldLabel>
            <XStack gap={6} flexWrap="wrap">
              {(["workspace", "user", "company"] as const).map((type) => (
                <ChipBtn
                  key={type}
                  on={targetType === type}
                  icon={targetType === type ? "check" : undefined}
                  onPress={() => onTargetTypeChange(type)}
                >
                  {type}
                </ChipBtn>
              ))}
            </XStack>
          </View>

          {/* Target ID */}
          <View>
            <FieldLabel required>{t(`featureFlags.${targetType}Id`)}</FieldLabel>
            <Field
              mono
              value={targetId}
              onChangeText={onTargetIdChange}
              placeholder={`Enter ${targetType} ID`}
              autoCapitalize="none"
            />
          </View>

          {/* Value */}
          <View>
            <FieldLabel required>Value</FieldLabel>
            <ValueInput
              type={flagType}
              enumValues={flagEnumValues}
              value={value}
              onChange={onValueChange}
            />
          </View>

          {/* Note */}
          <View>
            <FieldLabel>Note</FieldLabel>
            <Field
              value={note}
              onChangeText={onNoteChange}
              placeholder={"Reason for this override..."}
            />
          </View>

          {/* Actions */}
          <XStack gap={8} justifyContent="flex-end" marginTop={4}>
            <Btn variant="sec" onPress={onClose}>
              Cancel
            </Btn>
            <Btn
              variant="primary"
              icon="floppy-disk"
              onPress={onSave}
              disabled={!connected || !targetId.trim() || value === undefined || saving}
              loading={saving}
            >
              Save Override
            </Btn>
          </XStack>
        </YStack>
      </ScrollView>
    </ModalSheet>
  )
}
