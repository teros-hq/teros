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
  ExternalLink,
  Eye,
  EyeOff,
  FolderPlus,
  Info,
  Key,
  Link,
  Pencil,
  RefreshCw,
  Unlink,
  X,
} from '@tamagui/lucide-icons';
import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Linking,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Text, XStack, YStack } from 'tamagui';
import { usePulseAnimation } from '../../hooks/usePulseAnimation';
import { AppSpinner } from '../../components/ui';
import {
  colors as semantic,
  indicators,
} from '../../components/mca/primitives/colors';
import { FONT_MONO, FONT_SANS } from '../../components/mca/primitives/fonts';
import { type AdaptiveColors, useColors } from '../../components/mca/primitives/useColors';

// ============================================================================
// Types
// ============================================================================

export type OAuthStatus = 'connected' | 'disconnected' | 'expired' | 'error';

export interface OAuthInfo {
  provider: string;
  status: OAuthStatus;
  email?: string;
  /**
   * Login/handle del proveedor (e.g. GitHub `login`). Cuando esté presente
   * se prefiere mostrar `@${userLogin}` sobre el email — relevante para
   * GitHub App con userOAuth donde el email puede no estar verificado.
   */
  userLogin?: string;
  expiresAt?: string;
  scopes?: string[];
  error?: string;
  /**
   * Auth method used by the MCA. `github-app` swaps the OAuth-style
   * "Connect" copy for GitHub App-style "Install" copy and adds a banner
   * pointing to `/settings/installations/<id>` on github.com when connected.
   * Defaults to `'oauth2'` when omitted.
   */
  authType?: 'oauth2' | 'github-app';
  /** GitHub App installation ID (only when `authType === 'github-app'` and connected). */
  installationId?: string;
  /** GitHub App slug — used to build the install URL. */
  appSlug?: string;
  /** True when a legacy OAuth ACCESS_TOKEN is present without an INSTALLATION_ID — surface migration banner. */
  legacyOAuth?: boolean;
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
  /** Message shown when system-level secrets are missing (admin must configure) */
  systemSetupMessage?: string;
}

// ============================================================================
// Palette
// ============================================================================
//
// Theme-adaptive palette derived from `useColors()` (surface/text/border) plus
// the theme-agnostic semantic colors (status signals). Same shape as the
// pre-redesign hardcoded `colors` object so the sub-components keep reading
// `p.<token>`. Each sub-component calls `useColors()` and builds its own `p`
// (the hook is memoized, so this is cheap).

function makePalette(c: AdaptiveColors) {
  return {
    // Status (semantic — theme-agnostic signals)
    ready: semantic.green,
    pending: semantic.indigo,
    warning: semantic.amber,
    error: semantic.red,

    // Glows
    glowReady: 'rgba(34, 197, 94, 0.5)',
    glowPending: 'rgba(94, 106, 210, 0.5)',
    glowWarning: 'rgba(245, 158, 11, 0.5)',
    glowError: 'rgba(239, 68, 68, 0.5)',

    // Section
    iconKey: semantic.violet,

    // Badges (theme-adaptive)
    badgeGreen: c.badges.ok,
    badgeBlue: c.badges.info,
    badgeYellow: c.badges.warn,
    badgeRed: c.badges.err,
    badgeGray: c.badges.gray,

    // Text (theme-adaptive)
    textPrimary: c.text,
    textSecondary: c.text2,
    textMuted: c.text3,
    textBright: c.text,

    // Backgrounds (theme-adaptive)
    panelBg: c.bgCard,
    sectionBg: c.bgInner,
    cardBg: c.bgInner,
    inputBg: c.bgInner,

    // Borders (theme-adaptive)
    border: c.border,
    borderFocus: semantic.indigo,

    // Buttons
    btnDanger: { bg: c.badges.err.bg, text: c.badges.err.text, border: c.badges.err.border },
    btnPrimary: { bg: c.badges.info.bg, text: c.badges.info.text, border: c.badges.info.border },
    btnWarning: { bg: c.badges.warn.bg, text: c.badges.warn.text, border: c.badges.warn.border },
    btnGhost: { bg: 'transparent', text: c.text2, border: c.borderStrong },

    // Chevron
    chevron: c.text3,
  };
}

// ============================================================================
// Status Dot Component
// ============================================================================

interface StatusDotProps {
  status: 'ready' | 'pending' | 'warning' | 'error';
}

