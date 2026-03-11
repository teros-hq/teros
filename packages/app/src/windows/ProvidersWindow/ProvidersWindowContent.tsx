/**
 * Providers Window Content
 *
 * Manage user's LLM providers (API keys):
 * - List connected providers
 * - Add new provider (API key / OAuth)
 * - Test connection
 * - Delete provider
 */

import {
  AlertCircle,
  Check,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Cloud,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Key,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  X,
  Zap,
} from '@tamagui/lucide-icons';
import React, { useEffect, useRef, useState } from 'react';
import {
  Button,
  Input,
  ScrollView,
  Separator,
  Text,
  XStack,
  YStack,
} from 'tamagui';
import { Linking, Platform } from 'react-native';
import { getTerosClient } from '../../../app/_layout';
import { AppSpinner, FullscreenLoader } from '../../components/ui';

interface UserProvider {
  providerId: string
  providerType: string
  displayName: string
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
  priority: number
  status: "active" | "error" | "disabled"
  lastTestedAt?: string
  errorMessage?: string
  createdAt: string
}

const PROVIDER_TYPES = [
  {
    id: "anthropic",
    name: "Anthropic",
    description: "Claude models (Sonnet, Opus, Haiku)",
    color: "#D97706",
    placeholder: "sk-ant-api03-...",
    authType: "apiKey" as const,
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
    id: "openai",
    name: "OpenAI",
    description: "GPT-4, GPT-5, o3 models",
    color: "#10B981",
    placeholder: "sk-proj-...",
    authType: "apiKey" as const,
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    description: "Access 400+ models with one API key",
    color: "#6366F1",
    placeholder: "sk-or-v1-...",
    authType: "apiKey" as const,
  },
  {
    id: "zhipu",
    name: "Zhipu AI",
    description: "GLM-4 models (general purpose)",
    color: "#EC4899",
    placeholder: "your-api-key",
    authType: "apiKey" as const,
  },
  {
    id: "zhipu-coding",
    name: "Zhipu AI Coding",
    description: "GLM-4 models optimized for coding",
    color: "#EC4899",
    placeholder: "your-api-key",
    authType: "apiKey" as const,
  },
  {
    id: "ollama",
    name: "Ollama",
    description: "Local models via Ollama (no API key needed)",
    color: "#F97316",
    placeholder: "http://localhost:11434",
    authType: "url" as const,
  },
]

// ── Helpers ──────────────────────────────────────────────────────────────────

function openUrl(url: string) {
  if (Platform.OS === 'web') {
    window.open(url, '_blank', 'noopener,noreferrer');
  } else {
    Linking.openURL(url);
  }
}

function copyToClipboard(text: string) {
  if (Platform.OS === 'web' && navigator.clipboard) {
    navigator.clipboard.writeText(text);
  }
}

// ── StatusBadge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const colors = {
    active: { bg: "rgba(34, 197, 94, 0.15)", text: "#22C55E", label: "Active" },
    error: { bg: "rgba(239, 68, 68, 0.15)", text: "#EF4444", label: "Error" },
    disabled: { bg: "rgba(113, 113, 122, 0.15)", text: "#71717A", label: "Disabled" },
  }
  const c = colors[status as keyof typeof colors] || colors.disabled

  return (
    <XStack
      paddingHorizontal="$2"
      paddingVertical="$1"
      backgroundColor={c.bg}
      borderRadius="$2"
      alignItems="center"
      gap="$1"
    >
      {status === "active" && <CheckCircle size={12} color={c.text} />}
      {status === "error" && <AlertCircle size={12} color={c.text} />}
      <Text fontSize="$1" color={c.text}>
        {c.label}
      </Text>
    </XStack>
  )
}

// ── ProviderCard ─────────────────────────────────────────────────────────────

