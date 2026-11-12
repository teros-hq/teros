/**
 * Providers Window Content
 *
 * Manage user's LLM providers (API keys):
 * - List connected providers
 * - Add new provider (API key / OAuth)
 * - Auto-test connection (runs on card expand — no manual button)
 * - Delete provider
 *
 * OS prototype vocabulary (design-testing): a Page on the sheet with a
 * PageHead (eyebrow · serif title · lead · violet "add" pill), one LGroup of
 * provider rows (logo tile · name · status Badge · meta · caret) that expand
 * to a nested panel (retention notice, default-model OptionRows, actions).
 */

import React, { useEffect, useRef, useState } from "react"
import { Platform, Pressable, View } from "react-native"
import { getTerosClient } from "../../services/terosClientSingleton"
import { FullscreenLoader } from "../../components/ui"
import { useTranslation } from "react-i18next"
import {
  AddProviderForm,
  PROVIDER_TYPES,
  type OAuthState,
} from "../../components/onboarding/AddProviderForm"
import { ProviderIcon } from "../../components/providers/ProviderIcons"
import { resolveRetention } from "@teros/shared"
import {
  RetentionBadge,
  RetentionConfirmModal,
  RetentionNotice,
  useRetentionGuard,
} from "../../components/dataRetention"
import { useColors } from "../../components/mca/primitives/useColors"
import {
  Badge,
  Btn,
  Card,
  EmptyState,
  FieldLabel,
  IconBtn,
  LGroup,
  OptionRow,
  Page,
  PageHead,
  Ph,
  SectionLabel,
  T,
  type BadgeTone,
} from "../../components/ui/ds"

/** The 44px logo tile of a provider row (`.prov-logo`): brand glyph on a
 *  tint of the brand colour, a Phosphor key when the type is unknown. */
