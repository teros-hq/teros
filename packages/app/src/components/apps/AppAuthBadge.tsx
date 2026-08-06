/**
 * AppAuthBadge Component
 *
 * Shows the authentication status of an installed app with visual indicators.
 * Used in app cards and app detail pages.
 *
 * Migrated to the Design System:
 * - Uses `useColors()` for theme-adaptive surface/border tokens.
 * - Uses `semanticColors` for status accents (green, amber, indigo, red, gray).
 * - Uses Tamagui font tokens (`$body`, `$mono`).
 */

import {
  AlertCircle,
  AlertTriangle,
  Check,
  Clock,
  Link,
  LogIn,
  Unlink,
} from '@tamagui/lucide-icons';
import type React from 'react';
import { TouchableOpacity, View } from 'react-native';
import { Text, XStack, useThemeName } from 'tamagui';
import { AppSpinner } from '../../components/ui';
import {
  badges,
  colors as semanticColors,
  surface,
  type Theme,
} from '../mca/primitives/colors';
import { useColors } from '../mca/primitives/useColors';

export type AppCredentialStatus =
  | 'ready' // All credentials configured and valid
  | 'needs_system_setup' // System secrets missing (requires admin)
  | 'needs_user_auth' // User needs to authenticate
  | 'expired' // OAuth token expired
  | 'error' // Error validating credentials
  | 'not_required'; // MCA doesn't require credentials

export type McaAuthType = 'oauth2' | 'apikey' | 'none';

export interface AppAuthInfo {
  status: AppCredentialStatus;
  authType: McaAuthType;
  oauth?: {
    provider: string;
    connected: boolean;
    email?: string;
    expiresAt?: string;
    scopes?: string[];
  };
  apikey?: {
    configured: boolean;
    fields: Array<{
      name: string;
      label: string;
      type: 'text' | 'password';
      required: boolean;
      placeholder?: string;
    }>;
  };
  message?: string;
  error?: string;
}

interface AppAuthBadgeProps {
  /** Auth info for the app */
  authInfo?: AppAuthInfo | null;
  /** Loading state */
  loading?: boolean;
  /** Size variant */
  size?: 'small' | 'medium';
  /** Whether to show as actionable (clickable) */
  actionable?: boolean;
  /** Callback when badge is clicked */
  onPress?: () => void;
}

/**
 * Resolve a status to a Design System badge palette entry.
 */
function getStatusBadge(
  status: AppCredentialStatus,
  theme: Theme,
):
  | { palette: keyof typeof badges.dark; label: string; shortLabel: string; icon: React.ComponentType<{ size?: number; color?: string }> }
  | null {
  switch (status) {
    case 'ready':
      return { palette: 'ok', label: 'Conectada', shortLabel: 'OK', icon: Check };
    case 'needs_system_setup':
      return { palette: 'warn', label: 'Requires configuration', shortLabel: 'Config', icon: AlertTriangle };
    case 'needs_user_auth':
      return { palette: 'info', label: 'Conectar cuenta', shortLabel: 'Conectar', icon: LogIn };
    case 'expired':
      return { palette: 'warn', label: 'Session expired', shortLabel: 'Expirado', icon: Clock };
    case 'error':
      return { palette: 'err', label: 'Error', shortLabel: 'Error', icon: AlertCircle };
    case 'not_required':
      return { palette: 'gray', label: 'Not authenticated', shortLabel: 'N/A', icon: Check };
    default:
      return null;
  }
}

export function AppAuthBadge({
  authInfo,
  loading = false,
  size = 'small',
  actionable = false,
  onPress,
}: AppAuthBadgeProps) {
  const c = useColors();
  const themeName = useThemeName();
  const theme: Theme = typeof themeName === 'string' && themeName.startsWith('light') ? 'light' : 'dark';

  // If loading, show loading state
  if (loading) {
    return (
      <View
        style={{
          backgroundColor: c.badges.gray.bg,
          paddingHorizontal: size === 'small' ? 6 : 10,
          paddingVertical: size === 'small' ? 3 : 5,
          borderRadius: size === 'small' ? 4 : 6,
          borderWidth: 1,
          borderColor: c.badges.gray.border,
        }}
      >
        <AppSpinner size="sm" variant="muted" />
      </View>
    );
  }

  // If no auth info, don't render anything
  if (!authInfo) {
    return null;
  }

  const statusMeta = getStatusBadge(authInfo.status, theme) ?? getStatusBadge('error', theme)!;
  const badgePalette = badges[theme][statusMeta.palette];
  const IconComponent = statusMeta.icon;
  const label = size === 'small' ? statusMeta.shortLabel : statusMeta.label;

  // Determine if this should be clickable
  const isClickable =
    actionable &&
    (authInfo.status === 'needs_user_auth' ||
      authInfo.status === 'expired' ||
      (authInfo.status === 'ready' && authInfo.authType !== 'none'));

  const badgeContent = (
    <XStack
      alignItems="center"
      gap={size === 'small' ? 4 : 6}
      style={{
        backgroundColor: badgePalette.bg,
        paddingHorizontal: size === 'small' ? 6 : 10,
        paddingVertical: size === 'small' ? 3 : 5,
        borderRadius: size === 'small' ? 4 : 6,
        borderWidth: 1,
        borderColor: badgePalette.border,
      }}
    >
      <IconComponent size={size === 'small' ? 12 : 14} color={badgePalette.text} />
      <Text
        fontSize={size === 'small' ? 10 : 12}
        fontWeight="500"
        color={badgePalette.text}
        fontFamily="$body"
      >
        {label}
      </Text>
    </XStack>
  );

  if (isClickable && onPress) {
    return (
      <TouchableOpacity onPress={onPress} activeOpacity={0.7}>
        {badgeContent}
      </TouchableOpacity>
    );
  }

  return badgeContent;
}