function ProviderCard({
  provider,
  onTest,
  onDelete,
  testing,
}: {
  provider: UserProvider
  onTest: () => void
  onDelete: () => void
  testing: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const typeInfo = PROVIDER_TYPES.find((t) => t.id === provider.providerType)

  return (
    <YStack
      backgroundColor="rgba(20, 20, 22, 0.9)"
      borderRadius="$3"
      borderWidth={1}
      borderColor={
        provider.status === "error"
          ? "rgba(239, 68, 68, 0.3)"
          : provider.status === "active"
            ? "rgba(34, 197, 94, 0.2)"
            : "rgba(39, 39, 42, 0.5)"
      }
      overflow="hidden"
    >
      {/* Header */}
      <XStack
        padding="$3"
        alignItems="center"
        gap="$3"
        cursor="pointer"
        hoverStyle={{ backgroundColor: "rgba(39, 39, 42, 0.3)" }}
        pressStyle={{ opacity: 0.8 }}
        onPress={() => setExpanded(!expanded)}
      >
        <YStack
          width={40}
          height={40}
          borderRadius={8}
          backgroundColor={`${typeInfo?.color || "#71717A"}15`}
          justifyContent="center"
          alignItems="center"
        >
          <Key size={20} color={typeInfo?.color || "#71717A"} />
        </YStack>

        <YStack flex={1}>
          <XStack alignItems="center" gap="$2">
            <Text fontSize="$4" fontWeight="600" color="$color">
              {provider.displayName}
            </Text>
            <StatusBadge status={provider.status} />
          </XStack>
          <Text fontSize="$2" color="$gray11">
            {typeInfo?.name || provider.providerType} • {provider.models.length} models
          </Text>
        </YStack>

        {expanded ? (
          <ChevronUp size={18} color="#71717A" />
        ) : (
          <ChevronDown size={18} color="#71717A" />
        )}
      </XStack>

      {/* Expanded Content */}
      {expanded && (
        <YStack padding="$3" paddingTop={0} gap="$3">
          <Separator backgroundColor="rgba(39, 39, 42, 0.5)" />

          {/* Error message */}
          {provider.status === "error" && provider.errorMessage && (
            <XStack
              backgroundColor="rgba(239, 68, 68, 0.1)"
              padding="$2"
              borderRadius="$2"
              gap="$2"
              alignItems="center"
            >
              <AlertCircle size={14} color="#EF4444" />
              <Text fontSize="$2" color="#EF4444" flex={1}>
                {provider.errorMessage}
              </Text>
            </XStack>
          )}

          {/* Default model */}
          {provider.defaultModelId && (
            <XStack alignItems="center" gap="$2">
              <Text fontSize="$2" fontWeight="500" color="$gray11">
                Default model:
              </Text>
              <Text fontSize="$2" color="$color">
                {provider.defaultModelId}
              </Text>
            </XStack>
          )}

          {/* Models */}
          {provider.models.length > 0 && (
            <YStack gap="$2">
              <Text fontSize="$2" fontWeight="500" color="$gray11">
                Available Models
              </Text>
              <YStack gap="$1">
                {provider.models.slice(0, 5).map((model) => (
                  <XStack key={model.modelId} alignItems="center" gap="$2">
                    <Zap size={12} color="#22C55E" />
                    <Text fontSize="$2" color="$color">
                      {model.modelId}
                    </Text>
                  </XStack>
                ))}
                {provider.models.length > 5 && (
                  <Text fontSize="$2" color="$gray10">
                    +{provider.models.length - 5} more
                  </Text>
                )}
              </YStack>
            </YStack>
          )}

          {/* Last tested */}
          {provider.lastTestedAt && (
            <Text fontSize="$1" color="$gray10">
              Last tested: {new Date(provider.lastTestedAt).toLocaleString()}
            </Text>
          )}

          {/* Actions */}
          <XStack gap="$2" justifyContent="flex-end">
            {confirmDelete ? (
              <>
                <Button
                  size="$2"
                  backgroundColor="rgba(239, 68, 68, 0.15)"
                  borderColor="rgba(239, 68, 68, 0.3)"
                  borderWidth={1}
                  onPress={onDelete}
                  icon={<Trash2 size={14} color="#EF4444" />}
                >
                  <Text color="#EF4444" fontSize="$2">
                    Confirm Delete
                  </Text>
                </Button>
                <Button
                  size="$2"
                  backgroundColor="rgba(39, 39, 42, 0.5)"
                  onPress={() => setConfirmDelete(false)}
                >
                  <Text color="$gray11" fontSize="$2">
                    Cancel
                  </Text>
                </Button>
              </>
            ) : (
              <>
                <Button
                  size="$2"
                  backgroundColor="rgba(39, 39, 42, 0.5)"
                  onPress={onTest}
                  disabled={testing}
                  icon={
                    testing ? (
                      <Loader2 size={14} color="$gray11" />
                    ) : (
                      <RefreshCw size={14} color="$gray11" />
                    )
                  }
                >
                  <Text color="$gray11" fontSize="$2">
                    {testing ? "Testing..." : "Test Connection"}
                  </Text>
                </Button>
                <Button
                  size="$2"
                  backgroundColor="rgba(239, 68, 68, 0.1)"
                  onPress={() => setConfirmDelete(true)}
                  icon={<Trash2 size={14} color="#EF4444" />}
                >
                  <Text color="#EF4444" fontSize="$2">
                    Delete
                  </Text>
                </Button>
              </>
            )}
          </XStack>
        </YStack>
      )}
    </YStack>
  )
}

// ── OAuth state types ─────────────────────────────────────────────────────────

interface OAuthState {
  method: 'callback-url' | 'device-flow';
  authUrl: string;
  verifier: string;
  // Device Flow only
  userCode?: string;
  interval?: number;
}

// ── DeviceFlowPanel ───────────────────────────────────────────────────────────

function DeviceFlowPanel({
  oauthState,
  onComplete,
  onCancel,
  completing,
}: {
  oauthState: OAuthState;
  onComplete: () => void;
  onCancel: () => void;
  completing: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (oauthState.userCode) {
      copyToClipboard(oauthState.userCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <YStack gap="$4">
      <YStack gap="$2">
        <Text fontSize="$3" fontWeight="600" color="$color">
          Connect ChatGPT Pro/Plus
        </Text>
        <Text fontSize="$2" color="$gray11">
          Follow these steps to authorize Teros with your ChatGPT subscription:
        </Text>
      </YStack>

      {/* Step 1: Code */}
      <YStack
        backgroundColor="rgba(16, 185, 129, 0.08)"
        borderRadius="$3"
        borderWidth={1}
        borderColor="rgba(16, 185, 129, 0.2)"
        padding="$3"
        gap="$2"
      >
        <XStack alignItems="center" gap="$2">
          <YStack
            width={20}
            height={20}
            borderRadius={10}
            backgroundColor="rgba(16, 185, 129, 0.2)"
            justifyContent="center"
            alignItems="center"
          >
            <Text fontSize="$1" color="#10B981" fontWeight="700">1</Text>
          </YStack>
          <Text fontSize="$2" fontWeight="500" color="$color">
            Your authorization code
          </Text>
        </XStack>

        <XStack alignItems="center" gap="$3" justifyContent="center" paddingVertical="$2">
          <Text
            fontSize={28}
            fontWeight="700"
            color="#10B981"
            fontFamily="$mono"
            letterSpacing={4}
          >
            {oauthState.userCode}
          </Text>
          <Button
            size="$2"
            backgroundColor="rgba(16, 185, 129, 0.1)"
            borderColor="rgba(16, 185, 129, 0.3)"
            borderWidth={1}
            onPress={handleCopy}
            icon={copied ? <Check size={14} color="#10B981" /> : <Copy size={14} color="#10B981" />}
          >
            <Text fontSize="$1" color="#10B981">
              {copied ? 'Copied!' : 'Copy'}
            </Text>
          </Button>
        </XStack>
      </YStack>

      {/* Step 2: Open URL */}
      <YStack
        backgroundColor="rgba(39, 39, 42, 0.3)"
        borderRadius="$3"
        borderWidth={1}
        borderColor="rgba(39, 39, 42, 0.5)"
        padding="$3"
        gap="$2"
      >
        <XStack alignItems="center" gap="$2">
          <YStack
            width={20}
            height={20}
            borderRadius={10}
            backgroundColor="rgba(113, 113, 122, 0.2)"
            justifyContent="center"
            alignItems="center"
          >
            <Text fontSize="$1" color="$gray11" fontWeight="700">2</Text>
          </YStack>
          <Text fontSize="$2" fontWeight="500" color="$color">
            Open the authorization page
          </Text>
        </XStack>

        <Button
          size="$3"
          backgroundColor="rgba(16, 185, 129, 0.12)"
          borderColor="rgba(16, 185, 129, 0.3)"
          borderWidth={1}
          onPress={() => openUrl(oauthState.authUrl)}
          icon={<ExternalLink size={15} color="#10B981" />}
        >
          <Text color="#10B981" fontSize="$2">
            Open auth.openai.com
          </Text>
        </Button>

        <Text fontSize="$1" color="$gray10" textAlign="center">
          Enter the code above when prompted
        </Text>
      </YStack>

      {/* Step 3: Confirm */}
      <YStack
        backgroundColor="rgba(39, 39, 42, 0.3)"
        borderRadius="$3"
        borderWidth={1}
        borderColor="rgba(39, 39, 42, 0.5)"
        padding="$3"
        gap="$2"
      >
        <XStack alignItems="center" gap="$2">
          <YStack
            width={20}
            height={20}
            borderRadius={10}
            backgroundColor="rgba(113, 113, 122, 0.2)"
            justifyContent="center"
            alignItems="center"
          >
            <Text fontSize="$1" color="$gray11" fontWeight="700">3</Text>
          </YStack>
          <Text fontSize="$2" fontWeight="500" color="$color">
            After approving, click below
          </Text>
        </XStack>

        <Button
          size="$3"
          backgroundColor="rgba(34, 197, 94, 0.15)"
          borderColor="rgba(34, 197, 94, 0.3)"
          borderWidth={1}
          onPress={onComplete}
          disabled={completing}
          icon={
            completing ? (
              <Loader2 size={16} color="#22C55E" />
            ) : (
              <Check size={16} color="#22C55E" />
            )
          }
        >
          <Text color="#22C55E">
            {completing ? 'Connecting...' : "I've approved — Connect"}
          </Text>
        </Button>
      </YStack>

      {/* Cancel */}
      <XStack justifyContent="center">
        <Button
          size="$2"
          backgroundColor="transparent"
          onPress={onCancel}
          disabled={completing}
        >
          <Text color="$gray10" fontSize="$2">
            Cancel
          </Text>
        </Button>
      </XStack>
    </YStack>
  );
}

// ── CallbackUrlPanel ──────────────────────────────────────────────────────────

function CallbackUrlPanel({
  oauthState,
  onComplete,
  onCancel,
  completing,
}: {
  oauthState: OAuthState;
  onComplete: (callbackUrl: string) => void;
  onCancel: () => void;
  completing: boolean;
}) {
  const [callbackUrl, setCallbackUrl] = useState('');

  return (
    <YStack gap="$3">
      <Text fontSize="$2" color="$gray11">
        Connect your Claude Max subscription using OAuth.
      </Text>

      {/* Open auth URL */}
      <Button
        size="$3"
        backgroundColor="rgba(217, 119, 6, 0.15)"
        borderColor="rgba(217, 119, 6, 0.3)"
        borderWidth={1}
        onPress={() => openUrl(oauthState.authUrl)}
        icon={<ExternalLink size={15} color="#D97706" />}
      >
        <Text color="#D97706">Open Claude Authorization Page</Text>
      </Button>

      <Text fontSize="$2" color="$gray11">
        After authorizing, paste the callback URL from your browser:
      </Text>

      <Input
        size="$3"
        backgroundColor="rgba(39, 39, 42, 0.5)"
        borderColor="rgba(39, 39, 42, 0.8)"
        placeholder="https://console.anthropic.com/oauth/code/callback?code=..."
        value={callbackUrl}
        onChangeText={setCallbackUrl}
        fontFamily="$mono"
        fontSize="$2"
        autoCapitalize="none"
      />

      <XStack gap="$2" justifyContent="flex-end">
        <Button
          size="$3"
          backgroundColor="rgba(39, 39, 42, 0.5)"
          onPress={onCancel}
          disabled={completing}
        >
          <Text color="$gray11">Cancel</Text>
        </Button>
        <Button
          size="$3"
          backgroundColor="rgba(34, 197, 94, 0.15)"
          borderColor="rgba(34, 197, 94, 0.3)"
          borderWidth={1}
          onPress={() => callbackUrl && onComplete(callbackUrl)}
          disabled={!callbackUrl || completing}
          icon={
            completing ? (
              <Loader2 size={16} color="#22C55E" />
            ) : (
              <Check size={16} color="#22C55E" />
            )
          }
        >
          <Text color="#22C55E">{completing ? 'Connecting...' : 'Connect'}</Text>
        </Button>
      </XStack>
    </YStack>
  );
}

// ── AddProviderForm ───────────────────────────────────────────────────────────

function AddProviderForm({
  onAdd,
  onStartOAuth,
  onCompleteOAuth,
  onCancel,
  adding,
  completing,
  oauthState,
}: {
  onAdd: (type: string, name: string, apiKey: string, config?: Record<string, any>) => void;
  onStartOAuth: (type: string) => void;
  onCompleteOAuth: (verifier: string, callbackUrl?: string) => void;
  onCancel: () => void;
  adding: boolean;
  completing: boolean;
  oauthState: OAuthState | null;
}) {
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);

  const typeInfo = PROVIDER_TYPES.find((t) => t.id === selectedType)
  const isOAuth = typeInfo?.authType === "oauth"
  const isUrl = typeInfo?.authType === "url"

  const handleSubmit = () => {
    if (!selectedType) return;
    if (isUrl && displayName && baseUrl) {
      onAdd(selectedType, displayName, '', { baseUrl });
    } else if (displayName && apiKey) {
      onAdd(selectedType, displayName, apiKey);
    }
  }

  return (
    <YStack
      backgroundColor="rgba(20, 20, 22, 0.9)"
      borderRadius="$4"
      borderWidth={1}
      borderColor="rgba(34, 197, 94, 0.3)"
      padding="$4"
      gap="$4"
    >
      <XStack alignItems="center" justifyContent="space-between">
        <Text fontSize="$5" fontWeight="600" color="$color">
          Add Provider
        </Text>
        <Button
          size="$2"
          circular
          backgroundColor="transparent"
          onPress={onCancel}
          icon={<X size={18} color="$gray11" />}
        />
      </XStack>

      {/* Provider Type Selection */}
      {!selectedType ? (
        <YStack gap="$2">
          <Text fontSize="$2" color="$gray11">
            Select provider type
          </Text>
          {PROVIDER_TYPES.map((type) => (
            <XStack
              key={type.id}
              padding="$3"
              backgroundColor="rgba(39, 39, 42, 0.3)"
              borderRadius="$3"
              borderWidth={1}
              borderColor="rgba(39, 39, 42, 0.5)"
              alignItems="center"
              gap="$3"
              cursor="pointer"
              hoverStyle={{ backgroundColor: "rgba(39, 39, 42, 0.5)" }}
              pressStyle={{ opacity: 0.8 }}
              onPress={() => {
                setSelectedType(type.id)
                setDisplayName(type.name)
              }}
            >
              <YStack
                width={36}
                height={36}
                borderRadius={8}
                backgroundColor={`${type.color}15`}
                justifyContent="center"
                alignItems="center"
              >
                <Cloud size={18} color={type.color} />
              </YStack>
              <YStack flex={1}>
                <Text fontSize="$3" fontWeight="500" color="$color">
                  {type.name}
                </Text>
                <Text fontSize="$2" color="$gray11">
                  {type.description}
                </Text>
              </YStack>
              {type.authType === "oauth" && (
                <Text fontSize="$1" color="$blue10" opacity={0.7}>
                  OAuth
                </Text>
              )}
            </XStack>
          ))}
        </YStack>
      ) : (
        <YStack gap="$3">
          {/* Selected type indicator */}
          <XStack alignItems="center" gap="$2">
            <YStack
              width={24}
              height={24}
              borderRadius={6}
              backgroundColor={`${typeInfo?.color}15`}
              justifyContent="center"
              alignItems="center"
            >
              <Cloud size={14} color={typeInfo?.color} />
            </YStack>
            <Text fontSize="$3" color="$color">
              {typeInfo?.name}
            </Text>
            {!oauthState && (
              <Button
                size="$1"
                backgroundColor="transparent"
                onPress={() => setSelectedType(null)}
              >
                <Text fontSize="$1" color="$blue10">
                  Change
                </Text>
              </Button>
            )}
          </XStack>

          {isOAuth ? (
            /* ── OAuth flows ── */
            oauthState ? (
              /* Flow in progress */
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
              /* Not started yet */
              <YStack gap="$3">
                <Text fontSize="$2" color="$gray11">
                  {typeInfo?.id === 'openai-codex-oauth'
                    ? 'Connect your ChatGPT Pro or Plus subscription to use Codex models.'
                    : 'Connect your Claude Max subscription using OAuth.'}
                </Text>
                <XStack gap="$2" justifyContent="flex-end">
                  <Button
                    size="$3"
                    backgroundColor="rgba(39, 39, 42, 0.5)"
                    onPress={onCancel}
                    disabled={adding}
                  >
                    <Text color="$gray11">Cancel</Text>
                  </Button>
                  <Button
                    size="$3"
                    backgroundColor={`${typeInfo?.color}20`}
                    borderColor={`${typeInfo?.color}40`}
                    borderWidth={1}
                    onPress={() => selectedType && onStartOAuth(selectedType)}
                    disabled={adding}
                    icon={
                      adding ? (
                        <Loader2 size={16} color={typeInfo?.color} />
                      ) : (
                        <Key size={16} color={typeInfo?.color} />
                      )
                    }
                  >
                    <Text color={typeInfo?.color}>
                      {adding ? 'Starting...' : 'Connect with OAuth'}
                    </Text>
                  </Button>
                </XStack>
              </YStack>
            )
          ) : (
            /* ── API Key / URL flows ── */
            <>
              {/* Display Name */}
              <YStack gap="$1">
                <Text fontSize="$2" color="$gray11">
                  Display Name
                </Text>
                <Input
                  size="$3"
                  backgroundColor="rgba(39, 39, 42, 0.5)"
                  borderColor="rgba(39, 39, 42, 0.8)"
                  placeholder={isUrl ? "My Ollama Server" : "My Anthropic Account"}
                  value={displayName}
                  onChangeText={setDisplayName}
                />
              </YStack>

              {isUrl ? (
                <YStack gap="$1">
                  <Text fontSize="$2" color="$gray11">
                    Server URL
                  </Text>
                  <Input
                    size="$3"
                    backgroundColor="rgba(39, 39, 42, 0.5)"
                    borderColor="rgba(39, 39, 42, 0.8)"
                    placeholder={typeInfo?.placeholder}
                    value={baseUrl}
                    onChangeText={setBaseUrl}
                    fontFamily="$mono"
                    autoCapitalize="none"
                  />
                  <Text fontSize="$1" color="$gray10">
                    URL of your Ollama server (models will be discovered automatically)
                  </Text>
                </YStack>
              ) : (
                <YStack gap="$1">
                  <Text fontSize="$2" color="$gray11">
                    API Key
                  </Text>
                  <XStack gap="$2">
                    <Input
                      flex={1}
                      size="$3"
                      backgroundColor="rgba(39, 39, 42, 0.5)"
                      borderColor="rgba(39, 39, 42, 0.8)"
                      placeholder={typeInfo?.placeholder}
                      value={apiKey}
                      onChangeText={setApiKey}
                      secureTextEntry={!showApiKey}
                      fontFamily="$mono"
                    />
                    <Button
                      size="$3"
                      backgroundColor="rgba(39, 39, 42, 0.5)"
                      onPress={() => setShowApiKey(!showApiKey)}
                      icon={showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
                    />
                  </XStack>
                  <Text fontSize="$1" color="$gray10">
                    Your API key is encrypted and stored securely
                  </Text>
                </YStack>
              )}

              <XStack gap="$2" justifyContent="flex-end">
                <Button
                  size="$3"
                  backgroundColor="rgba(39, 39, 42, 0.5)"
                  onPress={onCancel}
                  disabled={adding}
                >
                  <Text color="$gray11">Cancel</Text>
                </Button>
                <Button
                  size="$3"
                  backgroundColor="rgba(34, 197, 94, 0.15)"
                  borderColor="rgba(34, 197, 94, 0.3)"
                  borderWidth={1}
                  onPress={handleSubmit}
                  disabled={!displayName || (isUrl ? !baseUrl : !apiKey) || adding}
                  icon={
                    adding ? (
                      <Loader2 size={16} color="#22C55E" />
                    ) : (
                      <Check size={16} color="#22C55E" />
                    )
                  }
                >
                  <Text color="#22C55E">{adding ? "Adding..." : "Add Provider"}</Text>
                </Button>
              </XStack>
            </>
          )}
        </YStack>
      )}
    </YStack>
  )
}

// ── ProvidersWindowContent ────────────────────────────────────────────────────

export interface ProvidersWindowContentProps {
  windowId: string
}

export function ProvidersWindowContent({ windowId }: ProvidersWindowContentProps) {
  const client = getTerosClient()

  const [providers, setProviders] = useState<UserProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [adding, setAdding] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);

  // OAuth state (persisted across re-renders, cleared on success/cancel)
  const [oauthState, setOauthState] = useState<OAuthState | null>(null);

  const loadProviders = async () => {
    try {
      setLoading(true)
      const result = await client.provider.list()
      setProviders(result.providers)
      setError(null)
    } catch (err) {
      console.error("Failed to load providers:", err)
      setError(err instanceof Error ? err.message : "Failed to load providers")
    } finally {
      setLoading(false)
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
      await client.provider.add({
        providerType: type,
        displayName: name,
        config,
        auth: apiKey ? { apiKey } : undefined,
      })
      setShowAddForm(false)
      await loadProviders()
    } catch (err) {
      console.error("Failed to add provider:", err)
      setError(err instanceof Error ? err.message : "Failed to add provider")
    } finally {
      setAdding(false)
    }
  }

  const handleTestProvider = async (providerId: string) => {
    try {
      setTestingId(providerId)
      await client.provider.test(providerId)
      await loadProviders()
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
      setError(err instanceof Error ? err.message : "Failed to delete provider")
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
      setError(err instanceof Error ? err.message : 'Failed to start OAuth flow');
    } finally {
      setAdding(false)
    }
  }

  const handleCompleteOAuth = async (verifier: string, callbackUrl?: string) => {
    try {
      setCompleting(true);
      await client.provider.completeOAuth(verifier, callbackUrl);
      setShowAddForm(false);
      setOauthState(null);
      await loadProviders();
    } catch (err) {
      console.error('Failed to complete OAuth:', err);
      setError(err instanceof Error ? err.message : 'Failed to complete OAuth. Please try again.');
    } finally {
      setCompleting(false);
    }
  };

  const handleCancelForm = () => {
    setShowAddForm(false);
    setOauthState(null);
  };

  if (loading) {
    return <FullscreenLoader variant="default" label="Loading providers..." />;
  }

  return (
    <YStack flex={1} backgroundColor="$background">
      <ScrollView flex={1}>
        <YStack padding="$4" gap="$4">
          {/* Header */}
          <XStack alignItems="center" justifyContent="space-between">
            <Text fontSize="$6" fontWeight="700" color="$color">
              My Providers
            </Text>
            {!showAddForm && providers.length > 0 && (
              <Button
                size="$3"
                backgroundColor="rgba(34, 197, 94, 0.15)"
                borderColor="rgba(34, 197, 94, 0.3)"
                borderWidth={1}
                onPress={() => setShowAddForm(true)}
                icon={<Plus size={16} color="#22C55E" />}
              >
                <Text color="#22C55E">Add</Text>
              </Button>
            )}
          </XStack>

          {/* Error */}
          {error && (
            <XStack
              backgroundColor="rgba(239, 68, 68, 0.1)"
              padding="$3"
              borderRadius="$3"
              gap="$2"
              alignItems="center"
            >
              <AlertCircle size={16} color="#EF4444" />
              <Text fontSize="$2" color="#EF4444" flex={1}>
                {error}
              </Text>
              <Button
                size="$1"
                backgroundColor="transparent"
                onPress={() => setError(null)}
                icon={<X size={14} color="#EF4444" />}
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
                  testing={testingId === provider.providerId}
                />
              ))}
            </YStack>
          ) : (
            !showAddForm && (
              <YStack flex={1} alignItems="center" justifyContent="center" padding="$6">
                <Key size={40} color="$gray7" />
                <Text color="$gray9" marginTop="$3" textAlign="center" fontSize="$3">
                  No providers yet
                </Text>
                <Button
                  size="$3"
                  marginTop="$4"
                  backgroundColor="rgba(34, 197, 94, 0.15)"
                  borderColor="rgba(34, 197, 94, 0.3)"
                  borderWidth={1}
                  onPress={() => setShowAddForm(true)}
                  icon={<Plus size={16} color="#22C55E" />}
                >
                  <Text color="#22C55E">Add Provider</Text>
                </Button>
              </YStack>
            )
          )}
        </YStack>
      </ScrollView>
    </YStack>
  )
}
