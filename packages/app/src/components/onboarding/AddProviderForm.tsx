/**
 * AddProviderForm — Standalone extracted component
 *
 * Extracted from ProvidersWindowContent.tsx as a standalone form (its only
 * caller today). It previously also backed the onboarding ProviderStep, which
 * was removed when onboarding moved to Teros-by-default.
 *
 * Includes all sub-components it depends on:
 *   - PROVIDER_TYPES constant
 *   - OAuthState type
 *   - DeviceFlowPanel
 *   - CallbackUrlPanel
 *   - AddProviderForm (default export)
 */

import {
  Check,
  ChevronDown,
  Cloud,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Key,
  Loader2,
  X,
} from '@tamagui/lucide-icons'
import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Linking, Platform } from 'react-native'
import { Button, Input, Text, XStack, YStack } from 'tamagui'
import { colors as semanticColors } from '../mca/primitives/colors'
import { useColors } from '../mca/primitives/useColors'

// ── Helpers ───────────────────────────────────────────────────────────────────

function openUrl(url: string) {
  if (Platform.OS === 'web') {
    window.open(url, '_blank', 'noopener,noreferrer')
  } else {
    Linking.openURL(url)
  }
}

function copyToClipboard(text: string) {
  if (Platform.OS === 'web' && navigator.clipboard) {
    navigator.clipboard.writeText(text)
  }
}

// ── PROVIDER_TYPES ────────────────────────────────────────────────────────────

export const PROVIDER_TYPES = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    description: 'Claude models (Sonnet, Opus, Haiku)',
    color: '#D97706',
    placeholder: 'sk-ant-api03-...',
    authType: 'apiKey' as const,
  },
  {
    id: 'anthropic-oauth',
    name: 'Claude Pro/Max',
    description: 'Use your Claude Pro or Max subscription (OAuth)',
    color: '#D97706',
    placeholder: '',
    authType: 'oauth' as const,
    oauthMethod: 'callback-url' as const,
  },
  {
    id: 'openai-codex-oauth',
    name: 'ChatGPT Pro/Plus (Codex)',
    description: 'Use your ChatGPT Pro or Plus subscription for Codex models',
    color: '#10B981',
    placeholder: '',
    authType: 'oauth' as const,
    oauthMethod: 'device-flow' as const,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    description: 'GPT-4, GPT-5, o3 models',
    color: '#10B981',
    placeholder: 'sk-proj-...',
    authType: 'apiKey' as const,
  },
  {
    id: 'google',
    name: 'Google Gemini',
    description: 'Gemini 2.5 Pro, 2.5 Flash, 2.0 Flash — 1M context',
    color: '#4285F4',
    placeholder: 'AIzaSy...',
    authType: 'apiKey' as const,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    description: 'Access 400+ models with one API key',
    color: '#6366F1',
    placeholder: 'sk-or-v1-...',
    authType: 'apiKey' as const,
  },
  {
    id: 'zhipu',
    name: 'Zhipu AI',
    description: 'GLM-5.2, GLM-5.1, GLM-5, GLM-4.7 and more (general purpose)',
    color: '#EC4899',
    placeholder: 'your-api-key',
    authType: 'apiKey' as const,
  },
  {
    id: 'zhipu-coding',
    name: 'Zhipu AI Coding',
    description: 'GLM-5.2, GLM-5.1, GLM-5, GLM-4.7 via coding API (subscription)',
    color: '#EC4899',
    placeholder: 'your-api-key',
    authType: 'apiKey' as const,
  },
  {
    id: 'ollama',
    name: 'Ollama Local',
    description: 'Local models via Ollama (no API key needed)',
    color: '#F97316',
    placeholder: 'http://localhost:11434',
    authType: 'url' as const,
  },
  {
    id: 'ollama-cloud',
    name: 'Ollama Cloud',
    description: 'Hosted large models by Ollama — qwen3-coder:480b, deepseek-v3.1:671b and more',
    color: '#F97316',
    placeholder: 'sk-ollama-...',
    authType: 'apiKey' as const,
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    description: 'MiniMax M2 models — Token Plan (Anthropic-compatible)',
    color: '#3B82F6',
    placeholder: 'your-minimax-api-key',
    authType: 'apiKey' as const,
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare Workers AI',
    description: 'Your own Cloudflare account — Kimi K2.5 & K2.6 (user secret)',
    color: '#F48120',
    placeholder: 'your-cloudflare-api-token',
    authType: 'apiKey' as const,
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    description: 'Kimi K2.6 via Fireworks AI — Zero Data Retention by default (user secret)',
    color: '#E11D48',
    placeholder: 'fw_...',
    authType: 'apiKey' as const,
  },
  {
    id: 'together',
    name: 'Together AI',
    description: 'Kimi K2.6, DeepSeek V4 Pro, Qwen 3.5 & more open models (user secret)',
    color: '#0F6FFF',
    placeholder: 'tgp_v1_...',
    authType: 'apiKey' as const,
  },
  {
    id: 'teros',
    name: 'Teros',
    description: 'Teros-hosted models — Kimi K2.5 & K2.6 (no API key needed)',
    color: '#22C55E',
    placeholder: '',
    authType: 'none' as const,
  },
  {
    id: 'openai-compatible',
    name: 'Custom (OpenAI-compatible)',
    description: 'Any OpenAI-compatible endpoint: Tower, LM Studio, vLLM, etc.',
    color: '#14B8A6',
    placeholder: 'https://your-server.com',
    authType: 'openai-compatible' as const,
  },
]

