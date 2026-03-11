/**
 * AuthPanel Component
 *
 * Collapsible panel for app authentication configuration.
 * Contains two subsections:
 * 1. OAuth Connection - Connect/disconnect OAuth accounts
 * 2. Credentials - Edit API keys and secrets
 */

import {
  AlertCircle,
  Check,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  Info,
  Key,
  Link,
  RefreshCw,
  Unlink,
  X,
} from '@tamagui/lucide-icons';
import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Text, XStack, YStack } from 'tamagui';
import { usePulseAnimation } from '../../hooks/usePulseAnimation';
import { AppSpinner } from '../../components/ui';

// ============================================================================
// Types
// ============================================================================

export type OAuthStatus = 'connected' | 'disconnected' | 'expired' | 'error';

export interface OAuthInfo {
  provider: string;
  status: OAuthStatus;
  email?: string;
  expiresAt?: string;
  scopes?: string[];
  error?: string;
}

export interface CredentialField {
  name: string;
  label?: string;
  type: 'text' | 'password';
  required: boolean;
  placeholder?: string;
  hint?: string;
  value?: string;
  isSet?: boolean;
}

export interface AuthPanelProps {
  /** OAuth info (null if not OAuth-based) */
  oauth?: OAuthInfo | null;
  /** Credential fields to display */
  credentials?: CredentialField[];
  /** Loading state */
  loading?: boolean;
  /** Whether there are unsaved changes */
  hasChanges?: boolean;
  /** Saving state */
  saving?: boolean;
  /** OAuth callbacks */
  onConnect?: () => void;
  onDisconnect?: () => void;
  onRefresh?: () => void;
  connecting?: boolean;
  disconnecting?: boolean;
  /** Credentials callbacks */
  onCredentialChange?: (name: string, value: string) => void;
  onSaveCredentials?: () => void;
  /** Initial expanded state */
  defaultExpanded?: boolean;
}

// ============================================================================
// Colors
// ============================================================================

const colors = {
  // Status
  ready: '#22c55e',
  pending: '#3b82f6',
  warning: '#f59e0b',
  error: '#ef4444',

  // Glows
  glowReady: 'rgba(34, 197, 94, 0.5)',
  glowPending: 'rgba(59, 130, 246, 0.5)',
  glowWarning: 'rgba(245, 158, 11, 0.5)',
  glowError: 'rgba(239, 68, 68, 0.5)',

  // Section
  iconKey: '#a855f7',

  // Badges
  badgeGreen: { text: '#86efac', bg: 'rgba(34, 197, 94, 0.1)' },
  badgeBlue: { text: '#93c5fd', bg: 'rgba(59, 130, 246, 0.1)' },
  badgeYellow: { text: '#fcd34d', bg: 'rgba(251, 191, 36, 0.1)' },
  badgeRed: { text: '#fca5a5', bg: 'rgba(239, 68, 68, 0.1)' },
  badgeGray: { text: '#a1a1aa', bg: 'rgba(255, 255, 255, 0.06)' },

  // Text
  textPrimary: '#e4e4e7',
  textSecondary: '#a1a1aa',
  textMuted: '#52525b',
  textBright: '#f4f4f5',

  // Backgrounds
  panelBg: 'rgba(39, 39, 42, 0.6)',
  sectionBg: 'rgba(0, 0, 0, 0.15)',
  cardBg: 'rgba(0, 0, 0, 0.2)',
  inputBg: 'rgba(0, 0, 0, 0.3)',

  // Borders
  border: 'rgba(255, 255, 255, 0.04)',
  borderFocus: 'rgba(59, 130, 246, 0.4)',

  // Buttons
  btnDanger: { bg: 'rgba(239, 68, 68, 0.1)', text: '#fca5a5', border: 'rgba(239, 68, 68, 0.15)' },
  btnPrimary: {
    bg: 'rgba(59, 130, 246, 0.1)',
    text: '#93c5fd',
    border: 'rgba(59, 130, 246, 0.15)',
  },
  btnGhost: { bg: 'transparent', text: '#a1a1aa', border: 'rgba(255, 255, 255, 0.08)' },

  // Chevron
  chevron: '#3f3f46',
};

// ============================================================================
// Status Dot Component
// ============================================================================

interface StatusDotProps {
  status: 'ready' | 'pending' | 'warning' | 'error';
}

