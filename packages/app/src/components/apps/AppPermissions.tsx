/**
 * AppPermissions Component
 *
 * Manages tool-level permissions for an app.
 * Allows setting each tool to: allow, ask, or forbid.
 */

import {
  Ban,
  Check,
  ChevronDown,
  ChevronUp,
  HelpCircle,
  Shield,
  Wrench,
} from '@tamagui/lucide-icons';
import type React from 'react';
import { useCallback, useState } from 'react';
import { ScrollView, TouchableOpacity, View } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';
import { AppSpinner } from '../../components/ui';

export type ToolPermission = 'allow' | 'ask' | 'forbid';

export interface ToolWithPermission {
  name: string;
  permission: ToolPermission;
}

export interface AppPermissionsData {
  appId: string;
  appName: string;
  mcaName: string;
  agentId: string;
  defaultPermission: ToolPermission;
  tools: ToolWithPermission[];
  summary: {
    allow: number;
    ask: number;
    forbid: number;
  };
}

interface AppPermissionsProps {
  /** Permissions data */
  data: AppPermissionsData;
  /** Loading state */
  loading?: boolean;
  /** Whether permissions are being saved */
  saving?: boolean;
  /** Callback when a tool's permission changes */
  onToolPermissionChange?: (toolName: string, permission: ToolPermission) => void;
  /** Callback when default permission changes */
  onDefaultPermissionChange?: (permission: ToolPermission) => void;
  /** Callback to set all tools to a permission */
  onSetAllPermissions?: (permission: ToolPermission) => void;
}

/**
 * Permission button configuration
 */
const permissionConfig: Record<
  ToolPermission,
  {
    icon: React.ComponentType<{ size?: number; color?: string }>;
    label: string;
    shortLabel: string;
    bgColor: string;
    bgColorActive: string;
    borderColor: string;
    textColor: string;
    iconColor: string;
  }
> = {
  allow: {
    icon: Check,
    label: 'Permitir',
    shortLabel: 'Permitir',
    bgColor: 'rgba(16, 185, 129, 0.05)',
    bgColorActive: 'rgba(16, 185, 129, 0.2)',
    borderColor: 'rgba(16, 185, 129, 0.3)',
    textColor: '#10B981',
    iconColor: '#10B981',
  },
  ask: {
    icon: HelpCircle,
    label: 'Preguntar',
    shortLabel: 'Preguntar',
    bgColor: 'rgba(245, 158, 11, 0.05)',
    bgColorActive: 'rgba(245, 158, 11, 0.2)',
    borderColor: 'rgba(245, 158, 11, 0.3)',
    textColor: '#F59E0B',
    iconColor: '#F59E0B',
  },
  forbid: {
    icon: Ban,
    label: 'Prohibir',
    shortLabel: 'Prohibir',
    bgColor: 'rgba(239, 68, 68, 0.05)',
    bgColorActive: 'rgba(239, 68, 68, 0.2)',
    borderColor: 'rgba(239, 68, 68, 0.3)',
    textColor: '#EF4444',
    iconColor: '#EF4444',
  },
};

/**
 * Single permission toggle button
 */
function PermissionButton({
  permission,
  isActive,
  onPress,
  size = 'small',
}: {
  permission: ToolPermission;
  isActive: boolean;
  onPress: () => void;
  size?: 'small' | 'medium';
}) {
  const config = permissionConfig[permission];
  const IconComponent = config.icon;

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: size === 'small' ? 4 : 6,
        paddingHorizontal: size === 'small' ? 8 : 12,
        paddingVertical: size === 'small' ? 4 : 6,
        borderRadius: 6,
        backgroundColor: isActive ? config.bgColorActive : config.bgColor,
        borderWidth: 1,
        borderColor: isActive ? config.borderColor : 'transparent',
      }}
    >
      <IconComponent
        size={size === 'small' ? 12 : 14}
        color={isActive ? config.iconColor : '#71717A'}
      />
      <Text
        fontSize={size === 'small' ? 11 : 12}
        fontWeight={isActive ? '600' : '400'}
        color={isActive ? config.textColor : '#71717A'}
      >
        {config.shortLabel}
      </Text>
    </TouchableOpacity>
  );
}

/**
 * Tool row with permission selector
 */
function ToolPermissionRow({
  tool,
  onPermissionChange,
}: {
  tool: ToolWithPermission;
  onPermissionChange: (permission: ToolPermission) => void;
}) {
  return (
    <XStack
      alignItems="center"
      justifyContent="space-between"
      paddingVertical={8}
      paddingHorizontal={12}
      backgroundColor="rgba(0, 0, 0, 0.2)"
      borderRadius={8}
      gap={8}
    >
      {/* Tool name */}
      <XStack alignItems="center" gap={8} flex={1}>
        <Wrench size={14} color="#71717A" />
        <Text fontSize={13} color="#E4E4E7" numberOfLines={1} style={{ flex: 1 }}>
          {tool.name}
        </Text>
      </XStack>

      {/* Permission buttons */}
      <XStack gap={4}>
        {(['allow', 'ask', 'forbid'] as ToolPermission[]).map((perm) => (
          <PermissionButton
            key={perm}
            permission={perm}
            isActive={tool.permission === perm}
            onPress={() => onPermissionChange(perm)}
          />
        ))}
      </XStack>
    </XStack>
  );
}

/**
 * Summary badge showing permission counts
 */