// ── OAuthState ────────────────────────────────────────────────────────────────

export interface OAuthState {
  method: 'callback-url' | 'device-flow'
  authUrl: string
  verifier: string
  userCode?: string
  interval?: number
}

// ── DeviceFlowPanel ───────────────────────────────────────────────────────────

function DeviceFlowPanel({
  oauthState,
  onComplete,
  onCancel,
  completing,
}: {
  oauthState: OAuthState
  onComplete: () => void
  onCancel: () => void
  completing: boolean
}) {
  const { t } = useTranslation()
  const c = useColors()
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    if (oauthState.userCode) {
      copyToClipboard(oauthState.userCode)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <YStack gap="$4">
      <YStack gap="$2">
        <Text fontSize="$3" fontWeight="600" color={c.text}>{t('onboarding.connectChatGPT')}</Text>
        <Text fontSize="$2" color={c.text2}>
          {t('onboarding.followStepsToAuth')}
        </Text>
      </YStack>

      {/* Step 1: Code */}
      <YStack
        backgroundColor={`${semanticColors.green}14`}
        borderRadius="$3"
        borderWidth={1}
        borderColor={`${semanticColors.green}33`}
        padding="$3"
        gap="$2"
      >
        <XStack alignItems="center" gap="$2">
          <YStack
            width={20} height={20} borderRadius={10}
            backgroundColor={`${semanticColors.green}33`}
            justifyContent="center" alignItems="center"
          >
            <Text fontSize="$1" color={semanticColors.green} fontWeight="700">1</Text>
          </YStack>
          <Text fontSize="$2" fontWeight="500" color={c.text}>{t('onboarding.yourAuthCode')}</Text>
        </XStack>
        <XStack alignItems="center" gap="$3" justifyContent="center" paddingVertical="$2">
          <Text fontSize={28} fontWeight="700" color={semanticColors.green} fontFamily="$mono" letterSpacing={4}>
            {oauthState.userCode}
          </Text>
          <Button
            size="$2"
            backgroundColor={`${semanticColors.green}1A`}
            borderColor={`${semanticColors.green}4D`}
            borderWidth={1}
            onPress={handleCopy}
            icon={copied ? <Check size={14} color={semanticColors.green} /> : <Copy size={14} color={semanticColors.green} />}
          >
            <Text fontSize="$1" color={semanticColors.green}>{copied ? t('common.copied') : t('common.copy')}</Text>
          </Button>
        </XStack>
      </YStack>

      {/* Step 2: Open URL */}
      <YStack
        backgroundColor={c.bgInner}
        borderRadius="$3" borderWidth={1} borderColor={c.border}
        padding="$3" gap="$2"
      >
        <XStack alignItems="center" gap="$2">
          <YStack
            width={20} height={20} borderRadius={10}
            backgroundColor={c.borderStrong}
            justifyContent="center" alignItems="center"
          >
            <Text fontSize="$1" color={c.text2} fontWeight="700">2</Text>
          </YStack>
          <Text fontSize="$2" fontWeight="500" color={c.text}>{t('onboarding.openAuthPage')}</Text>
        </XStack>
        <Button
          size="$3"
          backgroundColor={`${semanticColors.green}1F`}
          borderColor={`${semanticColors.green}4D`}
          borderWidth={1}
          onPress={() => openUrl(oauthState.authUrl)}
          icon={<ExternalLink size={15} color={semanticColors.green} />}
        >
          <Text color={semanticColors.green} fontSize="$2">{t('onboarding.openAuthOpenAI')}</Text>
        </Button>
        <Text fontSize="$1" color={c.text2} textAlign="center">{t('onboarding.enterCodeWhenPrompted')}</Text>
      </YStack>

      {/* Step 3: Confirm */}
      <YStack
        backgroundColor={c.bgInner}
        borderRadius="$3" borderWidth={1} borderColor={c.border}
        padding="$3" gap="$2"
      >
        <XStack alignItems="center" gap="$2">
          <YStack
            width={20} height={20} borderRadius={10}
            backgroundColor={c.borderStrong}
            justifyContent="center" alignItems="center"
          >
            <Text fontSize="$1" color={c.text2} fontWeight="700">3</Text>
          </YStack>
          <Text fontSize="$2" fontWeight="500" color={c.text}>{t('onboarding.afterApprovingClickBelow')}</Text>
        </XStack>
        <Button
          size="$3"
          backgroundColor={`${semanticColors.green}26`}
          borderColor={`${semanticColors.green}4D`}
          borderWidth={1}
          onPress={onComplete}
          disabled={completing}
          icon={completing ? <Loader2 size={16} color={semanticColors.green} /> : <Check size={16} color={semanticColors.green} />}
        >
          <Text color={semanticColors.green}>{completing ? t('onboarding.connecting') : t('onboarding.iveApprovedConnect')}</Text>
        </Button>
      </YStack>

      <XStack justifyContent="center">
        <Button size="$2" backgroundColor="transparent" onPress={onCancel} disabled={completing}>
          <Text color={c.text2} fontSize="$2">{t('common.cancel')}</Text>
        </Button>
      </XStack>
    </YStack>
  )
}