function StatusDot({ status }: StatusDotProps) {
  const colorMap = {
    ready: { color: colors.ready, glow: colors.glowReady },
    pending: { color: colors.pending, glow: colors.glowPending },
    warning: { color: colors.warning, glow: colors.glowWarning },
    error: { color: colors.error, glow: colors.glowError },
  };

  const { color, glow } = colorMap[status];

  const pulseAnim = usePulseAnimation(status === 'pending');

  return (
    <Animated.View
      style={{
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: color,
        flexShrink: 0,
        opacity: status === 'pending' ? pulseAnim : 1,
        shadowColor: glow,
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 1,
        shadowRadius: 4,
        elevation: 3,
      }}
    />
  );
}

// ============================================================================
// Badge Component
// ============================================================================

interface BadgeProps {
  text: string;
  variant: 'green' | 'blue' | 'yellow' | 'red' | 'gray';
}

function Badge({ text, variant }: BadgeProps) {
  const colorMap = {
    green: colors.badgeGreen,
    blue: colors.badgeBlue,
    yellow: colors.badgeYellow,
    red: colors.badgeRed,
    gray: colors.badgeGray,
  };

  const { text: textColor, bg } = colorMap[variant];

  return (
    <View
      style={{
        backgroundColor: bg,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 4,
      }}
    >
      <Text color={textColor} fontSize={11} fontFamily="$mono" fontWeight="500">
        {text}
      </Text>
    </View>
  );
}

// ============================================================================
// Credential Input Component
// ============================================================================

interface CredentialInputProps {
  field: CredentialField;
  onChange: (value: string) => void;
}

function CredentialInput({ field, onChange }: CredentialInputProps) {
  const [showValue, setShowValue] = useState(false);
  const [localValue, setLocalValue] = useState(field.value || '');
  const [isFocused, setIsFocused] = useState(false);

  const isPassword = field.type === 'password';
  const displayLabel = field.label || field.name;

  const handleCopy = () => {
    // In React Native, we'd use Clipboard API
    // For now, this is a placeholder
    console.log('Copy:', localValue);
  };

  const handleChange = (text: string) => {
    setLocalValue(text);
    onChange(text);
  };

  return (
    <View style={{ marginBottom: 16 }}>
      {/* Label row */}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
        <Text fontSize={12} color={colors.textSecondary} fontWeight="500">
          {displayLabel}
        </Text>
        {field.required ? (
          <Text fontSize={10} color={colors.error} fontWeight="500">
            requerido
          </Text>
        ) : (
          <Text fontSize={10} color={colors.textMuted}>
            opcional
          </Text>
        )}
      </View>

      {/* Input wrapper */}
      <View style={{ position: 'relative' }}>
        <TextInput
          value={localValue}
          onChangeText={handleChange}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          placeholder={field.placeholder}
          placeholderTextColor={colors.textMuted}
          secureTextEntry={isPassword && !showValue}
          style={{
            width: '100%',
            paddingVertical: 10,
            paddingHorizontal: 12,
            paddingRight: isPassword ? 80 : 44,
            backgroundColor: colors.inputBg,
            borderWidth: 1,
            borderColor: isFocused ? colors.borderFocus : colors.border,
            borderRadius: 6,
            color: colors.textPrimary,
            fontSize: 13,
            fontFamily: 'monospace',
          }}
        />

        {/* Action buttons */}
        <View
          style={{
            position: 'absolute',
            right: 8,
            top: 0,
            bottom: 0,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
          }}
        >
          {isPassword && (
            <TouchableOpacity
              onPress={() => setShowValue(!showValue)}
              style={{
                width: 28,
                height: 28,
                borderRadius: 4,
                backgroundColor: 'rgba(255, 255, 255, 0.04)',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {showValue ? (
                <EyeOff size={14} color={colors.textMuted} />
              ) : (
                <Eye size={14} color={colors.textMuted} />
              )}
            </TouchableOpacity>
          )}
          <TouchableOpacity
            onPress={handleCopy}
            style={{
              width: 28,
              height: 28,
              borderRadius: 4,
              backgroundColor: 'rgba(255, 255, 255, 0.04)',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Copy size={14} color={colors.textMuted} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Status indicator */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 }}>
        {field.isSet || localValue ? (
          <>
            <Check size={12} color={colors.ready} />
            <Text fontSize={11} color={colors.ready}>
              Configurado
            </Text>
          </>
        ) : (
          <>
            <View
              style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                borderWidth: 1,
                borderColor: colors.textMuted,
              }}
            />
            <Text fontSize={11} color={colors.textMuted}>
              No configurado
            </Text>
          </>
        )}
      </View>

      {/* Hint */}
      {field.hint && (
        <Text fontSize={11} color={colors.textMuted} style={{ marginTop: 6, lineHeight: 16 }}>
          {field.hint}
        </Text>
      )}
    </View>
  );
}