function PermissionsSummary({ summary }: { summary: AppPermissionsData['summary'] }) {
  const total = summary.allow + summary.ask + summary.forbid;

  return (
    <XStack gap={12} alignItems="center">
      <XStack alignItems="center" gap={4}>
        <Check size={12} color="#10B981" />
        <Text fontSize={12} color="#10B981">
          {summary.allow}
        </Text>
      </XStack>
      <XStack alignItems="center" gap={4}>
        <HelpCircle size={12} color="#F59E0B" />
        <Text fontSize={12} color="#F59E0B">
          {summary.ask}
        </Text>
      </XStack>
      <XStack alignItems="center" gap={4}>
        <Ban size={12} color="#EF4444" />
        <Text fontSize={12} color="#EF4444">
          {summary.forbid}
        </Text>
      </XStack>
      <Text fontSize={11} color="#71717A">
        / {total} tools
      </Text>
    </XStack>
  );
}

/**
 * Main AppPermissions component
 */
export function AppPermissions({
  data,
  loading = false,
  saving = false,
  onToolPermissionChange,
  onDefaultPermissionChange,
  onSetAllPermissions,
}: AppPermissionsProps) {
  const [expanded, setExpanded] = useState(false);

  if (loading) {
    return (
      <View
        style={{
          backgroundColor: 'rgba(24, 24, 27, 0.9)',
          borderRadius: 12,
          padding: 16,
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: 100,
        }}
      >
        <AppSpinner size="sm" variant="default" />
        <Text color="#71717A" marginTop={8} fontSize={13}>
          Cargando permisos...
        </Text>
      </View>
    );
  }

  return (
    <YStack
      backgroundColor="rgba(24, 24, 27, 0.9)"
      borderRadius={12}
      borderWidth={1}
      borderColor="rgba(39, 39, 42, 0.5)"
      overflow="hidden"
    >
      {/* Header */}
      <TouchableOpacity
        onPress={() => setExpanded(!expanded)}
        activeOpacity={0.8}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: 16,
        }}
      >
        <XStack alignItems="center" gap={10}>
          <View
            style={{
              width: 36,
              height: 36,
              borderRadius: 8,
              backgroundColor: 'rgba(6, 182, 212, 0.1)',
              justifyContent: 'center',
              alignItems: 'center',
            }}
          >
            <Shield size={18} color="#06B6D4" />
          </View>
          <YStack>
            <Text fontSize={14} fontWeight="600" color="#FAFAFA">
              Permisos de Tools
            </Text>
            <PermissionsSummary summary={data.summary} />
          </YStack>
        </XStack>

        <XStack alignItems="center" gap={8}>
          {saving && <AppSpinner size="sm" variant="default" />}
          {expanded ? (
            <ChevronUp size={18} color="#71717A" />
          ) : (
            <ChevronDown size={18} color="#71717A" />
          )}
        </XStack>
      </TouchableOpacity>

      {/* Expanded content */}
      {expanded && (
        <YStack borderTopWidth={1} borderTopColor="rgba(39, 39, 42, 0.5)">
          {/* Quick actions */}
          <XStack padding={12} gap={8} backgroundColor="rgba(0, 0, 0, 0.2)" justifyContent="center">
            <Text fontSize={12} color="#71717A" marginRight={8}>
              Aplicar a todos:
            </Text>
            {(['allow', 'ask', 'forbid'] as ToolPermission[]).map((perm) => (
              <PermissionButton
                key={perm}
                permission={perm}
                isActive={false}
                onPress={() => onSetAllPermissions?.(perm)}
                size="medium"
              />
            ))}
          </XStack>

          {/* Default permission */}
          <XStack
            padding={12}
            alignItems="center"
            justifyContent="space-between"
            borderBottomWidth={1}
            borderBottomColor="rgba(39, 39, 42, 0.3)"
          >
            <YStack>
              <Text fontSize={13} fontWeight="500" color="#E4E4E7">
                Permiso por defecto
              </Text>
              <Text fontSize={11} color="#71717A">
                Para tools nuevas no configuradas
              </Text>
            </YStack>
            <XStack gap={4}>
              {(['allow', 'ask', 'forbid'] as ToolPermission[]).map((perm) => (
                <PermissionButton
                  key={perm}
                  permission={perm}
                  isActive={data.defaultPermission === perm}
                  onPress={() => onDefaultPermissionChange?.(perm)}
                />
              ))}
            </XStack>
          </XStack>

          {/* Tools list */}
          <YStack padding={12} gap={6} maxHeight={400}>
            <ScrollView style={{ maxHeight: 350 }}>
              <YStack gap={6}>
                {data.tools.map((tool) => (
                  <ToolPermissionRow
                    key={tool.name}
                    tool={tool}
                    onPermissionChange={(perm) => onToolPermissionChange?.(tool.name, perm)}
                  />
                ))}
              </YStack>
            </ScrollView>
          </YStack>

          {/* Footer info */}
          <XStack
            padding={12}
            backgroundColor="rgba(0, 0, 0, 0.2)"
            borderTopWidth={1}
            borderTopColor="rgba(39, 39, 42, 0.3)"
          >
            <Text fontSize={11} color="#52525B">
              💡 <Text color="#71717A">Permitir</Text> = ejecutar sin preguntar ·
              <Text color="#71717A"> Ask</Text> = request confirmation ·
              <Text color="#71717A"> Prohibir</Text> = bloquear siempre
            </Text>
          </XStack>
        </YStack>
      )}
    </YStack>
  );
}

export default AppPermissions;
