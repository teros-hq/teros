/**
 * AppConfigPanel Component
 *
 * Unified configuration panel for an installed app.
 * Displays two collapsible sections:
 * 1. Authentication - OAuth/API Key status and actions
 * 2. Permissions - Tool-level permission controls (allow/ask/forbid)
 *
 * Migrated to the Design System:
 * - Uses `useColors()` for theme-adaptive surface/border/badge tokens.
 * - Uses `semanticColors` for status accents and permission tints.
 * - Uses Tamagui font tokens (`$body`, `$mono`).
 */

import {
  AlertTriangle,
  Check,
  ChevronRight,
  Clock,
  Info,
  Key,
  Link,
  Shield,
  Unlink,
  User,
  X,
} from '@tamagui/lucide-icons';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  ScrollView,
  TouchableOpacity,
  View,
} from 'react-native';
import { Text, XStack, YStack, useThemeName } from 'tamagui';
import { useTranslation } from 'react-i18next';
import type { AppAuthInfo } from './AppAuthBadge';
import { usePulseAnimation } from '../../hooks/usePulseAnimation';
import { AppSpinner } from '../../components/ui';
import {
  badges,
  colors as semanticColors,
  surface,
  type Theme,
} from '../mca/primitives/colors';
import { useColors } from '../mca/primitives/useColors';

// ============================================================================
// Types
// ============================================================================

export type ToolPermission = 'allow' | 'ask' | 'forbid';

export interface ToolWithPermission {
  name: string;
  permission: ToolPermission;
}

export interface AppPermissionsData {
  appId: string;
  defaultPermission: ToolPermission;
  tools: ToolWithPermission[];
  summary: {
    allow: number;
    ask: number;
    forbid: number;
  };
}

export interface AppConfigPanelProps {
  /** Auth info for the app */
  authInfo?: AppAuthInfo | null;
  /** Permissions data */
  permissionsData?: AppPermissionsData | null;
  /** Loading states */
  loadingAuth?: boolean;
  loadingPermissions?: boolean;
  /** Action states */
  connecting?: boolean;
  disconnecting?: boolean;
  savingPermissions?: boolean;
  /** Auth callbacks */
  onConnect?: () => void;
  onDisconnect?: () => void;
  /** Permission callbacks */
  onToolPermissionChange?: (toolName: string, permission: ToolPermission) => void;
  onSetAllPermissions?: (permission: ToolPermission) => void;
  /** Initial expanded state */
  defaultAuthExpanded?: boolean;
  defaultPermsExpanded?: boolean;
}

// ============================================================================
// Helpers
// ============================================================================

function useAppTheme(): Theme {
  const name = useThemeName();
  return typeof name === 'string' && name.startsWith('light') ? 'light' : 'dark';
}

// Permission tints derived from the semantic palette.
function getPermissionColors() {
  return {
    allow: semanticColors.green,
    allowBg: 'rgba(34, 197, 94, 0.2)',
    ask: semanticColors.amber,
    askBg: 'rgba(245, 158, 11, 0.2)',
    forbid: semanticColors.red,
    forbidBg: 'rgba(239, 68, 68, 0.2)',
  };
}

// ============================================================================
// Status Dot Component
// ============================================================================

interface StatusDotProps {
  status: 'ready' | 'pending' | 'warning' | 'error';
}