// ============================================================================
// OAuth Section Component
// ============================================================================

interface OAuthSectionProps {
  oauth: OAuthInfo;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onRefresh?: () => void;
  connecting?: boolean;
  disconnecting?: boolean;
}

function OAuthSection({
  oauth,
  onConnect,
  onDisconnect,
  onRefresh,
  connecting,
  disconnecting,
}: OAuthSectionProps) {
  const isConnected = oauth.status === 'connected';
  const isExpired = oauth.status === 'expired';
  const isError = oauth.status === 'error';
  const needsConnect = oauth.status === 'disconnected';

  const getStatusBadge = () => {
    switch (oauth.status) {
      case 'connected':
        return { text: 'conectado', variant: 'green' as const };
      case 'disconnected':
        return { text: 'desconectado', variant: 'blue' as const };
      case 'expired':
        return { text: 'expirado', variant: 'yellow' as const };
      case 'error':
        return { text: 'error', variant: 'red' as const };
    }
  };

  const badge = getStatusBadge();

  return (
    <View style={{ padding: 16, borderBottomWidth: 1, borderBottomColor: colors.border }}>
      {/* Subsection header */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <Text
          fontSize={12}
          fontWeight="600"
          color={colors.textMuted}
          style={{ textTransform: 'uppercase', letterSpacing: 0.5 }}
        >
          OAuth connection
        </Text>
        <Badge text={badge.text} variant={badge.variant} />
      </View>

      {/* Info message for non-connected states */}
      {(needsConnect || isExpired || isError) && (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: 10,
            padding: 12,
            backgroundColor: isError
              ? 'rgba(239, 68, 68, 0.08)'
              : isExpired
                ? 'rgba(251, 191, 36, 0.08)'
                : 'rgba(59, 130, 246, 0.08)',
            borderRadius: 6,
            marginBottom: 12,
          }}
        >
          {isError ? (
            <AlertCircle size={16} color={colors.badgeRed.text} />
          ) : (
            <Info size={16} color={isExpired ? colors.badgeYellow.text : colors.badgeBlue.text} />
          )}
          <Text
            flex={1}
            fontSize={13}
            color={
              isError
                ? colors.badgeRed.text
                : isExpired
                  ? colors.badgeYellow.text
                  : colors.badgeBlue.text
            }
            style={{ lineHeight: 20 }}
          >
            {isError
              ? oauth.error || 'Error al validar credenciales.'
              : isExpired
                ? 'Your session has expired. Reconnect to continue.'
                : `Conecta tu cuenta de ${oauth.provider} para que el agente pueda acceder a este servicio.`}
          </Text>
        </View>
      )}

      {/* Connected account card */}
      {(isConnected || isExpired) && oauth.email && (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            padding: 12,
            backgroundColor: colors.cardBg,
            borderRadius: 8,
            marginBottom: 12,
            opacity: isExpired ? 0.6 : 1,
          }}
        >
          <View
            style={{
              width: 40,
              height: 40,
              borderRadius: 20,
              backgroundColor: isExpired ? 'rgba(251, 191, 36, 0.1)' : 'rgba(6, 182, 212, 0.1)',
              borderWidth: 1,
              borderColor: isExpired ? 'rgba(251, 191, 36, 0.3)' : 'rgba(6, 182, 212, 0.3)',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text
              fontSize={14}
              fontWeight="600"
              color={isExpired ? colors.badgeYellow.text : '#06b6d4'}
            >
              {oauth.email.charAt(0).toUpperCase()}
            </Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text fontSize={14} color={colors.textBright}>
              {oauth.email}
            </Text>
            <Text
              fontSize={12}
              color={isExpired ? colors.badgeYellow.text : colors.textMuted}
              style={{ marginTop: 2 }}
            >
              {isExpired
                ? `Expired ${oauth.expiresAt ? new Date(oauth.expiresAt).toLocaleDateString() : ''}`
                : oauth.expiresAt
                  ? `Expira ${new Date(oauth.expiresAt).toLocaleDateString()}`
                  : oauth.provider}
            </Text>
          </View>
        </View>
      )}

      {/* Action buttons */}
      {isConnected && (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {onRefresh && (
            <TouchableOpacity
              onPress={onRefresh}
              style={{
                flex: 1,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                padding: 10,
                backgroundColor: colors.btnGhost.bg,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: colors.btnGhost.border,
              }}
            >
              <RefreshCw size={14} color={colors.btnGhost.text} />
              <Text fontSize={13} fontWeight="500" color={colors.btnGhost.text}>
                Refrescar
              </Text>
            </TouchableOpacity>
          )}
          {onDisconnect && (
            <TouchableOpacity
              onPress={onDisconnect}
              disabled={disconnecting}
              style={{
                flex: 1,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                padding: 10,
                backgroundColor: colors.btnDanger.bg,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: colors.btnDanger.border,
                opacity: disconnecting ? 0.6 : 1,
              }}
            >
              {disconnecting ? (
                <AppSpinner size="sm" variant="danger" />
              ) : (
                <>
                  <Unlink size={14} color={colors.btnDanger.text} />
                  <Text fontSize={13} fontWeight="500" color={colors.btnDanger.text}>
                    Desconectar
                  </Text>
                </>
              )}
            </TouchableOpacity>
          )}
        </View>
      )}

      {(needsConnect || isExpired || isError) && onConnect && (
        <TouchableOpacity
          onPress={onConnect}
          disabled={connecting}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            padding: 12,
            backgroundColor: isExpired
              ? colors.btnWarning?.bg || 'rgba(251, 191, 36, 0.1)'
              : colors.btnPrimary.bg,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: isExpired ? 'rgba(251, 191, 36, 0.15)' : colors.btnPrimary.border,
            opacity: connecting ? 0.6 : 1,
          }}
        >
          {connecting ? (
            <AppSpinner size="sm" />
          ) : (
            <>
              <Link
                size={14}
                color={isExpired ? colors.badgeYellow.text : colors.btnPrimary.text}
              />
              <Text
                fontSize={13}
                fontWeight="500"
                color={isExpired ? colors.badgeYellow.text : colors.btnPrimary.text}
              >
                {isExpired ? 'Reconectar' : `Conectar con ${oauth.provider}`}
              </Text>
            </>
          )}
        </TouchableOpacity>
      )}
    </View>
  );
}

