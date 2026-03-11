/**
 * AppConfigPanel Component
 *
 * Unified configuration panel for an installed app.
 * Displays two collapsible sections:
 * 1. Authentication - OAuth/API Key status and actions
 * 2. Permissions - Tool-level permission controls (allow/ask/forbid)
 *
 * Design follows Teros renderer style with:
 * - Status dots with glow effect
 * - Compact badges
 * - Triple toggle for permissions
 * - Collapsible sections
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
import { Text, XStack, YStack } from 'tamagui';
import type { AppAuthInfo, AppCredentialStatus } from './AppAuthBadge';
import { usePulseAnimation } from '../../hooks/usePulseAnimation';
import { AppSpinner } from '../../components/ui';

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
// Colors
// ============================================================================

const colors = {
  // Status dot colors
  ready: '#22c55e',
  pending: '#3b82f6',
  warning: '#f59e0b',
  error: '#ef4444',

  // Status glow
  glowReady: 'rgba(34, 197, 94, 0.5)',
  glowPending: 'rgba(59, 130, 246, 0.5)',
  glowWarning: 'rgba(245, 158, 11, 0.5)',
  glowError: 'rgba(239, 68, 68, 0.5)',

  // Section icons
  iconKey: '#a855f7',
  iconShield: '#06b6d4',

  // Permission colors
  allow: '#86efac',
  allowBg: 'rgba(34, 197, 94, 0.2)',
  ask: '#fcd34d',
  askBg: 'rgba(251, 191, 36, 0.2)',
  forbid: '#fca5a5',
  forbidBg: 'rgba(239, 68, 68, 0.2)',

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
  toggleBg: 'rgba(0, 0, 0, 0.3)',

  // Borders
  border: 'rgba(255, 255, 255, 0.04)',

  // Buttons
  btnDanger: { bg: 'rgba(239, 68, 68, 0.1)', text: '#fca5a5', border: 'rgba(239, 68, 68, 0.15)' },
  btnPrimary: {
    bg: 'rgba(59, 130, 246, 0.1)',
    text: '#93c5fd',
    border: 'rgba(59, 130, 246, 0.15)',
  },
  btnWarning: {
    bg: 'rgba(251, 191, 36, 0.1)',
    text: '#fcd34d',
    border: 'rgba(251, 191, 36, 0.15)',
  },

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
        borderBottomColor: colors.border,
      }}
    >
      <StatusDot status={status} />
      {icon}
      <Text flex={1} fontSize={14} fontWeight="500" color={colors.textPrimary}>
        {label}
      </Text>
      {loading ? (
        <AppSpinner size="sm" variant="muted" />
      ) : badge ? (
        <Badge text={badge.text} variant={badge.variant} />
      ) : null}
      <Animated.View style={{ transform: [{ rotate: rotation }] }}>
        <ChevronRight size={14} color={colors.chevron} />
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
  const options: {
    key: ToolPermission;
    icon: React.ReactNode;
    activeColor: string;
    activeBg: string;
  }[] = [
    {
      key: 'allow',
      icon: <Check size={12} color={value === 'allow' ? colors.allow : colors.textMuted} />,
      activeColor: colors.allow,
      activeBg: colors.allowBg,
    },
    {
      key: 'ask',
      icon: <User size={12} color={value === 'ask' ? colors.ask : colors.textMuted} />,
      activeColor: colors.ask,
      activeBg: colors.askBg,
    },
    {
      key: 'forbid',
      icon: <X size={12} color={value === 'forbid' ? colors.forbid : colors.textMuted} />,
      activeColor: colors.forbid,
      activeBg: colors.forbidBg,
    },
  ];

  return (
    <View
      style={{
        flexDirection: 'row',
        backgroundColor: colors.toggleBg,
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
  const buttons: {
    key: ToolPermission;
    icon: React.ReactNode;
    hoverBg: string;
    hoverColor: string;
  }[] = [
    {
      key: 'allow',
      icon: <Check size={12} color={colors.textMuted} />,
      hoverBg: 'rgba(34, 197, 94, 0.15)',
      hoverColor: colors.allow,
    },
    {
      key: 'ask',
      icon: <User size={12} color={colors.textMuted} />,
      hoverBg: 'rgba(251, 191, 36, 0.15)',
      hoverColor: colors.ask,
    },
    {
      key: 'forbid',
      icon: <X size={12} color={colors.textMuted} />,
      hoverBg: 'rgba(239, 68, 68, 0.15)',
      hoverColor: colors.forbid,
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
            backgroundColor: 'rgba(255, 255, 255, 0.04)',
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
    <View style={{ padding: 16, backgroundColor: colors.sectionBg }}>
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
                ? 'rgba(251, 191, 36, 0.08)'
                : message.variant === 'error'
                  ? 'rgba(239, 68, 68, 0.08)'
                  : 'rgba(59, 130, 246, 0.08)',
            borderRadius: 6,
            marginBottom: 12,
          }}
        >
          <Info
            size={16}
            color={
              message.variant === 'warning'
                ? colors.ask
                : message.variant === 'error'
                  ? colors.forbid
                  : colors.badgeBlue.text
            }
          />
          <Text
            flex={1}
            fontSize={13}
            color={
              message.variant === 'warning'
                ? colors.ask
                : message.variant === 'error'
                  ? colors.forbid
                  : colors.badgeBlue.text
            }
            style={{ lineHeight: 20 }}
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
            <Text fontSize={14} fontWeight="600" color={isExpired ? colors.ask : '#06b6d4'}>
              {authInfo.oauth.email.charAt(0).toUpperCase()}
            </Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text fontSize={14} color={colors.textBright}>
              {authInfo.oauth.email}
            </Text>
            <Text fontSize={12} color={isExpired ? colors.ask : colors.textMuted} marginTop={2}>
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
            backgroundColor: isExpired ? colors.btnWarning.bg : colors.btnPrimary.bg,
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
              <Link size={14} color={isExpired ? colors.btnWarning.text : colors.btnPrimary.text} />
              <Text
                fontSize={13}
                fontWeight="500"
                color={isExpired ? colors.btnWarning.text : colors.btnPrimary.text}
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
  return (
    <View style={{ backgroundColor: colors.sectionBg }}>
      {/* Summary bar */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: 12,
          paddingHorizontal: 16,
          backgroundColor: colors.cardBg,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
            <Check size={12} color={colors.allow} />
            <Text fontSize={12} fontFamily="$mono" color={colors.allow}>
              {data.summary.allow}
            </Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
            <User size={12} color={colors.ask} />
            <Text fontSize={12} fontFamily="$mono" color={colors.ask}>
              {data.summary.ask}
            </Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
            <X size={12} color={colors.forbid} />
            <Text fontSize={12} fontFamily="$mono" color={colors.forbid}>
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
                borderBottomColor: colors.border,
              }}
            >
              <Text fontSize={13} fontFamily="$mono" color={colors.textSecondary}>
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
          borderTopColor: colors.border,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <Check size={10} color={colors.textMuted} />
          <Text fontSize={11} color={colors.textMuted}>
            Auto
          </Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <User size={10} color={colors.textMuted} />
          <Text fontSize={11} color={colors.textMuted}>
            Confirmar
          </Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <X size={10} color={colors.textMuted} />
          <Text fontSize={11} color={colors.textMuted}>
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
        backgroundColor: colors.panelBg,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: colors.border,
        overflow: 'hidden',
      }}
    >
      {/* Auth Section */}
      {authInfo && (
        <>
          <SectionRow
            status={getAuthStatus()}
            icon={<Key size={18} color={colors.iconKey} />}
            label="Authentication"
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
            icon={<Shield size={18} color={colors.iconShield} />}
            label="Permisos"
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
          <Text color={colors.textMuted} fontSize={13} marginTop={8}>
            Loading configuration...
          </Text>
        </View>
      )}
    </View>
  );
}

export default AppConfigPanel;