/**
 * Detailed auth status display for app configuration page
 */
interface AppAuthStatusDetailProps {
  authInfo: AppAuthInfo;
  onConnect?: () => void;
  onDisconnect?: () => void;
  connecting?: boolean;
  disconnecting?: boolean;
}

export function AppAuthStatusDetail({
  authInfo,
  onConnect,
  onDisconnect,
  connecting = false,
  disconnecting = false,
}: AppAuthStatusDetailProps) {
  const c = useColors();
  const themeName = useThemeName();
  const theme: Theme = typeof themeName === 'string' && themeName.startsWith('light') ? 'light' : 'dark';

  const statusMeta = getStatusBadge(authInfo.status, theme) ?? getStatusBadge('error', theme)!;
  const badgePalette = badges[theme][statusMeta.palette];
  const IconComponent = statusMeta.icon;

  // For OAuth, show connected account info
  const isOAuth = authInfo.authType === 'oauth2';
  const isConnected = authInfo.status === 'ready' && isOAuth && authInfo.oauth?.connected;

  return (
    <View
      style={{
        backgroundColor: c.bgCard,
        borderRadius: 12,
        padding: 16,
        borderWidth: 1,
        borderColor: badgePalette.border,
      }}
    >
      {/* Status header */}
      <XStack alignItems="center" gap={8} marginBottom={12}>
        <View
          style={{
            width: 36,
            height: 36,
            borderRadius: 8,
            backgroundColor: badgePalette.bg,
            justifyContent: 'center',
            alignItems: 'center',
          }}
        >
          <IconComponent size={18} color={badgePalette.text} />
        </View>
        <View style={{ flex: 1 }}>
          <Text fontSize={14} fontWeight="600" color={c.text} fontFamily="$body">
            {authInfo.authType === 'oauth2'
              ? 'OAuth'
              : authInfo.authType === 'apikey'
                ? 'API Key'
                : 'Not authenticated'}
          </Text>
          <Text fontSize={12} color={badgePalette.text} fontFamily="$body">
            {statusMeta.label}
          </Text>
        </View>
        <AppAuthBadge authInfo={authInfo} size="medium" />
      </XStack>

      {/* OAuth connected account */}
      {isConnected && authInfo.oauth?.email && (
        <View
          style={{
            backgroundColor: surface[theme].bgInner,
            borderRadius: 8,
            padding: 12,
            marginBottom: 12,
          }}
        >
          <XStack alignItems="center" gap={8}>
            <Link size={14} color={semanticColors.green} />
            <View style={{ flex: 1 }}>
              <Text fontSize={12} color={c.text2} fontFamily="$body">
                Cuenta conectada
              </Text>
              <Text fontSize={14} color={c.text} fontFamily="$body">
                {authInfo.oauth.email}
              </Text>
            </View>
          </XStack>
          {authInfo.oauth.expiresAt && (
            <Text fontSize={11} color={c.text3} marginTop={4} fontFamily="$body">
              Expira: {new Date(authInfo.oauth.expiresAt).toLocaleDateString()}
            </Text>
          )}
        </View>
      )}

      {/* Message or error */}
      {authInfo.message && !isConnected && (
        <Text fontSize={13} color={c.text2} marginBottom={12} fontFamily="$body">
          {authInfo.message}
        </Text>
      )}
      {authInfo.error && (
        <Text fontSize={13} color={semanticColors.red} marginBottom={12} fontFamily="$body">
          {authInfo.error}
        </Text>
      )}

      {/* Action buttons */}
      <XStack gap={8} marginTop={4}>
        {/* Connect button for needs_user_auth or expired */}
        {(authInfo.status === 'needs_user_auth' || authInfo.status === 'expired') && onConnect && (
          <TouchableOpacity
            onPress={onConnect}
            disabled={connecting}
            style={{
              flex: 1,
              backgroundColor: badges[theme].info.bg,
              paddingVertical: 10,
              paddingHorizontal: 16,
              borderRadius: 8,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              opacity: connecting ? 0.6 : 1,
              borderWidth: 1,
              borderColor: badges[theme].info.border,
            }}
          >
            {connecting ? (
              <AppSpinner size="sm" variant="default" />
            ) : (
              <>
                <LogIn size={16} color={badges[theme].info.text} />
                <Text
                  fontSize={14}
                  fontWeight="500"
                  color={badges[theme].info.text}
                  fontFamily="$body"
                >
                  {authInfo.authType === 'oauth2' ? 'Conectar cuenta' : 'Configurar'}
                </Text>
              </>
            )}
          </TouchableOpacity>
        )}

        {/* Disconnect button for connected accounts */}
        {isConnected && onDisconnect && (
          <TouchableOpacity
            onPress={onDisconnect}
            disabled={disconnecting}
            style={{
              flex: 1,
              backgroundColor: badges[theme].err.bg,
              paddingVertical: 10,
              paddingHorizontal: 16,
              borderRadius: 8,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              opacity: disconnecting ? 0.6 : 1,
              borderWidth: 1,
              borderColor: badges[theme].err.border,
            }}
          >
            {disconnecting ? (
              <AppSpinner size="sm" variant="danger" />
            ) : (
              <>
                <Unlink size={16} color={badges[theme].err.text} />
                <Text
                  fontSize={14}
                  fontWeight="500"
                  color={badges[theme].err.text}
                  fontFamily="$body"
                >
                  Desconectar
                </Text>
              </>
            )}
          </TouchableOpacity>
        )}
      </XStack>
    </View>
  );
}

export default AppAuthBadge;