function StatusDot({ status }: StatusDotProps) {
  const colors = makePalette(useColors());
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
  const colors = makePalette(useColors());
  const colorMap = {
    green: colors.badgeGreen,
    blue: colors.badgeBlue,
    yellow: colors.badgeYellow,
    red: colors.badgeRed,
    gray: colors.badgeGray,
  };

  const { text: textColor, bg, border } = colorMap[variant];

  return (
    <View
      style={{
        backgroundColor: bg,
        borderWidth: 1,
        borderColor: border,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 4,
      }}
    >
      <Text color={textColor} fontSize={11} fontFamily={FONT_MONO} fontWeight="500">
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
  const c = useColors();
  const colors = makePalette(c);
  const alreadySet = !!(field.isSet && !field.value);
  const [editing, setEditing] = useState(!alreadySet);
  const [showValue, setShowValue] = useState(false);
  const [localValue, setLocalValue] = useState(field.value || '');
  const [isFocused, setIsFocused] = useState(false);

  const isPassword = field.type === 'password';
  const displayLabel = field.label || field.name;
  const isConfigured = alreadySet || !!localValue;

  const handleChange = (text: string) => {
    setLocalValue(text);
    onChange(text);
  };

  return (
    <View style={{ marginBottom: 16 }}>
      {/* Label row */}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <Text fontFamily={FONT_SANS} fontSize={12} color={colors.textSecondary} fontWeight="500">
          {displayLabel}
        </Text>
        {field.required && !isConfigured ? (
          <Text fontFamily={FONT_SANS} fontSize={10} color={colors.error} fontWeight="500">
            requerido
          </Text>
        ) : !field.required ? (
          <Text fontFamily={FONT_SANS} fontSize={10} color={colors.textMuted}>
            opcional
          </Text>
        ) : null}
      </View>

      {/* Configured state — collapsed */}
      {isConfigured && !editing ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingVertical: 10,
            paddingHorizontal: 12,
            backgroundColor: colors.inputBg,
            borderWidth: 1,
            borderColor: colors.badgeGreen.border,
            borderRadius: 6,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Check size={13} color={colors.ready} />
            <Text fontSize={13} color={colors.ready} fontFamily={FONT_MONO}>
              {'•'.repeat(16)}
            </Text>
          </View>
          <TouchableOpacity
            onPress={() => setEditing(true)}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              paddingHorizontal: 8,
              paddingVertical: 4,
              borderRadius: 4,
              backgroundColor: c.bgCardHover,
            }}
          >
            <Pencil size={11} color={colors.textMuted} />
            <Text fontFamily={FONT_SANS} fontSize={11} color={colors.textMuted}>
              Cambiar
            </Text>
          </TouchableOpacity>
        </View>
      ) : (
        /* Edit state — full input */
        <View style={{ position: 'relative' }}>
          <TextInput
            value={localValue}
            onChangeText={handleChange}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            placeholder={field.placeholder}
            placeholderTextColor={colors.textMuted}
            secureTextEntry={isPassword && !showValue}
            autoFocus={alreadySet}
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
              fontFamily: FONT_MONO,
            }}
          />
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
                  backgroundColor: c.bgCardHover,
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
            {alreadySet && (
              <TouchableOpacity
                onPress={() => { setEditing(false); setLocalValue(''); onChange(''); }}
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 4,
                  backgroundColor: c.bgCardHover,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <X size={14} color={colors.textMuted} />
              </TouchableOpacity>
            )}
          </View>
        </View>
      )}

      {/* Hint */}
      {field.hint && (
        <Text fontFamily={FONT_SANS} fontSize={11} color={colors.textMuted} style={{ marginTop: 6, lineHeight: 16 }}>
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
  const c = useColors();
  const colors = makePalette(c);
  const isConnected = oauth.status === 'connected';
  const isExpired = oauth.status === 'expired';
  const isError = oauth.status === 'error';
  const needsConnect = oauth.status === 'disconnected';
  const isGitHubApp = oauth.authType === 'github-app';
  const isLegacyOAuth = oauth.legacyOAuth === true;

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
  const sectionTitle = isGitHubApp ? 'GitHub' : 'OAuth connection';
  const connectVerb = 'Connect';
  const disconnectVerb = 'Disconnect';

  return (
    <View style={{ padding: 16, borderBottomWidth: 1, borderBottomColor: colors.border }}>
      {/* Subsection header */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <Text
          fontFamily={FONT_SANS}
          fontSize={12}
          fontWeight="600"
          color={colors.textMuted}
          style={{ textTransform: 'uppercase', letterSpacing: 0.5 }}
        >
          {sectionTitle}
        </Text>
        <Badge text={badge.text} variant={badge.variant} />
      </View>

      {/* Legacy OAuth migration banner — shown only for github-app MCAs that
          still hold an ACCESS_TOKEN from the pre-v4 era. */}
      {isGitHubApp && isLegacyOAuth && (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: 10,
            padding: 12,
            backgroundColor: colors.badgeYellow.bg,
            borderRadius: 6,
            marginBottom: 12,
          }}
        >
          <AlertCircle size={16} color={colors.badgeYellow.text} />
          <Text
            flex={1}
            fontFamily={FONT_SANS}
            fontSize={13}
            color={colors.badgeYellow.text}
            style={{ lineHeight: 20 }}
          >
            Tu conexión OAuth está deprecada. Instala la Teros App una sola vez para seguir
            usando esta integración — tus repos siguen siendo los mismos.
          </Text>
        </View>
      )}

      {/* Info message for non-connected states */}
      {(needsConnect || isExpired || isError) && (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: 10,
            padding: 12,
            backgroundColor: isError
              ? colors.badgeRed.bg
              : isExpired
                ? colors.badgeYellow.bg
                : colors.badgeBlue.bg,
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
            fontFamily={FONT_SANS}
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
                ? 'Tu sesión ha caducado. Reconecta tu cuenta para continuar.'
                : isGitHubApp
                  ? 'Conecta tu cuenta de GitHub. Tras autorizar, podrás añadir tu cuenta personal u otras organizaciones para dar acceso a sus repos. Las acciones (commits, PRs, comments) aparecerán firmadas con tu identidad.'
                  : `Conecta tu cuenta de ${oauth.provider} para que el agente pueda acceder a este servicio.`}
          </Text>
        </View>
      )}

      {/* Connected account card */}
      {(() => {
        // Identidad mostrada: prioriza @login (GitHub user OAuth) sobre email.
        const primary = oauth.userLogin
          ? `@${oauth.userLogin}`
          : oauth.email ?? '';
        const secondary = oauth.userLogin && oauth.email ? oauth.email : null;
        if (!(isConnected || isExpired) || !primary) return null;
        return (
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
                backgroundColor: isExpired ? colors.badgeYellow.bg : colors.badgeBlue.bg,
                borderWidth: 1,
                borderColor: isExpired ? colors.badgeYellow.border : colors.badgeBlue.border,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text
                fontFamily={FONT_SANS}
                fontSize={14}
                fontWeight="600"
                color={isExpired ? colors.badgeYellow.text : colors.badgeBlue.text}
              >
                {(oauth.userLogin?.charAt(0) ?? oauth.email?.charAt(0) ?? '?').toUpperCase()}
              </Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text fontFamily={FONT_SANS} fontSize={14} color={colors.textBright}>
                {primary}
              </Text>
              <Text
                fontFamily={FONT_SANS}
                fontSize={12}
                color={isExpired ? colors.badgeYellow.text : colors.textMuted}
                style={{ marginTop: 2 }}
              >
                {isExpired
                  ? 'Sesión caducada — reconecta tu cuenta'
                  : secondary ?? oauth.provider ?? 'Conectado'}
              </Text>
            </View>
          </View>
        );
      })()}

      {/* GitHub App: secondary panel with "add account / configure repos" link.
          Renders only when connected — sin esto el user no tiene forma de instalar
          la App en su cuenta personal o gestionar los repos accesibles, lo que
          confunde después del primer "Conectar". */}
      {isConnected && isGitHubApp && oauth.appSlug && (
        <View
          style={{
            padding: 12,
            backgroundColor: colors.badgeBlue.bg,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: colors.badgeBlue.border,
            marginBottom: 12,
          }}
        >
          <Text fontFamily={FONT_SANS} fontSize={12} color={colors.textMuted} style={{ marginBottom: 8, lineHeight: 18 }}>
            ¿No ves todos tus repos? La Teros App debe estar instalada en cada cuenta u
            organización cuyos repos quieras usar. Añadir o configurar instalaciones se hace
            en GitHub.
          </Text>
          <TouchableOpacity
            onPress={() =>
              Linking.openURL(
                `https://github.com/apps/${oauth.appSlug}/installations/select_target`,
              )
            }
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              padding: 10,
              backgroundColor: colors.btnGhost.bg,
              borderRadius: 6,
              borderWidth: 1,
              borderColor: colors.btnGhost.border,
            }}
          >
            <FolderPlus size={14} color={colors.btnGhost.text} />
            <Text fontFamily={FONT_SANS} fontSize={13} fontWeight="500" color={colors.btnGhost.text}>
              Añadir cuenta o configurar repos en GitHub
            </Text>
            <ExternalLink size={12} color={colors.textMuted} />
          </TouchableOpacity>
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
              <Text fontFamily={FONT_SANS} fontSize={13} fontWeight="500" color={colors.btnGhost.text}>
                Refrescar
              </Text>
            </TouchableOpacity>
          )}
          {/* GitHub App: link externo para gestionar la installation actual del user
              en GitHub. NO desconecta — eso es el botón rojo de abajo. Antes había
              un solo botón "Manage on GitHub" que decía manage pero hacía disconnect:
              copy y acción no coincidían y el user perdía el token al clicar. */}
          {isGitHubApp && oauth.installationId && (
            <TouchableOpacity
              onPress={() =>
                Linking.openURL(
                  `https://github.com/settings/installations/${oauth.installationId}`,
                )
              }
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
              <ExternalLink size={14} color={colors.btnGhost.text} />
              <Text fontFamily={FONT_SANS} fontSize={13} fontWeight="500" color={colors.btnGhost.text}>
                Gestionar en GitHub
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
                  <Text fontFamily={FONT_SANS} fontSize={13} fontWeight="500" color={colors.btnDanger.text}>
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
              ? colors.btnWarning.bg
              : colors.btnPrimary.bg,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: isExpired ? colors.btnWarning.border : colors.btnPrimary.border,
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
                fontFamily={FONT_SANS}
                fontSize={13}
                fontWeight="500"
                color={isExpired ? colors.badgeYellow.text : colors.btnPrimary.text}
              >
                {isExpired
                  ? isGitHubApp
                    ? 'Reconectar GitHub'
                    : 'Reconectar'
                  : isGitHubApp
                    ? 'Conectar con GitHub'
                    : `Conectar con ${oauth.provider}`}
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
  const colors = makePalette(useColors());
  if (credentials.length === 0) return null;

  return (
    <View style={{ padding: 16 }}>
      {/* Subsection header */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <Text
          fontFamily={FONT_SANS}
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
  const colors = makePalette(useColors());
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: 12,
        paddingHorizontal: 16,
        backgroundColor: colors.badgeBlue.bg,
        borderTopWidth: 1,
        borderTopColor: colors.badgeBlue.border,
      }}
    >
      <Text fontFamily={FONT_SANS} fontSize={12} color={colors.badgeBlue.text}>
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
          <Text fontFamily={FONT_SANS} fontSize={13} fontWeight="500" color={colors.btnPrimary.text}>
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
  systemSetupMessage,
}: AuthPanelProps) {
  const colors = makePalette(useColors());
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
    if (systemSetupMessage) return 'warning';
    if (oauth) {
      if (oauth.status === 'connected') return 'ready';
      if (oauth.status === 'disconnected') return 'pending';
      if (oauth.status === 'expired') return 'warning';
      if (oauth.status === 'error') return 'error';
    }
    const requiredMissing = credentials.some((c) => c.required && !c.isSet && !c.value);
    if (requiredMissing) return 'pending';
    return 'ready';
  };

  // Determine badge text
  const getBadge = (): { text: string; variant: BadgeProps['variant'] } => {
    if (systemSetupMessage) return { text: 'admin requerido', variant: 'yellow' };

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
        <Text flex={1} fontFamily={FONT_SANS} fontSize={14} fontWeight="500" color={colors.textPrimary}>
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
          {/* System setup warning */}
          {systemSetupMessage && (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'flex-start',
                gap: 10,
                padding: 12,
                margin: 12,
                backgroundColor: indicators.risk.bg,
                borderRadius: 6,
                borderWidth: 1,
                borderColor: indicators.risk.border,
              }}
            >
              <AlertCircle size={15} color={colors.badgeYellow.text} style={{ marginTop: 1 }} />
              <Text flex={1} fontFamily={FONT_SANS} fontSize={12} color={colors.badgeYellow.text} style={{ lineHeight: 18 }}>
                {systemSetupMessage}
              </Text>
            </View>
          )}

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