// ============================================================================
// Credentials Section Component
// ============================================================================

interface CredentialsSectionProps {
  credentials: CredentialField[];
  onCredentialChange: (name: string, value: string) => void;
}

function CredentialsSection({ credentials, onCredentialChange }: CredentialsSectionProps) {
  if (credentials.length === 0) return null;

  return (
    <View style={{ padding: 16 }}>
      {/* Subsection header */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <Text
          fontSize={12}
          fontWeight="600"
          color={colors.textMuted}
          style={{ textTransform: 'uppercase', letterSpacing: 0.5 }}
        >
          Credenciales
        </Text>
      </View>

      {/* Credential inputs */}
      {credentials.map((field, index) => (
        <CredentialInput
          key={field.name}
          field={field}
          onChange={(value) => onCredentialChange(field.name, value)}
        />
      ))}
    </View>
  );
}

// ============================================================================
// Save Bar Component
// ============================================================================

interface SaveBarProps {
  onSave: () => void;
  saving?: boolean;
}

function SaveBar({ onSave, saving }: SaveBarProps) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: 12,
        paddingHorizontal: 16,
        backgroundColor: 'rgba(59, 130, 246, 0.08)',
        borderTopWidth: 1,
        borderTopColor: 'rgba(59, 130, 246, 0.15)',
      }}
    >
      <Text fontSize={12} color={colors.badgeBlue.text}>
        Tienes cambios sin guardar
      </Text>
      <TouchableOpacity
        onPress={onSave}
        disabled={saving}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          paddingVertical: 8,
          paddingHorizontal: 16,
          backgroundColor: colors.btnPrimary.bg,
          borderRadius: 6,
          borderWidth: 1,
          borderColor: colors.btnPrimary.border,
          opacity: saving ? 0.6 : 1,
        }}
      >
        {saving ? (
          <AppSpinner size="sm" variant="brand" />
        ) : (
          <Text fontSize={13} fontWeight="500" color={colors.btnPrimary.text}>
            Guardar
          </Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

// ============================================================================
// Main AuthPanel Component
// ============================================================================

export function AuthPanel({
  oauth,
  credentials = [],
  loading = false,
  hasChanges = false,
  saving = false,
  onConnect,
  onDisconnect,
  onRefresh,
  connecting = false,
  disconnecting = false,
  onCredentialChange,
  onSaveCredentials,
  defaultExpanded = true,
}: AuthPanelProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const rotateAnim = useRef(new Animated.Value(defaultExpanded ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(rotateAnim, {
      toValue: expanded ? 1 : 0,
      duration: 150,
      easing: Easing.inOut(Easing.ease),
      useNativeDriver: true,
    }).start();
  }, [expanded, rotateAnim]);

  const rotation = rotateAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '90deg'],
  });

  // Determine overall status
  const getStatus = (): 'ready' | 'pending' | 'warning' | 'error' => {
    if (oauth) {
      if (oauth.status === 'connected') return 'ready';
      if (oauth.status === 'disconnected') return 'pending';
      if (oauth.status === 'expired') return 'warning';
      if (oauth.status === 'error') return 'error';
    }
    // Check credentials
    const requiredMissing = credentials.some((c) => c.required && !c.isSet && !c.value);
    if (requiredMissing) return 'pending';
    return 'ready';
  };

  // Determine badge text
  const getBadge = (): { text: string; variant: BadgeProps['variant'] } => {
    const oauthPart = oauth ? (oauth.status === 'connected' ? 'OAuth' : '') : '';
    const credCount = credentials.filter((c) => c.isSet || c.value).length;
    const credPart = credCount > 0 ? `${credCount} key${credCount > 1 ? 's' : ''}` : '';

    if (oauthPart && credPart) return { text: `${oauthPart} + ${credPart}`, variant: 'green' };
    if (oauthPart) return { text: oauthPart, variant: 'green' };
    if (credPart) return { text: credPart, variant: 'green' };

    if (oauth?.status === 'disconnected') return { text: 'conectar', variant: 'blue' };
    if (oauth?.status === 'expired') return { text: 'expirado', variant: 'yellow' };
    if (oauth?.status === 'error') return { text: 'error', variant: 'red' };

    const requiredMissing = credentials.some((c) => c.required && !c.isSet && !c.value);
    if (requiredMissing) return { text: 'configurar', variant: 'blue' };

    return { text: 'N/A', variant: 'gray' };
  };

  const status = getStatus();
  const badge = getBadge();

  return (
    <View
      style={{
        backgroundColor: colors.panelBg,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: colors.border,
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <TouchableOpacity
        onPress={() => setExpanded(!expanded)}
        activeOpacity={0.7}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          paddingVertical: 14,
          paddingHorizontal: 16,
        }}
      >
        <StatusDot status={status} />
        <Key size={18} color={colors.iconKey} />
        <Text flex={1} fontSize={14} fontWeight="500" color={colors.textPrimary}>
          Authentication
        </Text>
        {loading ? (
          <AppSpinner size="sm" variant="muted" />
        ) : (
          <Badge text={badge.text} variant={badge.variant} />
        )}
        <Animated.View style={{ transform: [{ rotate: rotation }] }}>
          <ChevronRight size={14} color={colors.chevron} />
        </Animated.View>
      </TouchableOpacity>

      {/* Content */}
      {expanded && (
        <View
          style={{
            backgroundColor: colors.sectionBg,
            borderTopWidth: 1,
            borderTopColor: colors.border,
          }}
        >
          {/* OAuth section */}
          {oauth && (
            <OAuthSection
              oauth={oauth}
              onConnect={onConnect}
              onDisconnect={onDisconnect}
              onRefresh={onRefresh}
              connecting={connecting}
              disconnecting={disconnecting}
            />
          )}

          {/* Credentials section */}
          {credentials.length > 0 && onCredentialChange && (
            <CredentialsSection credentials={credentials} onCredentialChange={onCredentialChange} />
          )}

          {/* Save bar */}
          {hasChanges && onSaveCredentials && (
            <SaveBar onSave={onSaveCredentials} saving={saving} />
          )}
        </View>
      )}
    </View>
  );
}

export default AuthPanel;
