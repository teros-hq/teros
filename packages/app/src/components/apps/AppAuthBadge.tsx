/**
 * AppAuthBadge Component
 *
 * Shows the authentication status of an installed app with visual indicators.
 * Used in app cards and app detail pages.
 */

import {
  AlertCircle,
  AlertTriangle,
  Check,
  Clock,
  Key,
  Link,
  LogIn,
  Unlink,
} from '@tamagui/lucide-icons';
import type React from 'react';
import { TouchableOpacity, View } from 'react-native';
import { Text, XStack } from 'tamagui';
import { AppSpinner } from '../../components/ui';

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
 * Configuration for each status type
 */
const statusConfig: Record<
  AppCredentialStatus,
  {
    icon: React.ComponentType<{ size?: number; color?: string }>;
    label: string;
    shortLabel: string;
    bgColor: string;
    borderColor: string;
    textColor: string;
    iconColor: string;
  }
> = {
  ready: {
    icon: Check,
    label: 'Conectada',
    shortLabel: 'OK',
    bgColor: 'rgba(16, 185, 129, 0.1)',
    borderColor: 'rgba(16, 185, 129, 0.3)',
    textColor: '#10B981',
    iconColor: '#10B981',
  },
  needs_system_setup: {
    icon: AlertTriangle,
    label: 'Requires configuration',
    shortLabel: 'Config',
    bgColor: 'rgba(245, 158, 11, 0.1)',
    borderColor: 'rgba(245, 158, 11, 0.3)',
    textColor: '#F59E0B',
    iconColor: '#F59E0B',
  },
  needs_user_auth: {
    icon: LogIn,
    label: 'Conectar cuenta',
    shortLabel: 'Conectar',
    bgColor: 'rgba(59, 130, 246, 0.1)',
    borderColor: 'rgba(59, 130, 246, 0.3)',
    textColor: '#3B82F6',
    iconColor: '#3B82F6',
  },
  expired: {
    icon: Clock,
    label: 'Session expired',
    shortLabel: 'Expirado',
    bgColor: 'rgba(245, 158, 11, 0.1)',
    borderColor: 'rgba(245, 158, 11, 0.3)',
    textColor: '#F59E0B',
    iconColor: '#F59E0B',
  },
  error: {
    icon: AlertCircle,
    label: 'Error',
    shortLabel: 'Error',
    bgColor: 'rgba(239, 68, 68, 0.1)',
    borderColor: 'rgba(239, 68, 68, 0.3)',
    textColor: '#EF4444',
    iconColor: '#EF4444',
  },
  not_required: {
    icon: Check,
    label: 'Not authenticated',
    shortLabel: 'N/A',
    bgColor: 'rgba(113, 113, 122, 0.1)',
    borderColor: 'rgba(113, 113, 122, 0.3)',
    textColor: '#71717A',
    iconColor: '#71717A',
  },
};

export function AppAuthBadge({
  authInfo,
  loading = false,
  size = 'small',
  actionable = false,
  onPress,
}: AppAuthBadgeProps) {
  // If loading, show loading state
  if (loading) {
    return (
      <View
        style={{
          backgroundColor: 'rgba(113, 113, 122, 0.1)',
          paddingHorizontal: size === 'small' ? 6 : 10,
          paddingVertical: size === 'small' ? 3 : 5,
          borderRadius: size === 'small' ? 4 : 6,
          borderWidth: 1,
          borderColor: 'rgba(113, 113, 122, 0.2)',
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

  const config = statusConfig[authInfo.status] || statusConfig.error;
  const IconComponent = config.icon;
  const label = size === 'small' ? config.shortLabel : config.label;

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
        backgroundColor: config.bgColor,
        paddingHorizontal: size === 'small' ? 6 : 10,
        paddingVertical: size === 'small' ? 3 : 5,
        borderRadius: size === 'small' ? 4 : 6,
        borderWidth: 1,
        borderColor: config.borderColor,
      }}
    >
      <IconComponent size={size === 'small' ? 12 : 14} color={config.iconColor} />
      <Text fontSize={size === 'small' ? 10 : 12} fontWeight="500" color={config.textColor}>
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
  const config = statusConfig[authInfo.status] || statusConfig.error;
  const IconComponent = config.icon;

  // For OAuth, show connected account info
  const isOAuth = authInfo.authType === 'oauth2';
  const isConnected = authInfo.status === 'ready' && isOAuth && authInfo.oauth?.connected;

  return (
    <View
      style={{
        backgroundColor: 'rgba(24, 24, 27, 0.9)',
        borderRadius: 12,
        padding: 16,
        borderWidth: 1,
        borderColor: config.borderColor,
      }}
    >
      {/* Status header */}
      <XStack alignItems="center" gap={8} marginBottom={12}>
        <View
          style={{
            width: 36,
            height: 36,
            borderRadius: 8,
            backgroundColor: config.bgColor,
            justifyContent: 'center',
            alignItems: 'center',
          }}
        >
          <IconComponent size={18} color={config.iconColor} />
        </View>
        <View style={{ flex: 1 }}>
          <Text fontSize={14} fontWeight="600" color="#FAFAFA">
            {authInfo.authType === 'oauth2'
              ? 'OAuth'
              : authInfo.authType === 'apikey'
                ? 'API Key'
                : 'Not authenticated'}
          </Text>
          <Text fontSize={12} color={config.textColor}>
            {config.label}
          </Text>
        </View>
        <AppAuthBadge authInfo={authInfo} size="medium" />
      </XStack>

      {/* OAuth connected account */}
      {isConnected && authInfo.oauth?.email && (
        <View
          style={{
            backgroundColor: 'rgba(16, 185, 129, 0.05)',
            borderRadius: 8,
            padding: 12,
            marginBottom: 12,
          }}
        >
          <XStack alignItems="center" gap={8}>
            <Link size={14} color="#10B981" />
            <View style={{ flex: 1 }}>
              <Text fontSize={12} color="#71717A">
                Cuenta conectada
              </Text>
              <Text fontSize={14} color="#FAFAFA">
                {authInfo.oauth.email}
              </Text>
            </View>
          </XStack>
          {authInfo.oauth.expiresAt && (
            <Text fontSize={11} color="#52525B" marginTop={4}>
              Expira: {new Date(authInfo.oauth.expiresAt).toLocaleDateString()}
            </Text>
          )}
        </View>
      )}

      {/* Message or error */}
      {authInfo.message && !isConnected && (
        <Text fontSize={13} color="#A1A1AA" marginBottom={12}>
          {authInfo.message}
        </Text>
      )}
      {authInfo.error && (
        <Text fontSize={13} color="#EF4444" marginBottom={12}>
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
              backgroundColor: 'rgba(59, 130, 246, 0.15)',
              paddingVertical: 10,
              paddingHorizontal: 16,
              borderRadius: 8,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              opacity: connecting ? 0.6 : 1,
            }}
          >
            {connecting ? (
              <AppSpinner size="sm" variant="default" />
            ) : (
              <>
                <LogIn size={16} color="#3B82F6" />
                <Text fontSize={14} fontWeight="500" color="#3B82F6">
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
              backgroundColor: 'rgba(239, 68, 68, 0.1)',
              paddingVertical: 10,
              paddingHorizontal: 16,
              borderRadius: 8,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              opacity: disconnecting ? 0.6 : 1,
            }}
          >
            {disconnecting ? (
              <AppSpinner size="sm" variant="danger" />
            ) : (
              <>
                <Unlink size={16} color="#EF4444" />
                <Text fontSize={14} fontWeight="500" color="#EF4444">
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