function StatusDot({ status }: StatusDotProps) {
  const colorMap = {
    ready: { color: semanticColors.green, glow: 'rgba(34, 197, 94, 0.5)' },
    pending: { color: semanticColors.indigo, glow: 'rgba(94, 106, 210, 0.5)' },
    warning: { color: semanticColors.amber, glow: 'rgba(245, 158, 11, 0.5)' },
    error: { color: semanticColors.red, glow: 'rgba(239, 68, 68, 0.5)' },
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
  const theme = useAppTheme();
  const paletteKey =
    variant === 'green'
      ? 'ok'
      : variant === 'blue'
        ? 'info'
        : variant === 'yellow'
          ? 'warn'
          : variant === 'red'
            ? 'err'
            : 'gray';
  const palette = badges[theme][paletteKey];

  return (
    <View
      style={{
        backgroundColor: palette.bg,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 4,
        borderWidth: 1,
        borderColor: palette.border,
      }}
    >
      <Text color={palette.text} fontSize={11} fontFamily="$mono" fontWeight="500">
        {text}
      </Text>
    </View>
  );
}

// ============================================================================
// Section Row Component
// ============================================================================

interface SectionRowProps {
  status: 'ready' | 'pending' | 'warning' | 'error';
  icon: React.ReactNode;
  label: string;
  badge?: { text: string; variant: BadgeProps['variant'] };
  expanded: boolean;
  onToggle: () => void;
  loading?: boolean;
}

function SectionRow({ status, icon, label, badge, expanded, onToggle, loading }: SectionRowProps) {
  const c = useColors();
  const rotateAnim = useRef(new Animated.Value(expanded ? 1 : 0)).current;

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

  return (
    <TouchableOpacity
      onPress={onToggle}
      activeOpacity={0.7}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingVertical: 14,
        paddingHorizontal: 16,
        borderBottomWidth: 1,
        borderBottomColor: c.border,
      }}
    >
      <StatusDot status={status} />
      {icon}
      <Text flex={1} fontSize={14} fontWeight="500" color={c.text} fontFamily="$body">
        {label}
      </Text>
      {loading ? (
        <AppSpinner size="sm" variant="muted" />
      ) : badge ? (
        <Badge text={badge.text} variant={badge.variant} />
      ) : null}
      <Animated.View style={{ transform: [{ rotate: rotation }] }}>
        <ChevronRight size={14} color={c.text3} />
      </Animated.View>
    </TouchableOpacity>
  );
}

// ============================================================================
// Triple Toggle Component
// ============================================================================

interface TripleToggleProps {
  value: ToolPermission;
  onChange: (value: ToolPermission) => void;
  disabled?: boolean;
}

function TripleToggle({ value, onChange, disabled }: TripleToggleProps) {
  const c = useColors();
  const permColors = getPermissionColors();

  const options: {
    key: ToolPermission;
    icon: React.ReactNode;
    activeColor: string;
    activeBg: string;
  }[] = [
    {
      key: 'allow',
      icon: <Check size={12} color={value === 'allow' ? permColors.allow : c.text3} />,
      activeColor: permColors.allow,
      activeBg: permColors.allowBg,
    },
    {
      key: 'ask',
      icon: <User size={12} color={value === 'ask' ? permColors.ask : c.text3} />,
      activeColor: permColors.ask,
      activeBg: permColors.askBg,
    },
    {
      key: 'forbid',
      icon: <X size={12} color={value === 'forbid' ? permColors.forbid : c.text3} />,
      activeColor: permColors.forbid,
      activeBg: permColors.forbidBg,
    },
  ];

  return (
    <View
      style={{
        flexDirection: 'row',
        backgroundColor: c.bgInner,
        borderRadius: 6,
        padding: 3,
      }}
    >
      {options.map((opt) => (
        <TouchableOpacity
          key={opt.key}
          onPress={() => !disabled && onChange(opt.key)}
          activeOpacity={0.7}
          disabled={disabled}
          style={{
            width: 32,
            height: 26,
            borderRadius: 4,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: value === opt.key ? opt.activeBg : 'transparent',
            opacity: disabled ? 0.5 : 1,
          }}
        >
          {opt.icon}
        </TouchableOpacity>
      ))}
    </View>
  );
}

// ============================================================================
// Bulk Action Buttons
// ============================================================================

interface BulkActionsProps {
  onSetAll: (permission: ToolPermission) => void;
  disabled?: boolean;
}

function BulkActions({ onSetAll, disabled }: BulkActionsProps) {
  const c = useColors();
  const permColors = getPermissionColors();

  const buttons: {
    key: ToolPermission;
    icon: React.ReactNode;
    hoverBg: string;
    hoverColor: string;
  }[] = [
    {
      key: 'allow',
      icon: <Check size={12} color={c.text3} />,
      hoverBg: 'rgba(34, 197, 94, 0.15)',
      hoverColor: permColors.allow,
    },
    {
      key: 'ask',
      icon: <User size={12} color={c.text3} />,
      hoverBg: 'rgba(245, 158, 11, 0.15)',
      hoverColor: permColors.ask,
    },
    {
      key: 'forbid',
      icon: <X size={12} color={c.text3} />,
      hoverBg: 'rgba(239, 68, 68, 0.15)',
      hoverColor: permColors.forbid,
    },
  ];

  return (
    <View style={{ flexDirection: 'row', gap: 4 }}>
      {buttons.map((btn) => (
        <TouchableOpacity
          key={btn.key}
          onPress={() => !disabled && onSetAll(btn.key)}
          activeOpacity={0.7}
          disabled={disabled}
          style={{
            width: 28,
            height: 28,
            borderRadius: 6,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: c.border,
            opacity: disabled ? 0.5 : 1,
          }}
        >
          {btn.icon}
        </TouchableOpacity>
      ))}
    </View>
  );
}