function ProviderLogo({ providerType, color }: { providerType: string; color?: string }) {
  const c = useColors()
  const tint = color || c.accent
  const icon = <ProviderIcon providerType={providerType} size={20} color={tint} />
  return (
    <View
      style={{
        width: 44,
        height: 44,
        borderRadius: 12,
        backgroundColor: `${tint}1F`,
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      {/* ProviderIcon returns null for unknown types — fall back to a key */}
      {icon ?? <Ph name="key" size={20} color={tint} />}
    </View>
  )
}

interface UserProvider {
  providerId: string
  providerType: string
  displayName: string
  /** Provider config (e.g. zhipu `useChina`) — needed to resolve the retention
   * tier accurately (otherwise a China-routed zhipu shows the softer z.ai tier). */
  config?: Record<string, unknown>
  models: Array<{
    modelId: string
    modelString: string
    capabilities: {
      streaming: boolean
      tools: boolean
      vision: boolean
    }
  }>
  defaultModelId?: string
  isDefault: boolean
  priority: number
  status: "active" | "error" | "disabled"
  lastTestedAt?: string
  errorMessage?: string
  createdAt: string
}

// ── StatusBadge ───────────────────────────────────────────────────────────────

const STATUS_TONE: Record<string, BadgeTone> = { active: "g", error: "r", disabled: "muted" }

function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation()
  return (
    <Badge tone={STATUS_TONE[status] ?? "muted"} dot>
      {t(`providers.status.${status}`, { defaultValue: status })}
    </Badge>
  )
}

// ── ProviderCard ──────────────────────────────────────────────────────────────

export function ProviderCard({
  provider,
  onTest,
  onDelete,
  onSetDefault,
  onSetDefaultModel,
  testing,
  settingDefault,
}: {
  provider: UserProvider
  onTest: () => void
  onDelete: () => void
  onSetDefault: () => void
  onSetDefaultModel: (modelId: string | null) => void
  testing: boolean
  settingDefault: boolean
}) {
  const { t } = useTranslation()
  const c = useColors()
  const [expanded, setExpanded] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [hover, setHover] = useState(false)
  const { guard, modalProps } = useRetentionGuard()
  const typeInfo = PROVIDER_TYPES.find((pt) => pt.id === provider.providerType)
  const retention = resolveRetention(provider.providerType, provider.config)

  // Auto-test on access: re-run the provider test each time the card is expanded
  // (every access) so status/models stay fresh without a manual button. The ref
  // keeps the effect independent of onTest's identity (the parent passes a new
  // arrow every render) and prevents re-firing while the card stays open; it
  // resets on collapse so re-expanding tests again.
  const onTestRef = useRef(onTest)
  onTestRef.current = onTest
  const autoTestedRef = useRef(false)
  useEffect(() => {
    if (expanded) {
      if (!autoTestedRef.current) {
        autoTestedRef.current = true
        onTestRef.current()
      }
    } else {
      autoTestedRef.current = false
    }
  }, [expanded])

  const meta = [
    typeInfo?.name || provider.providerType,
    t("providers.modelCount", { count: provider.models.length }),
    provider.defaultModelId || null,
  ]
    .filter(Boolean)
    .join(" · ")

  return (
    <View>
      {/* Header row */}
      <Pressable
        testID="provider-card-header"
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        {...(Platform.OS === "web"
          ? ({ onHoverIn: () => setHover(true), onHoverOut: () => setHover(false) } as any)
          : {})}
        style={[
          {
            flexDirection: "row",
            alignItems: "center",
            gap: 14,
            paddingVertical: 12,
            paddingHorizontal: 16,
            backgroundColor: hover || expanded ? c.nestHover : "transparent",
          },
          Platform.OS === "web"
            ? ({ cursor: "pointer", transition: "background 0.25s" } as any)
            : null,
        ]}
      >
        <ProviderLogo providerType={provider.providerType} color={typeInfo?.color} />
        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <T step="base" ellipsis style={{ flexShrink: 1 }}>
              {provider.displayName}
            </T>
            <StatusBadge status={provider.status} />
            <RetentionBadge info={retention} compact />
            {provider.isDefault && (
              <Badge tone="i" icon="lightning" cap>
                {t("providers.defaultBadge")}
              </Badge>
            )}
          </View>
          <T step="12" tone="text3" ellipsis>
            {meta}
          </T>
        </View>
        <Ph name={expanded ? "caret-up" : "caret-down"} size={14} color={c.text3} />
      </Pressable>

      {/* Expanded Content */}
      {expanded && (
        <View
          style={{
            paddingHorizontal: 16,
            paddingBottom: 16,
            paddingTop: 4,
            gap: 12,
            borderTopWidth: 1,
            borderTopColor: c.border,
          }}
        >
          <View style={{ marginTop: 8 }}>
            <RetentionNotice info={retention} />
          </View>
          {provider.status === "error" && provider.errorMessage && (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                padding: 10,
                paddingHorizontal: 12,
                borderRadius: 10,
                backgroundColor: c.tint.r.bg,
                borderWidth: 1,
                borderColor: c.tint.r.bd,
              }}
            >
              <Ph name="warning-circle" size={14} color={c.tint.r.tx} />
              <T step="12" color={c.tint.r.tx} style={{ flex: 1 }}>
                {provider.errorMessage}
              </T>
            </View>
          )}
          {provider.isDefault && (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                padding: 10,
                paddingHorizontal: 12,
                borderRadius: 10,
                backgroundColor: c.tint.i.bg,
                borderWidth: 1,
                borderColor: c.tint.i.bd,
              }}
            >
              <Ph name="lightning" size={13} color={c.tint.i.tx} />
              <T step="12" color={c.tint.i.tx} style={{ flex: 1 }}>
                {t("providers.defaultDescription")}
              </T>
            </View>
          )}
          {/* Default model selector */}
          {provider.models.length > 0 && (
            <View>
              <FieldLabel>{t("providers.defaultModel")}</FieldLabel>
              <Card nested pad={4}>
                <OptionRow
                  on={!provider.defaultModelId}
                  title={t("providers.noDefaultModel")}
                  onPress={() => onSetDefaultModel(null)}
                />
                {provider.models.map((model) => (
                  <OptionRow
                    key={model.modelId}
                    on={provider.defaultModelId === model.modelId}
                    title={model.modelId}
                    sub={model.modelString !== model.modelId ? model.modelString : undefined}
                    onPress={() =>
                      guard(retention, model.modelId, model.modelId, () =>
                        onSetDefaultModel(model.modelId),
                      )
                    }
                  />
                ))}
              </Card>
            </View>
          )}
          {testing ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Ph name="circle-notch" size={13} color={c.text3} />
              <T step="12" tone="text3">
                {t("providers.testing")}
              </T>
            </View>
          ) : (
            provider.lastTestedAt && (
              <T step="12" tone="text3">
                {t("providers.lastTested", {
                  date: new Date(provider.lastTestedAt).toLocaleString(),
                })}
              </T>
            )
          )}
          {/* Actions */}
          <View
            style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}
          >
            {confirmDelete ? (
              <>
                <Btn variant="ghost" size="sm" onPress={() => setConfirmDelete(false)}>
                  {t("common.cancel")}
                </Btn>
                <Btn variant="danger" size="sm" icon="trash" onPress={onDelete}>
                  {t("providers.confirmDelete")}
                </Btn>
              </>
            ) : (
              <>
                {!provider.isDefault && provider.status === "active" && (
                  <Btn
                    variant="sec"
                    size="sm"
                    icon="lightning"
                    onPress={onSetDefault}
                    disabled={settingDefault}
                    loading={settingDefault}
                  >
                    {t("providers.setAsDefault")}
                  </Btn>
                )}
                <Btn
                  variant="dangerSoft"
                  size="sm"
                  icon="trash"
                  onPress={() => setConfirmDelete(true)}
                >
                  {t("common.delete")}
                </Btn>
              </>
            )}
          </View>
        </View>
      )}
      <RetentionConfirmModal {...modalProps} />
    </View>
  )
}