// ── CallbackUrlPanel ──────────────────────────────────────────────────────────

function CallbackUrlPanel({
  oauthState,
  onComplete,
  onCancel,
  completing,
}: {
  oauthState: OAuthState
  onComplete: (callbackUrl: string) => void
  onCancel: () => void
  completing: boolean
}) {
  const { t } = useTranslation()
  const c = useColors()
  const [callbackUrl, setCallbackUrl] = useState('')

  return (
    <YStack gap="$3">
      <Text fontSize="$2" color={c.text2}>{t('onboarding.connectClaudeOAuth')}</Text>

      <Button
        size="$3"
        backgroundColor={`${semanticColors.amber}26`}
        borderColor={`${semanticColors.amber}4D`}
        borderWidth={1}
        onPress={() => openUrl(oauthState.authUrl)}
        icon={<ExternalLink size={15} color={semanticColors.amber} />}
      >
        <Text color={semanticColors.amber}>{t('onboarding.openClaudeAuthPage')}</Text>
      </Button>

      <Text fontSize="$2" color={c.text2}>
        {t('onboarding.pasteCallbackUrl')}
      </Text>

      <Input
        size="$3"
        backgroundColor={c.bgInner}
        borderColor={c.borderStrong}
        placeholder={t('onboarding.providerStep.callbackPlaceholder')}
        value={callbackUrl}
        onChangeText={setCallbackUrl}
        fontFamily="$mono"
        fontSize="$2"
        autoCapitalize="none"
      />

      <XStack gap="$2" justifyContent="flex-end">
        <Button
          size="$3"
          backgroundColor={c.bgInner}
          onPress={onCancel}
          disabled={completing}
        >
          <Text color={c.text2}>{t('common.cancel')}</Text>
        </Button>
        <Button
          size="$3"
          backgroundColor={`${semanticColors.green}26`}
          borderColor={`${semanticColors.green}4D`}
          borderWidth={1}
          onPress={() => callbackUrl && onComplete(callbackUrl)}
          disabled={!callbackUrl || completing}
          icon={completing ? <Loader2 size={16} color={semanticColors.green} /> : <Check size={16} color={semanticColors.green} />}
        >
          <Text color={semanticColors.green}>{completing ? t('onboarding.connecting') : t('onboarding.connect')}</Text>
        </Button>
      </XStack>
    </YStack>
  )
}