// ============================================================================
// Auth Section Content
// ============================================================================

interface AuthSectionProps {
  authInfo: AppAuthInfo;
  onConnect?: () => void;
  onDisconnect?: () => void;
  connecting?: boolean;
  disconnecting?: boolean;
}

function AuthSectionContent({
  authInfo,
  onConnect,
  onDisconnect,
  connecting,
  disconnecting,
}: AuthSectionProps) {
  const c = useColors();
  const theme = useAppTheme();
  const isConnected =
    authInfo.status === 'ready' && authInfo.authType === 'oauth2' && authInfo.oauth?.connected;
  const needsConnect = authInfo.status === 'needs_user_auth';
  const isExpired = authInfo.status === 'expired';
  const isError = authInfo.status === 'error';
  const needsSystemSetup = authInfo.status === 'needs_system_setup';

  // Info message
  const getMessage = () => {
    if (needsConnect) {
      return {
        text: 'Conecta tu cuenta para que el agente pueda acceder a este servicio.',
        variant: 'info' as const,
      };
    }
    if (isExpired) {
      return {
        text: 'Your session has expired. Reconnect to continue.',
        variant: 'warning' as const,
      };
    }
    if (isError) {
      return {
        text: authInfo.error || 'Error al validar credenciales.',
        variant: 'error' as const,
      };
    }
    if (needsSystemSetup) {
      return {
        text: 'This app requires administrator configuration.',
        variant: 'warning' as const,
      };
    }
    return null;
  };

  const message = getMessage();

  return (
    <View style={{ padding: 16, backgroundColor: c.bgInner }}>
      {/* Info/Warning message */}
      {message && (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: 10,
            padding: 12,
            backgroundColor:
              message.variant === 'warning'
                ? badges[theme].warn.bg
                : message.variant === 'error'
                  ? badges[theme].err.bg
                  : badges[theme].info.bg,
            borderRadius: 6,
            marginBottom: 12,
            borderWidth: 1,
            borderColor:
              message.variant === 'warning'
                ? badges[theme].warn.border
                : message.variant === 'error'
                  ? badges[theme].err.border
                  : badges[theme].info.border,
          }}
        >
          <Info
            size={16}
            color={
              message.variant === 'warning'
                ? badges[theme].warn.text
                : message.variant === 'error'
                  ? badges[theme].err.text
                  : badges[theme].info.text
            }
          />
          <Text
            flex={1}
            fontSize={13}
            color={
              message.variant === 'warning'
                ? badges[theme].warn.text
                : message.variant === 'error'
                  ? badges[theme].err.text
                  : badges[theme].info.text
            }
            style={{ lineHeight: 20 }}
            fontFamily="$body"
          >
            {message.text}
          </Text>
        </View>
      )}

      {/* Connected account card */}
      {(isConnected || isExpired) && authInfo.oauth?.email && (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            padding: 12,
            backgroundColor: c.bgCard,
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
              backgroundColor: isExpired ? badges[theme].warn.bg : surface[theme].bgInner,
              borderWidth: 1,
              borderColor: isExpired ? badges[theme].warn.border : c.borderStrong,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text
              fontSize={14}
              fontWeight="600"
              color={isExpired ? badges[theme].warn.text : c.text}
              fontFamily="$body"
            >
              {authInfo.oauth.email.charAt(0).toUpperCase()}
            </Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text fontSize={14} color={c.text} fontFamily="$body">
              {authInfo.oauth.email}
            </Text>
            <Text fontSize={12} color={isExpired ? badges[theme].warn.text : c.text3} marginTop={2} fontFamily="$body">
              {isExpired
                ? `Expired ${authInfo.oauth.expiresAt ? new Date(authInfo.oauth.expiresAt).toLocaleDateString() : ''}`
                : authInfo.oauth.expiresAt
                  ? `Expira ${new Date(authInfo.oauth.expiresAt).toLocaleDateString()}`
                  : 'OAuth 2.0'}
            </Text>
          </View>
        </View>
      )}

      {/* Action buttons */}
      {isConnected && onDisconnect && (
        <TouchableOpacity
          onPress={onDisconnect}
          disabled={disconnecting}
          activeOpacity={0.7}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            padding: 12,
            backgroundColor: badges[theme].err.bg,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: badges[theme].err.border,
            opacity: disconnecting ? 0.6 : 1,
          }}
        >
          {disconnecting ? (
            <AppSpinner size="sm" variant="danger" />
          ) : (
            <>
              <Unlink size={14} color={badges[theme].err.text} />
              <Text fontSize={13} fontWeight="500" color={badges[theme].err.text} fontFamily="$body">
                Desconectar
              </Text>
            </>
          )}
        </TouchableOpacity>
      )}

      {(needsConnect || isExpired || isError) && onConnect && !needsSystemSetup && (
        <TouchableOpacity
          onPress={onConnect}
          disabled={connecting}
          activeOpacity={0.7}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            padding: 12,
            backgroundColor: isExpired ? badges[theme].warn.bg : badges[theme].info.bg,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: isExpired ? badges[theme].warn.border : badges[theme].info.border,
            opacity: connecting ? 0.6 : 1,
          }}
        >
          {connecting ? (
            <AppSpinner size="sm" />
          ) : (
            <>
              <Link
                size={14}
                color={isExpired ? badges[theme].warn.text : badges[theme].info.text}
              />
              <Text
                fontSize={13}
                fontWeight="500"
                color={isExpired ? badges[theme].warn.text : badges[theme].info.text}
                fontFamily="$body"
              >
                {isExpired
                  ? 'Reconectar'
                  : authInfo.oauth?.provider
                    ? `Conectar con ${authInfo.oauth.provider}`
                    : 'Conectar'}
              </Text>
            </>
          )}
        </TouchableOpacity>
      )}
    </View>
  );
}

