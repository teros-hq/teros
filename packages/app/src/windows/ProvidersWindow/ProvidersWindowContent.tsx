/**
 * Providers Window Content
 *
 * Manage user's LLM providers (API keys):
 * - List connected providers
 * - Add new provider (API key / OAuth)
 * - Auto-test connection (runs on card expand — no manual button)
 * - Delete provider
 *
 * Migrated to the Design System:
 * - Uses `useColors()` for theme-adaptive surface/border/text tokens.
 * - Uses `semanticColors` for brand accents (indigo, green, red).
 * - Uses `c.badges.*` for status badge palettes (ok/err/gray/info).
 * - Uses `isDark` to switch dark-only rgba values to light equivalents.
 * - Uses Tamagui font tokens (`$mono`) for technical identifiers (model IDs).
 */

import {
  AlertCircle,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Key,
  Loader2,
  Plus,
  Trash2,
  X,
  Zap,
} from '@tamagui/lucide-icons';
import React, { useEffect, useRef, useState } from 'react';
import {
  Button,
  ScrollView,
  Separator,
  Text,
  XStack,
  YStack,
} from 'tamagui';
import { getTerosClient } from '../../services/terosClientSingleton';
import { FullscreenLoader } from '../../components/ui';
import { useTranslation } from 'react-i18next';
import { AddProviderForm, PROVIDER_TYPES, type OAuthState } from '../../components/onboarding/AddProviderForm';
import { ProviderIcon } from '../../components/providers/ProviderIcons';
import { resolveRetention } from '@teros/shared';
import {
  RetentionBadge,
  RetentionConfirmModal,
  RetentionNotice,
  useRetentionGuard,
} from '../../components/dataRetention';
import { useColors } from '../../components/mca/primitives/useColors';
import { colors as semanticColors, surface } from '../../components/mca/primitives/colors';