// ── AddProviderForm ───────────────────────────────────────────────────────────

export interface AddProviderFormProps {
  onAdd: (type: string, name: string, apiKey: string, config?: Record<string, any>) => void
  onStartOAuth: (type: string) => void
  onCompleteOAuth: (verifier: string, callbackUrl?: string) => void
  onCancel: () => void
  adding: boolean
  completing: boolean
  oauthState: OAuthState | null
  /** If true, renders without the outer card border (for embedding in wizard) */
  embedded?: boolean
  /** Error message to display inline below the form */
  error?: string | null
}

export function AddProviderForm({
  onAdd,
  onStartOAuth,
  onCompleteOAuth,
  onCancel,
  adding,
  completing,
  oauthState,
  embedded = false,
  error,
}: AddProviderFormProps) {
  const { t } = useTranslation()
  const c = useColors()
  const [selectedType, setSelectedType] = useState<string | null>(null)
  const [displayName, setDisplayName] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [customModel, setCustomModel] = useState('')
  const [customEndpointModel, setCustomEndpointModel] = useState('')
  const [customHeaders, setCustomHeaders] = useState<{ key: string; value: string }[]>([])
  const [accountId, setAccountId] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)

  const typeInfo = PROVIDER_TYPES.find((t) => t.id === selectedType)
  const isOAuth = typeInfo?.authType === 'oauth'
  const isUrl = typeInfo?.authType === 'url'
  const isOpenAICompatible = typeInfo?.authType === 'openai-compatible'
  const isNone = typeInfo?.authType === 'none'

  const handleSubmit = () => {
    if (!selectedType) return
    if (isNone && displayName) {
      onAdd(selectedType, displayName, '')
    } else if (isUrl && displayName && baseUrl) {
      onAdd(selectedType, displayName, '', { baseUrl })
    } else if (isOpenAICompatible && displayName && baseUrl) {
      const headers = customHeaders.reduce<Record<string, string>>((acc, h) => {
        if (h.key.trim() && h.value.trim()) acc[h.key.trim()] = h.value.trim()
        return acc
      }, {})
      const pinnedModel = customEndpointModel.trim()
      onAdd(selectedType, displayName, apiKey || '', {
        baseUrl: baseUrl.trim(),
        // Model is optional — backend auto-discovers from /v1/models. When
        // pinned, it overrides discovery (for endpoints that don't expose /models).
        ...(pinnedModel ? { model: pinnedModel } : {}),
        ...(Object.keys(headers).length ? { customHeaders: headers } : {}),
      })
    } else if (displayName && apiKey) {
      let config: Record<string, any> | undefined
      if ((selectedType === 'openrouter' || selectedType === 'ollama-cloud') && customModel.trim()) {
        config = { customModel: customModel.trim() }
      }
      if (selectedType === 'cloudflare' && accountId.trim()) {
        config = { ...(config || {}), accountId: accountId.trim() }
      }
      onAdd(selectedType, displayName, apiKey, config)
    }
  }

  const containerProps = embedded
    ? {}
    : {
        backgroundColor: c.bgCard,
        borderRadius: '$4' as const,
        borderWidth: 1,
        borderColor: `${semanticColors.green}4D`,
        padding: '$4' as const,
      }

  return (
    <YStack gap="$4" {...containerProps}>
      {!embedded && (
        <XStack alignItems="center" justifyContent="space-between">
          <Text fontSize="$5" fontWeight="600" color={c.text}>{t('onboarding.addProvider.title')}</Text>
          <Button
            size="$2"
            circular
            backgroundColor="transparent"
            onPress={onCancel}
            icon={<X size={18} color={c.text2} />}
          />
        </XStack>
      )}

      {/* Inline error */}
      {error && (
        <XStack
          backgroundColor={`${semanticColors.red}1A`}
          padding="$2"
          borderRadius="$2"
          gap="$2"
          alignItems="center"
        >
          <Text fontSize="$2" color={semanticColors.red} flex={1}>{error}</Text>
        </XStack>
      )}

      {/* Provider Type Selection */}
      {!selectedType ? (
        <YStack gap="$2">
          <Text fontSize="$2" color={c.text2}>{t('onboarding.selectProviderType')}</Text>
          {PROVIDER_TYPES.map((type) => (
            <XStack
              key={type.id}
              padding="$3"
              backgroundColor={c.bgInner}
              borderRadius="$3"
              borderWidth={1}
              borderColor={c.border}
              alignItems="center"
              gap="$3"
              cursor="pointer"
              hoverStyle={{ backgroundColor: c.bgCardHover }}
              pressStyle={{ opacity: 0.8 }}
              onPress={() => {
                setSelectedType(type.id)
                setDisplayName(type.name)
              }}
            >
              <YStack
                width={36} height={36} borderRadius={8}
                backgroundColor={`${type.color}15`}
                justifyContent="center" alignItems="center"
              >
                <Cloud size={18} color={type.color} />
              </YStack>
              <YStack flex={1}>
                <Text fontSize="$3" fontWeight="500" color={c.text}>{type.name}</Text>
                <Text fontSize="$2" color={c.text2}>{type.description}</Text>
              </YStack>
              {type.authType === 'oauth' && (
                <Text fontSize="$1" color={c.text2} opacity={0.7}>OAuth</Text>
              )}
            </XStack>
          ))}
        </YStack>
      ) : (
        <YStack gap="$3">
          {/* Selected type indicator */}
          <XStack alignItems="center" gap="$2">
            <YStack
              width={24} height={24} borderRadius={6}
              backgroundColor={`${typeInfo?.color}15`}
              justifyContent="center" alignItems="center"
            >
              <Cloud size={14} color={typeInfo?.color} />
            </YStack>
            <Text fontSize="$3" color={c.text}>{typeInfo?.name}</Text>
            {!oauthState && (
              <Button size="$1" backgroundColor="transparent" onPress={() => setSelectedType(null)}>
                <Text fontSize="$1" color={semanticColors.indigo}>{t('onboarding.change')}</Text>
              </Button>
            )}
          </XStack>

          {isOAuth ? (
            oauthState ? (
              oauthState.method === 'device-flow' ? (
                <DeviceFlowPanel
                  oauthState={oauthState}
                  onComplete={() => onCompleteOAuth(oauthState.verifier)}
                  onCancel={onCancel}
                  completing={completing}
                />
              ) : (
                <CallbackUrlPanel
                  oauthState={oauthState}
                  onComplete={(url) => onCompleteOAuth(oauthState.verifier, url)}
                  onCancel={onCancel}
                  completing={completing}
                />
              )
            ) : (
              <YStack gap="$3">
                <Text fontSize="$2" color={c.text2}>
                  {typeInfo?.id === 'openai-codex-oauth'
                    ? t('onboarding.connectChatGPTOAuth')
                    : t('onboarding.connectClaudeOAuth')}
                </Text>
                <XStack gap="$2" justifyContent="flex-end">
                  <Button
                    size="$3"
                    backgroundColor={c.bgInner}
                    onPress={onCancel}
                    disabled={adding}
                  >
                    <Text color={c.text2}>{t('common.cancel')}</Text>
                  </Button>
                  <Button
                    size="$3"
                    backgroundColor={`${typeInfo?.color}20`}
                    borderColor={`${typeInfo?.color}40`}
                    borderWidth={1}
                    onPress={() => selectedType && onStartOAuth(selectedType)}
                    disabled={adding}
                    icon={
                      adding
                        ? <Loader2 size={16} color={typeInfo?.color} />
                        : <Key size={16} color={typeInfo?.color} />
                    }
                  >
                    <Text color={typeInfo?.color}>
                      {adding ? t('onboarding.starting') : t('onboarding.connectWithOAuth')}
                    </Text>
                  </Button>
                </XStack>
              </YStack>
            )
          ) : (
            <>
              {/* Display Name */}
              <YStack gap="$1">
                <Text fontSize="$2" color={c.text2}>{t('onboarding.displayName')}</Text>
                <Input
                  size="$3"
                  backgroundColor={c.bgInner}
                  borderColor={c.borderStrong}
                  placeholder={isUrl ? t('onboarding.displayNamePlaceholderUrl') : t('onboarding.displayNamePlaceholderDefault')}
                  value={displayName}
                  onChangeText={setDisplayName}
                />
              </YStack>

              {isNone ? (
                <YStack
                  backgroundColor={`${semanticColors.green}14`}
                  borderRadius="$3"
                  borderWidth={1}
                  borderColor={`${semanticColors.green}33`}
                  padding="$3"
                  gap="$2"
                >
                  <Text fontSize="$2" color={semanticColors.green} fontWeight="600">{t('onboarding.noConfigNeeded')}</Text>
                  <Text fontSize="$2" color={c.text2}>
                    {t('onboarding.noConfigNeededDescription')}
                  </Text>
                  <Text fontSize="$2" color={c.text2}>
                    {t('onboarding.noConfigNeededModels')}
                  </Text>
                </YStack>
              ) : isOpenAICompatible ? (
                <>
                  <YStack gap="$1">
                    <Text fontSize="$2" color={c.text2}>{t('onboarding.endpointUrl')}</Text>
                    <Input
                      size="$3"
                      backgroundColor={c.bgInner}
                      borderColor={c.borderStrong}
                      placeholder={t('onboarding.addProvider.urlPlaceholder')}
                      value={baseUrl}
                      onChangeText={setBaseUrl}
                      fontFamily="$mono"
                      autoCapitalize="none"
                    />
                  </YStack>

                  <YStack gap="$1">
                    <XStack alignItems="center" gap="$2">
                      <Text fontSize="$2" color={c.text2}>{t('onboarding.model')}</Text>
                      <Text fontSize="$1" color={c.text3}>({t('common.optional')})</Text>
                    </XStack>
                    <Input
                      size="$3"
                      backgroundColor={c.bgInner}
                      borderColor={c.borderStrong}
                      placeholder={t('onboarding.autoDiscoverPlaceholder')}
                      value={customEndpointModel}
                      onChangeText={setCustomEndpointModel}
                      fontFamily="$mono"
                      autoCapitalize="none"
                    />
                    <Text fontSize="$1" color={c.text3}>
                      {t('onboarding.leaveEmptyAutoDiscover')}
                    </Text>
                  </YStack>

                  <YStack gap="$1">
                    <XStack alignItems="center" gap="$2">
                      <Text fontSize="$2" color={c.text2}>{t('onboarding.apiKey')}</Text>
                      <Text fontSize="$1" color={c.text3}>({t('common.optional')})</Text>
                    </XStack>
                    <XStack gap="$2">
                      <Input
                        flex={1}
                        size="$3"
                        backgroundColor={c.bgInner}
                        borderColor={c.borderStrong}
                        placeholder={t('onboarding.addProvider.apiKeyPlaceholder')}
                        value={apiKey}
                        onChangeText={setApiKey}
                        secureTextEntry={!showApiKey}
                        fontFamily="$mono"
                      />
                      <Button
                        size="$3"
                        backgroundColor={c.bgInner}
                        onPress={() => setShowApiKey(!showApiKey)}
                        icon={showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
                      />
                    </XStack>
                  </YStack>

                  <YStack gap="$2">
                    <XStack alignItems="center" justifyContent="space-between">
                      <XStack alignItems="center" gap="$2">
                        <Text fontSize="$2" color={c.text2}>{t('onboarding.customHeaders')}</Text>
                        <Text fontSize="$1" color={c.text3}>({t('common.optional')})</Text>
                      </XStack>
                      <Button
                        size="$1"
                        backgroundColor="transparent"
                        onPress={() => setCustomHeaders([...customHeaders, { key: '', value: '' }])}
                      >
                        <Text fontSize="$1" color={semanticColors.indigo}>+ Add</Text>
                      </Button>
                    </XStack>
                    {customHeaders.map((header, i) => (
                      <XStack key={i} gap="$2" alignItems="center">
                        <Input
                          flex={1}
                          size="$2"
                          backgroundColor={c.bgInner}
                          borderColor={c.borderStrong}
                          placeholder={t('onboarding.addProvider.clientIdPlaceholder')}
                          value={header.key}
                          onChangeText={(v) => {
                            const updated = [...customHeaders]
                            updated[i] = { ...updated[i], key: v }
                            setCustomHeaders(updated)
                          }}
                          fontFamily="$mono"
                          fontSize="$1"
                          autoCapitalize="none"
                        />
                        <Input
                          flex={1}
                          size="$2"
                          backgroundColor={c.bgInner}
                          borderColor={c.borderStrong}
                          placeholder={t('onboarding.addProvider.valuePlaceholder')}
                          value={header.value}
                          onChangeText={(v) => {
                            const updated = [...customHeaders]
                            updated[i] = { ...updated[i], value: v }
                            setCustomHeaders(updated)
                          }}
                          fontFamily="$mono"
                          fontSize="$1"
                          autoCapitalize="none"
                        />
                        <Button
                          size="$2"
                          circular
                          backgroundColor="transparent"
                          onPress={() => setCustomHeaders(customHeaders.filter((_, j) => j !== i))}
                          icon={<X size={12} color={c.text3} />}
                        />
                      </XStack>
                    ))}
                    {customHeaders.length === 0 && (
                      <Text fontSize="$1" color={c.text3}>
                        {t('onboarding.useForCloudflareAccess')}
                      </Text>
                    )}
                  </YStack>
                </>
              ) : isUrl ? (
                <YStack gap="$1">
                  <Text fontSize="$2" color={c.text2}>{t('onboarding.serverUrl')}</Text>
                  <Input
                    size="$3"
                    backgroundColor={c.bgInner}
                    borderColor={c.borderStrong}
                    placeholder={typeInfo?.placeholder}
                    value={baseUrl}
                    onChangeText={setBaseUrl}
                    fontFamily="$mono"
                    autoCapitalize="none"
                  />
                  <Text fontSize="$1" color={c.text3}>
                    {t('onboarding.ollamaAutoDiscover')}
                  </Text>
                </YStack>
              ) : (
                <YStack gap="$1">
                  <Text fontSize="$2" color={c.text2}>{t('onboarding.apiKey')}</Text>
                  <XStack gap="$2">
                    <Input
                      flex={1}
                      size="$3"
                      backgroundColor={c.bgInner}
                      borderColor={c.borderStrong}
                      placeholder={typeInfo?.placeholder}
                      value={apiKey}
                      onChangeText={setApiKey}
                      secureTextEntry={!showApiKey}
                      fontFamily="$mono"
                    />
                    <Button
                      size="$3"
                      backgroundColor={c.bgInner}
                      onPress={() => setShowApiKey(!showApiKey)}
                      icon={showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
                    />
                  </XStack>
                  <Text fontSize="$1" color={c.text3}>
                    {t('onboarding.apiKeyEncrypted')}
                  </Text>
                  {selectedType === 'cloudflare' && (
                    <YStack gap="$1" marginTop="$2">
                      <Text fontSize="$2" color={c.text2}>{t('onboarding.accountId')}</Text>
                      <Input
                        size="$3"
                        backgroundColor={c.bgInner}
                        borderColor={c.borderStrong}
                        placeholder={t('onboarding.addProvider.examplePlaceholder')}
                        value={accountId}
                        onChangeText={setAccountId}
                        fontFamily="$mono"
                        autoCapitalize="none"
                      />
                      <Text fontSize="$1" color={c.text3}>
                        {t('onboarding.accountIdHint')}
                      </Text>
                    </YStack>
                  )}
                </YStack>
              )}

              {(selectedType === 'openrouter' || selectedType === 'ollama-cloud' || selectedType === 'ollama') && (
                <YStack gap="$1">
                  <XStack alignItems="center" gap="$2">
                    <Text fontSize="$2" color={c.text2}>{t('onboarding.customModel')}</Text>
                    <Text fontSize="$1" color={c.text3}>({t('common.optional')})</Text>
                  </XStack>
                  <Input
                    size="$3"
                    backgroundColor={c.bgInner}
                    borderColor={c.borderStrong}
                    placeholder={
                      selectedType === 'openrouter' ? 'openrouter/free' :
                      selectedType === 'ollama-cloud' ? 'qwen3-coder:480b' :
                      'llama3.2:latest'
                    }
                    value={customModel}
                    onChangeText={setCustomModel}
                    fontFamily="$mono"
                    autoCapitalize="none"
                  />
                  <Text fontSize="$1" color={c.text3}>
                    {selectedType === 'openrouter'
                      ? t('onboarding.openrouterModelHint')
                      : selectedType === 'ollama-cloud'
                      ? t('onboarding.ollamaCloudModelHint')
                      : t('onboarding.ollamaLocalModelHint')}
                  </Text>
                </YStack>
              )}

              <XStack gap="$2" justifyContent="flex-end">
                <Button
                  size="$3"
                  backgroundColor={c.bgInner}
                  onPress={onCancel}
                  disabled={adding}
                >
                  <Text color={c.text2}>{t('common.cancel')}</Text>
                </Button>
                <Button
                  size="$3"
                  backgroundColor={`${semanticColors.green}26`}
                  borderColor={`${semanticColors.green}4D`}
                  borderWidth={1}
                  onPress={handleSubmit}
                  disabled={
                    !displayName ||
                    (!isNone && (isOpenAICompatible ? !baseUrl : isUrl ? !baseUrl : !apiKey)) ||
                    (selectedType === 'cloudflare' && !accountId) ||
                    adding
                  }
                  icon={
                    adding
                      ? <Loader2 size={16} color={semanticColors.green} />
                      : <Check size={16} color={semanticColors.green} />
                  }
                >
                  <Text color={semanticColors.green}>{adding ? t('onboarding.adding') : t('onboarding.addProvider.title')}</Text>
                </Button>
              </XStack>
            </>
          )}
        </YStack>
      )}
    </YStack>
  )
}