// ============================================================================
// Permissions Section Content
// ============================================================================

interface PermsSectionProps {
  data: AppPermissionsData;
  onToolPermissionChange?: (toolName: string, permission: ToolPermission) => void;
  onSetAllPermissions?: (permission: ToolPermission) => void;
  saving?: boolean;
}

function PermsSectionContent({
  data,
  onToolPermissionChange,
  onSetAllPermissions,
  saving,
}: PermsSectionProps) {
  const c = useColors();
  const permColors = getPermissionColors();

  return (
    <View style={{ backgroundColor: c.bgInner }}>
      {/* Summary bar */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: 12,
          paddingHorizontal: 16,
          backgroundColor: c.bgCard,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
            <Check size={12} color={permColors.allow} />
            <Text fontSize={12} fontFamily="$mono" color={permColors.allow}>
              {data.summary.allow}
            </Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
            <User size={12} color={permColors.ask} />
            <Text fontSize={12} fontFamily="$mono" color={permColors.ask}>
              {data.summary.ask}
            </Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
            <X size={12} color={permColors.forbid} />
            <Text fontSize={12} fontFamily="$mono" color={permColors.forbid}>
              {data.summary.forbid}
            </Text>
          </View>
        </View>
        <BulkActions
          onSetAll={onSetAllPermissions || (() => {})}
          disabled={saving || !onSetAllPermissions}
        />
      </View>

      {/* Tools list */}
      <ScrollView style={{ maxHeight: 300 }}>
        <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
          {data.tools.map((tool, index) => (
            <View
              key={tool.name}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingVertical: 10,
                borderBottomWidth: index < data.tools.length - 1 ? 1 : 0,
                borderBottomColor: c.border,
              }}
            >
              <Text fontSize={13} fontFamily="$mono" color={c.text2}>
                {tool.name}
              </Text>
              <TripleToggle
                value={tool.permission}
                onChange={(perm) => onToolPermissionChange?.(tool.name, perm)}
                disabled={saving || !onToolPermissionChange}
              />
            </View>
          ))}
        </View>
      </ScrollView>

      {/* Legend */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 16,
          padding: 12,
          paddingHorizontal: 16,
          borderTopWidth: 1,
          borderTopColor: c.border,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <Check size={10} color={c.text3} />
          <Text fontSize={11} color={c.text3} fontFamily="$body">
            Auto
          </Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <User size={10} color={c.text3} />
          <Text fontSize={11} color={c.text3} fontFamily="$body">
            Confirmar
          </Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <X size={10} color={c.text3} />
          <Text fontSize={11} color={c.text3} fontFamily="$body">
            Bloquear
          </Text>
        </View>
      </View>
    </View>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export function AppConfigPanel({
  authInfo,
  permissionsData,
  loadingAuth = false,
  loadingPermissions = false,
  connecting = false,
  disconnecting = false,
  savingPermissions = false,
  onConnect,
  onDisconnect,
  onToolPermissionChange,
  onSetAllPermissions,
  defaultAuthExpanded = true,
  defaultPermsExpanded = true,
}: AppConfigPanelProps) {
  const { t } = useTranslation();
  const c = useColors();
  const [authExpanded, setAuthExpanded] = useState(defaultAuthExpanded);
  const [permsExpanded, setPermsExpanded] = useState(defaultPermsExpanded);

  // Determine auth status for dot
  const getAuthStatus = (): 'ready' | 'pending' | 'warning' | 'error' => {
    if (!authInfo) return 'pending';
    switch (authInfo.status) {
      case 'ready':
      case 'not_required':
        return 'ready';
      case 'needs_user_auth':
        return 'pending';
      case 'expired':
      case 'needs_system_setup':
        return 'warning';
      case 'error':
        return 'error';
      default:
        return 'pending';
    }
  };

  // Determine auth badge
  const getAuthBadge = (): { text: string; variant: BadgeProps['variant'] } | undefined => {
    if (!authInfo) return undefined;
    switch (authInfo.status) {
      case 'ready':
        return {
          text:
            authInfo.authType === 'oauth2'
              ? 'OAuth'
              : authInfo.authType === 'apikey'
                ? 'API Key'
                : 'OK',
          variant: 'green',
        };
      case 'needs_user_auth':
        return { text: 'conectar', variant: 'blue' };
      case 'expired':
        return { text: 'expirada', variant: 'yellow' };
      case 'error':
        return { text: 'error', variant: 'red' };
      case 'needs_system_setup':
        return { text: 'config', variant: 'yellow' };
      case 'not_required':
        return { text: 'N/A', variant: 'gray' };
      default:
        return undefined;
    }
  };

  // Determine perms status
  const getPermsStatus = (): 'ready' | 'pending' | 'warning' | 'error' => {
    if (!permissionsData) return 'pending';
    return 'ready';
  };

  // Determine perms badge
  const getPermsBadge = (): { text: string; variant: BadgeProps['variant'] } | undefined => {
    if (!permissionsData) return undefined;
    const total =
      permissionsData.summary.allow + permissionsData.summary.ask + permissionsData.summary.forbid;
    return { text: `${total} tools`, variant: 'gray' };
  };

  return (
    <View
      style={{
        backgroundColor: c.bgCard,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: c.border,
        overflow: 'hidden',
      }}
    >
      {/* Auth Section */}
      {authInfo && (
        <>
          <SectionRow
            status={getAuthStatus()}
            icon={<Key size={18} color={semanticColors.violet} />}
            label={t('apps.authentication')}
            badge={getAuthBadge()}
            expanded={authExpanded}
            onToggle={() => setAuthExpanded(!authExpanded)}
            loading={loadingAuth}
          />
          {authExpanded && (
            <AuthSectionContent
              authInfo={authInfo}
              onConnect={onConnect}
              onDisconnect={onDisconnect}
              connecting={connecting}
              disconnecting={disconnecting}
            />
          )}
        </>
      )}

      {/* Permissions Section */}
      {permissionsData && (
        <>
          <SectionRow
            status={getPermsStatus()}
            icon={<Shield size={18} color={semanticColors.indigo} />}
            label={t('apps.permissions')}
            badge={getPermsBadge()}
            expanded={permsExpanded}
            onToggle={() => setPermsExpanded(!permsExpanded)}
            loading={loadingPermissions}
          />
          {permsExpanded && (
            <PermsSectionContent
              data={permissionsData}
              onToolPermissionChange={onToolPermissionChange}
              onSetAllPermissions={onSetAllPermissions}
              saving={savingPermissions}
            />
          )}
        </>
      )}

      {/* Loading state when no data */}
      {!authInfo && !permissionsData && (loadingAuth || loadingPermissions) && (
        <View style={{ padding: 24, alignItems: 'center' }}>
          <AppSpinner size="sm" variant="muted" />
          <Text color={c.text3} fontSize={13} marginTop={8} fontFamily="$body">
            Loading configuration...
          </Text>
        </View>
      )}
    </View>
  );
}

export default AppConfigPanel;