/** Renders the provider's branded icon, or falls back to a generic Key icon. */
function ProviderIconOrKey({ providerType, color }: { providerType: string; color: string }) {
  const icon = <ProviderIcon providerType={providerType} size={20} color={color} />
  // ProviderIcon returns null for unknown types — fall back to Key
  if (!icon) return <Key size={20} color={color} />
  return icon
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

function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const colors = {
    active: { bg: c.badges.ok.bg, text: semanticColors.green },
    error: { bg: c.badges.err.bg, text: semanticColors.red },
    disabled: { bg: c.badges.gray.bg, text: c.badges.gray.text },
  }
  const sc = colors[status as keyof typeof colors] || colors.disabled
  return (
    <XStack paddingHorizontal="$2" paddingVertical="$1" backgroundColor={sc.bg} borderRadius="$2" alignItems="center" gap="$1">
      {status === 'active' && <CheckCircle size={12} color={sc.text} />}
      {status === 'error' && <AlertCircle size={12} color={sc.text} />}
      <Text fontSize="$1" color={sc.text}>{t(`providers.status.${status}`, { defaultValue: status })}</Text>
    </XStack>
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
  const { t } = useTranslation();
  const c = useColors();
  const isDark = c.bgPage === surface.dark.bgPage;
  const [expanded, setExpanded] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
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

  // Theme-adaptive hover/inner background — dark keeps the original rgba, light
  // uses the design system's bgInner/bgCardHover tokens.
  const hoverBg = isDark ? 'rgba(39,39,42,0.3)' : c.bgCardHover;
  const innerBg = isDark ? 'rgba(39,39,42,0.3)' : c.bgInner;
  const innerBgStrong = isDark ? 'rgba(39,39,42,0.5)' : c.bgCardHover;

  return (
    <YStack
      backgroundColor={c.bgCard}
      borderRadius="$3"
      borderWidth={1}
      borderColor={
        provider.isDefault
          ? c.badges.info.border
          : provider.status === 'error'
            ? c.badges.err.border
            : provider.status === 'active'
              ? c.badges.ok.border
              : c.border
      }
      overflow="hidden"
    >
      {/* Header */}
      <XStack
        testID="provider-card-header"
        padding="$3" alignItems="center" gap="$3"
        cursor="pointer"
        hoverStyle={{ backgroundColor: hoverBg }}
        pressStyle={{ opacity: 0.8 }}
        onPress={() => setExpanded(!expanded)}
      >
        <YStack width={40} height={40} borderRadius={8} backgroundColor={`${typeInfo?.color || c.text3}15`} justifyContent="center" alignItems="center">
          <ProviderIconOrKey providerType={provider.providerType} color={typeInfo?.color || c.text3} />
        </YStack>
        <YStack flex={1}>
          <XStack alignItems="center" gap="$2" flexWrap="wrap">
            <Text fontSize="$4" fontWeight="600" color={c.text}>{provider.displayName}</Text>
            <StatusBadge status={provider.status} />
            <RetentionBadge info={retention} compact />
            {provider.isDefault && (
              <XStack paddingHorizontal="$2" paddingVertical="$1" backgroundColor={c.badges.info.bg} borderRadius="$2" alignItems="center" gap="$1">
                <Zap size={10} color={semanticColors.indigo} />
                <Text fontSize="$1" color={semanticColors.indigo} fontWeight="600">{t('providers.defaultBadge')}</Text>
              </XStack>
            )}
          </XStack>
          <Text fontSize="$2" color={c.text2}>
            {typeInfo?.name || provider.providerType} • {t('providers.modelCount', { count: provider.models.length })}
            {provider.defaultModelId ? ` • ${provider.defaultModelId}` : ''}
          </Text>
        </YStack>
        {expanded ? <ChevronUp size={18} color={c.text3} /> : <ChevronDown size={18} color={c.text3} />}
      </XStack>

      {/* Expanded Content */}
      {expanded && (
        <YStack padding="$3" paddingTop={0} gap="$3">
          <Separator backgroundColor={c.border} />
          <RetentionNotice info={retention} />
          {provider.status === 'error' && provider.errorMessage && (
            <XStack backgroundColor={c.badges.err.bg} padding="$2" borderRadius="$2" gap="$2" alignItems="center">
              <AlertCircle size={14} color={semanticColors.red} />
              <Text fontSize="$2" color={semanticColors.red} flex={1}>{provider.errorMessage}</Text>
            </XStack>
          )}
          {provider.isDefault && (
            <XStack backgroundColor={semanticColors.indigoGlow} padding="$2" borderRadius="$2" gap="$2" alignItems="center">
              <Zap size={13} color={semanticColors.indigo} />
              <Text fontSize="$2" color={semanticColors.indigo} flex={1}>
                {t('providers.defaultDescription')}
              </Text>
            </XStack>
          )}
          {/* Default model selector */}
          {provider.models.length > 0 && (
            <YStack gap="$2">
              <Text fontSize="$2" fontWeight="500" color={c.text2}>{t('providers.defaultModel')}</Text>
              <YStack gap="$1">
                <XStack
                  alignItems="center" gap="$2" padding="$2" borderRadius="$2"
                  backgroundColor={!provider.defaultModelId ? c.badges.info.bg : innerBg}
                  borderWidth={1} borderColor={!provider.defaultModelId ? c.badges.info.border : 'transparent'}
                  cursor="pointer" hoverStyle={{ backgroundColor: innerBgStrong }} pressStyle={{ opacity: 0.8 }}
                  onPress={() => onSetDefaultModel(null)}
                >
                  {!provider.defaultModelId
                    ? <CheckCircle size={14} color={semanticColors.indigo} />
                    : <YStack width={14} height={14} borderRadius={7} borderWidth={1} borderColor={c.borderStrong} />}
                  <Text fontSize="$2" color={!provider.defaultModelId ? semanticColors.indigo : c.text2} flex={1} fontStyle="italic">
                    {t('providers.noDefaultModel')}
                  </Text>
                </XStack>
                {provider.models.map((model) => (
                  <XStack
                    key={model.modelId}
                    alignItems="center" gap="$2" padding="$2" borderRadius="$2"
                    backgroundColor={provider.defaultModelId === model.modelId ? c.badges.info.bg : innerBg}
                    borderWidth={1} borderColor={provider.defaultModelId === model.modelId ? c.badges.info.border : 'transparent'}
                    cursor="pointer" hoverStyle={{ backgroundColor: innerBgStrong }} pressStyle={{ opacity: 0.8 }}
                    onPress={() => guard(retention, model.modelId, model.modelId, () => onSetDefaultModel(model.modelId))}
                  >
                    {provider.defaultModelId === model.modelId
                      ? <CheckCircle size={14} color={semanticColors.indigo} />
                      : <YStack width={14} height={14} borderRadius={7} borderWidth={1} borderColor={c.borderStrong} />}
                    <Text fontSize="$2" fontFamily="$mono" color={provider.defaultModelId === model.modelId ? semanticColors.indigo : c.text} flex={1}>
                      {model.modelId}
                    </Text>
                  </XStack>
                ))}
              </YStack>
            </YStack>
          )}
          {testing ? (
            <XStack alignItems="center" gap="$2">
              <Loader2 size={13} color={c.text2} />
              <Text fontSize="$1" color={c.text2}>{t('providers.testing')}</Text>
            </XStack>
          ) : (
            provider.lastTestedAt && (
              <Text fontSize="$1" color={c.text2}>{t('providers.lastTested', { date: new Date(provider.lastTestedAt).toLocaleString() })}</Text>
            )
          )}
          {/* Actions */}
          <XStack gap="$2" justifyContent="flex-end" flexWrap="wrap">
            {confirmDelete ? (
              <>
                <Button size="$2" backgroundColor={c.badges.err.bg} borderColor={c.badges.err.border} borderWidth={1} onPress={onDelete} icon={<Trash2 size={14} color={semanticColors.red} />}>
                  <Text color={semanticColors.red} fontSize="$2">{t('providers.confirmDelete')}</Text>
                </Button>
                <Button size="$2" backgroundColor={innerBgStrong} onPress={() => setConfirmDelete(false)}>
                  <Text color={c.text2} fontSize="$2">{t('common.cancel')}</Text>
                </Button>
              </>
            ) : (
              <>
                {!provider.isDefault && provider.status === 'active' && (
                  <Button size="$2" backgroundColor={c.badges.info.bg} borderColor={c.badges.info.border} borderWidth={1} onPress={onSetDefault} disabled={settingDefault}
                    icon={settingDefault ? <Loader2 size={14} color={semanticColors.indigo} /> : <Zap size={14} color={semanticColors.indigo} />}>
                    <Text color={semanticColors.indigo} fontSize="$2">{t('providers.setAsDefault')}</Text>
                  </Button>
                )}
                <Button size="$2" backgroundColor={c.badges.err.bg} onPress={() => setConfirmDelete(true)} icon={<Trash2 size={14} color={semanticColors.red} />}>
                  <Text color={semanticColors.red} fontSize="$2">{t('common.delete')}</Text>
                </Button>
              </>
            )}
          </XStack>
        </YStack>
      )}
      <RetentionConfirmModal {...modalProps} />
    </YStack>
  )
}

// ── ProvidersWindowContent ────────────────────────────────────────────────────

export interface ProvidersWindowContentProps {
  windowId: string
}

export function ProvidersWindowContent({ windowId }: ProvidersWindowContentProps) {
  const { t } = useTranslation();
  const c = useColors();
  const client = getTerosClient()

  const [providers, setProviders] = useState<UserProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [adding, setAdding] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [settingDefaultId, setSettingDefaultId] = useState<string | null>(null);

  // OAuth state (persisted across re-renders, cleared on success/cancel)
  const [oauthState, setOauthState] = useState<OAuthState | null>(null);

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
      setError(err instanceof Error ? err.message : t('errors.providers.loadFailed'))
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
  }, [client]);

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
      setError(err instanceof Error ? err.message : t('errors.providers.addFailed'))
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
      setError(err instanceof Error ? err.message : t('errors.providers.deleteFailed'))
    }
  }

  const handleSetDefault = async (providerId: string) => {
    try {
      setSettingDefaultId(providerId)
      await client.provider.update(providerId, { isDefault: true })
      // Optimistic update: reflect immediately in UI
      setProviders((prev) =>
        prev.map((p) => ({ ...p, isDefault: p.providerId === providerId })),
      )
    } catch (err) {
      console.error("Failed to set default provider:", err)
      setError(err instanceof Error ? err.message : t('errors.providers.setDefaultFailed'))
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
      setError(err instanceof Error ? err.message : t('errors.providers.setDefaultModelFailed'))
      await loadProviders()
    }
  }

  const handleStartOAuth = async (providerType: string) => {
    try {
      setAdding(true);
      const result = await client.provider.startOAuth(providerType);
      setOauthState({
        method: result.method,
        authUrl: result.authUrl,
        verifier: result.verifier,
        userCode: result.userCode,
        interval: result.interval,
      });
    } catch (err) {
      console.error('Failed to start OAuth:', err);
      setError(err instanceof Error ? err.message : t('errors.providers.oauthStartFailed'));
    } finally {
      setAdding(false)
    }
  }

  const handleCompleteOAuth = async (verifier: string, callbackUrl?: string) => {
    try {
      setCompleting(true);
      const { providerId } = await client.provider.completeOAuth(verifier, callbackUrl);
      try {
        await client.provider.test(providerId)
      } catch (testErr) {
        console.warn('[ProvidersWindowContent] Auto-test failed:', testErr)
      }
      setShowAddForm(false);
      setOauthState(null);
      await loadProviders();
    } catch (err) {
      console.error('Failed to complete OAuth:', err);
      setError(err instanceof Error ? err.message : t('errors.providers.oauthCompleteFailed'));
    } finally {
      setCompleting(false);
    }
  };

  const handleCancelForm = () => {
    setShowAddForm(false);
    setOauthState(null);
  };

  if (loading) {
    return <FullscreenLoader variant="default" label={t('common.loading')} />;
  }

  return (
    <YStack flex={1} backgroundColor={c.bgPage}>
      <ScrollView flex={1}>
        <YStack padding="$4" gap="$4">
          {/* Header */}
          <XStack alignItems="center" justifyContent="space-between">
            <Text fontSize="$6" fontWeight="700" color={c.text}>
              {t('providers.myProviders')}
            </Text>
            {!showAddForm && providers.length > 0 && (
              <Button
                size="$3"
                backgroundColor={c.badges.ok.bg}
                borderColor={c.badges.ok.border}
                borderWidth={1}
                onPress={() => setShowAddForm(true)}
                icon={<Plus size={16} color={semanticColors.green} />}
              >
                <Text color={semanticColors.green}>{t('providers.add')}</Text>
              </Button>
            )}
          </XStack>

          {/* Error */}
          {error && (
            <XStack
              backgroundColor={c.badges.err.bg}
              padding="$3"
              borderRadius="$3"
              gap="$2"
              alignItems="center"
            >
              <AlertCircle size={16} color={semanticColors.red} />
              <Text fontSize="$2" color={semanticColors.red} flex={1}>
                {error}
              </Text>
              <Button
                size="$1"
                backgroundColor="transparent"
                onPress={() => setError(null)}
                icon={<X size={14} color={semanticColors.red} />}
              />
            </XStack>
          )}

          {/* Add Form */}
          {showAddForm && (
            <AddProviderForm
              onAdd={handleAddProvider}
              onStartOAuth={handleStartOAuth}
              onCompleteOAuth={handleCompleteOAuth}
              onCancel={handleCancelForm}
              adding={adding}
              completing={completing}
              oauthState={oauthState}
            />
          )}

          {/* Providers List */}
          {providers.length > 0 ? (
            <YStack gap="$3">
              {providers.map((provider) => (
                <ProviderCard
                  key={provider.providerId}
                  provider={provider}
                  onTest={() => handleTestProvider(provider.providerId)}
                  onDelete={() => handleDeleteProvider(provider.providerId)}
                  onSetDefault={() => handleSetDefault(provider.providerId)}
                  onSetDefaultModel={(modelId) => handleSetDefaultModel(provider.providerId, modelId ?? null)}
                  testing={testingId === provider.providerId}
                  settingDefault={settingDefaultId === provider.providerId}
                />
              ))}
            </YStack>
          ) : (
            !showAddForm && (
              <YStack flex={1} alignItems="center" justifyContent="center" padding="$6">
                <Key size={40} color={c.text3} />
                <Text color={c.text3} marginTop="$3" textAlign="center" fontSize="$3">
                  {t('providers.empty')}
                </Text>
                <Button
                  size="$3"
                  marginTop="$4"
                  backgroundColor={c.badges.ok.bg}
                  borderColor={c.badges.ok.border}
                  borderWidth={1}
                  onPress={() => setShowAddForm(true)}
                  icon={<Plus size={16} color={semanticColors.green} />}
                >
                  <Text color={semanticColors.green}>{t('providers.addProvider')}</Text>
                </Button>
              </YStack>
            )
          )}
        </YStack>
      </ScrollView>
    </YStack>
  )
}