// ── ProvidersWindowContent ────────────────────────────────────────────────────

export interface ProvidersWindowContentProps {
  windowId: string
}

export function ProvidersWindowContent({ windowId }: ProvidersWindowContentProps) {
  const { t } = useTranslation()
  const c = useColors()
  const client = getTerosClient()

  const [providers, setProviders] = useState<UserProvider[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [adding, setAdding] = useState(false)
  const [completing, setCompleting] = useState(false)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [settingDefaultId, setSettingDefaultId] = useState<string | null>(null)

  // OAuth state (persisted across re-renders, cleared on success/cancel)
  const [oauthState, setOauthState] = useState<OAuthState | null>(null)

  // `silent` refreshes the list without toggling the fullscreen loader, which
  // would otherwise unmount every card and collapse the one the user just opened.
  // Used by the auto-test-on-expand flow so the expanded card refreshes in place.
  const loadProviders = async (opts?: { silent?: boolean }) => {
    try {
      if (!opts?.silent) setLoading(true)
      const result = await client.provider.list()
      setProviders(result.providers)
      setError(null)
    } catch (err) {
      console.error("Failed to load providers:", err)
      setError(err instanceof Error ? err.message : t("errors.providers.loadFailed"))
    } finally {
      if (!opts?.silent) setLoading(false)
    }
  }

  useEffect(() => {
    if (client.isConnected()) {
      loadProviders()
    } else {
      const onConnected = () => {
        loadProviders()
        client.off("connected", onConnected)
      }
      client.on("connected", onConnected)
      return () => {
        client.off("connected", onConnected)
      }
    }
  }, [client])

  const handleAddProvider = async (
    type: string,
    name: string,
    apiKey: string,
    config?: Record<string, any>,
  ) => {
    try {
      setAdding(true)
      const { provider: newProvider } = await client.provider.add({
        providerType: type,
        displayName: name,
        config,
        auth: apiKey ? { apiKey } : undefined,
      })
      setShowAddForm(false)
      // Auto-test to populate models — non-fatal if it fails
      try {
        await client.provider.test(newProvider.providerId)
      } catch (testErr) {
        console.warn("[ProvidersWindowContent] Auto-test failed:", testErr)
      }
      await loadProviders()
    } catch (err) {
      console.error("Failed to add provider:", err)
      setError(err instanceof Error ? err.message : t("errors.providers.addFailed"))
    } finally {
      setAdding(false)
    }
  }

  const handleTestProvider = async (providerId: string) => {
    try {
      setTestingId(providerId)
      await client.provider.test(providerId)
      // Silent refresh: keep the expanded card mounted so it updates in place
      // instead of flashing the fullscreen loader and collapsing.
      await loadProviders({ silent: true })
    } catch (err) {
      console.error("Failed to test provider:", err)
    } finally {
      setTestingId(null)
    }
  }

  const handleDeleteProvider = async (providerId: string) => {
    try {
      await client.provider.delete(providerId)
      await loadProviders()
    } catch (err) {
      console.error("Failed to delete provider:", err)
      setError(err instanceof Error ? err.message : t("errors.providers.deleteFailed"))
    }
  }

  const handleSetDefault = async (providerId: string) => {
    try {
      setSettingDefaultId(providerId)
      await client.provider.update(providerId, { isDefault: true })
      // Optimistic update: reflect immediately in UI
      setProviders((prev) => prev.map((p) => ({ ...p, isDefault: p.providerId === providerId })))
    } catch (err) {
      console.error("Failed to set default provider:", err)
      setError(err instanceof Error ? err.message : t("errors.providers.setDefaultFailed"))
      await loadProviders()
    } finally {
      setSettingDefaultId(null)
    }
  }

  const handleSetDefaultModel = async (providerId: string, modelId: string | null) => {
    try {
      await client.provider.update(providerId, { defaultModelId: modelId ?? null })
      // Optimistic update
      setProviders((prev) =>
        prev.map((p) =>
          p.providerId === providerId ? { ...p, defaultModelId: modelId ?? undefined } : p,
        ),
      )
    } catch (err) {
      console.error("Failed to set default model:", err)
      setError(err instanceof Error ? err.message : t("errors.providers.setDefaultModelFailed"))
      await loadProviders()
    }
  }

  const handleStartOAuth = async (providerType: string) => {
    try {
      setAdding(true)
      const result = await client.provider.startOAuth(providerType)
      setOauthState({
        method: result.method,
        authUrl: result.authUrl,
        verifier: result.verifier,
        userCode: result.userCode,
        interval: result.interval,
      })
    } catch (err) {
      console.error("Failed to start OAuth:", err)
      setError(err instanceof Error ? err.message : t("errors.providers.oauthStartFailed"))
    } finally {
      setAdding(false)
    }
  }

  const handleCompleteOAuth = async (verifier: string, callbackUrl?: string) => {
    try {
      setCompleting(true)
      const { providerId } = await client.provider.completeOAuth(verifier, callbackUrl)
      try {
        await client.provider.test(providerId)
      } catch (testErr) {
        console.warn("[ProvidersWindowContent] Auto-test failed:", testErr)
      }
      setShowAddForm(false)
      setOauthState(null)
      await loadProviders()
    } catch (err) {
      console.error("Failed to complete OAuth:", err)
      setError(err instanceof Error ? err.message : t("errors.providers.oauthCompleteFailed"))
    } finally {
      setCompleting(false)
    }
  }

  const handleCancelForm = () => {
    setShowAddForm(false)
    setOauthState(null)
  }

  if (loading) {
    return <FullscreenLoader variant="default" label={t("common.loading")} />
  }

  return (
    <Page>
      <PageHead
        eyebrow={t("nav.account", { defaultValue: "Account" })}
        title={t("providers.myProviders")}
        lead={t("windows.myProvidersSub")}
        actions={
          !showAddForm ? (
            <Btn variant="primary" icon="plus" onPress={() => setShowAddForm(true)}>
              {t("providers.add")}
            </Btn>
          ) : undefined
        }
      />

      {/* Error */}
      {error && (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            padding: 12,
            paddingHorizontal: 14,
            borderRadius: 10,
            backgroundColor: c.tint.r.bg,
            borderWidth: 1,
            borderColor: c.tint.r.bd,
            marginBottom: 16,
          }}
        >
          <Ph name="warning-circle" size={16} color={c.tint.r.tx} />
          <T step="sm" color={c.tint.r.tx} style={{ flex: 1 }}>
            {error}
          </T>
          <IconBtn
            icon="x"
            plain
            sm
            danger
            onPress={() => setError(null)}
            title={t("common.close")}
          />
        </View>
      )}

      {/* Add Form */}
      {showAddForm && (
        <View style={{ marginBottom: 20 }}>
          <AddProviderForm
            onAdd={handleAddProvider}
            onStartOAuth={handleStartOAuth}
            onCompleteOAuth={handleCompleteOAuth}
            onCancel={handleCancelForm}
            adding={adding}
            completing={completing}
            oauthState={oauthState}
          />
        </View>
      )}

      {/* Providers List */}
      {providers.length > 0 ? (
        <>
          <SectionLabel
            label={t("nav.providers", { defaultValue: "Providers" })}
            count={providers.length}
          />
          <LGroup>
            {providers.map((provider) => (
              <ProviderCard
                key={provider.providerId}
                provider={provider}
                onTest={() => handleTestProvider(provider.providerId)}
                onDelete={() => handleDeleteProvider(provider.providerId)}
                onSetDefault={() => handleSetDefault(provider.providerId)}
                onSetDefaultModel={(modelId) =>
                  handleSetDefaultModel(provider.providerId, modelId ?? null)
                }
                testing={testingId === provider.providerId}
                settingDefault={settingDefaultId === provider.providerId}
              />
            ))}
          </LGroup>
        </>
      ) : (
        !showAddForm && (
          <Card>
            <EmptyState
              icon="key"
              title={t("providers.empty")}
              text={t("windows.myProvidersSub")}
              action={
                <Btn variant="primary" icon="plus" onPress={() => setShowAddForm(true)}>
                  {t("providers.addProvider")}
                </Btn>
              }
            />
          </Card>
        )
      )}
    </Page>
  )
}
