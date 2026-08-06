/**
 * AppPermissions Component
 *
 * Manages tool-level permissions for an app.
 * Allows setting each tool to: allow, ask, or forbid.
 *
 * Migrated to the Design System:
 * - Uses `useColors()` for theme-adaptive surface/border tokens.
 * - Uses `semanticColors` for permission accents (green, amber, red).
 * - Uses Tamagui font tokens (`$body`, `$mono`).
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
import { Text, XStack, YStack, useThemeName } from 'tamagui';
import { AppSpinner } from '../../components/ui';
import {
  badges,
  colors as semanticColors,
  surface,
  type Theme,
} from '../mca/primitives/colors';
import { useColors } from '../mca/primitives/useColors';

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

// ============================================================================
// Helpers
// ============================================================================

function useAppTheme(): Theme {
  const name = useThemeName();
  return typeof name === 'string' && name.startsWith('light') ? 'light' : 'dark';
}

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
// Permission Button
// ============================================================================

const permissionConfig: Record<
  ToolPermission,
  {
    icon: React.ComponentType<{ size?: number; color?: string }>;
    label: string;
    shortLabel: string;
  }
> = {
  allow: { icon: Check, label: 'Permitir', shortLabel: 'Permitir' },
  ask: { icon: HelpCircle, label: 'Preguntar', shortLabel: 'Preguntar' },
  forbid: { icon: Ban, label: 'Prohibir', shortLabel: 'Prohibir' },
};

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
  const c = useColors();
  const permColors = getPermissionColors();
  const config = permissionConfig[permission];
  const IconComponent = config.icon;

  const activeColor =
    permission === 'allow' ? permColors.allow : permission === 'ask' ? permColors.ask : permColors.forbid;
  const activeBg =
    permission === 'allow' ? permColors.allowBg : permission === 'ask' ? permColors.askBg : permColors.forbidBg;

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
        backgroundColor: isActive ? activeBg : c.bgCard,
        borderWidth: 1,
        borderColor: isActive ? activeColor : 'transparent',
      }}
    >
      <IconComponent size={size === 'small' ? 12 : 14} color={isActive ? activeColor : c.text3} />
      <Text
        fontSize={size === 'small' ? 11 : 12}
        fontWeight={isActive ? '600' : '400'}
        color={isActive ? activeColor : c.text3}
        fontFamily="$body"
      >
        {config.shortLabel}
      </Text>
    </TouchableOpacity>
  );
}

// ============================================================================
// Tool Row
// ============================================================================

function ToolPermissionRow({
  tool,
  onPermissionChange,
}: {
  tool: ToolWithPermission;
  onPermissionChange: (permission: ToolPermission) => void;
}) {
  const c = useColors();

  return (
    <XStack
      alignItems="center"
      justifyContent="space-between"
      paddingVertical={8}
      paddingHorizontal={12}
      backgroundColor={c.bgInner}
      borderRadius={8}
      gap={8}
    >
      {/* Tool name */}
      <XStack alignItems="center" gap={8} flex={1}>
        <Wrench size={14} color={c.text3} />
        <Text fontSize={13} color={c.text} numberOfLines={1} style={{ flex: 1 }} fontFamily="$body">
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

// ============================================================================
// Summary Badge
// ============================================================================

function PermissionsSummary({ summary }: { summary: AppPermissionsData['summary'] }) {
  const c = useColors();
  const permColors = getPermissionColors();
  const total = summary.allow + summary.ask + summary.forbid;

  return (
    <XStack gap={12} alignItems="center">
      <XStack alignItems="center" gap={4}>
        <Check size={12} color={permColors.allow} />
        <Text fontSize={12} color={permColors.allow} fontFamily="$mono">
          {summary.allow}
        </Text>
      </XStack>
      <XStack alignItems="center" gap={4}>
        <HelpCircle size={12} color={permColors.ask} />
        <Text fontSize={12} color={permColors.ask} fontFamily="$mono">
          {summary.ask}
        </Text>
      </XStack>
      <XStack alignItems="center" gap={4}>
        <Ban size={12} color={permColors.forbid} />
        <Text fontSize={12} color={permColors.forbid} fontFamily="$mono">
          {summary.forbid}
        </Text>
      </XStack>
      <Text fontSize={11} color={c.text3} fontFamily="$body">
        / {total} tools
      </Text>
    </XStack>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export function AppPermissions({
  data,
  loading = false,
  saving = false,
  onToolPermissionChange,
  onDefaultPermissionChange,
  onSetAllPermissions,
}: AppPermissionsProps) {
  const c = useColors();
  const [expanded, setExpanded] = useState(false);

  if (loading) {
    return (
      <View
        style={{
          backgroundColor: c.bgCard,
          borderRadius: 12,
          padding: 16,
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: 100,
          borderWidth: 1,
          borderColor: c.border,
        }}
      >
        <AppSpinner size="sm" variant="default" />
        <Text color={c.text3} marginTop={8} fontSize={13} fontFamily="$body">
          Cargando permisos...
        </Text>
      </View>
    );
  }

  return (
    <YStack
      backgroundColor={c.bgCard}
      borderRadius={12}
      borderWidth={1}
      borderColor={c.border}
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
              backgroundColor: surface[useAppTheme()].bgInner,
              justifyContent: 'center',
              alignItems: 'center',
            }}
          >
            <Shield size={18} color={semanticColors.indigo} />
          </View>
          <YStack>
            <Text fontSize={14} fontWeight="600" color={c.text} fontFamily="$body">
              Permisos de Tools
            </Text>
            <PermissionsSummary summary={data.summary} />
          </YStack>
        </XStack>

        <XStack alignItems="center" gap={8}>
          {saving && <AppSpinner size="sm" variant="default" />}
          {expanded ? (
            <ChevronUp size={18} color={c.text3} />
          ) : (
            <ChevronDown size={18} color={c.text3} />
          )}
        </XStack>
      </TouchableOpacity>

      {/* Expanded content */}
      {expanded && (
        <YStack borderTopWidth={1} borderTopColor={c.border}>
          {/* Quick actions */}
          <XStack padding={12} gap={8} backgroundColor={c.bgInner} justifyContent="center">
            <Text fontSize={12} color={c.text3} marginRight={8} fontFamily="$body">
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
            borderBottomColor={c.border}
          >
            <YStack>
              <Text fontSize={13} fontWeight="500" color={c.text} fontFamily="$body">
                Permiso por defecto
              </Text>
              <Text fontSize={11} color={c.text3} fontFamily="$body">
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
            backgroundColor={c.bgInner}
            borderTopWidth={1}
            borderTopColor={c.border}
          >
            <Text fontSize={11} color={c.text3} fontFamily="$body">
              💡 <Text color={c.text2} fontFamily="$body">Permitir</Text> = ejecutar sin preguntar ·
              <Text color={c.text2} fontFamily="$body"> Ask</Text> = request confirmation ·
              <Text color={c.text2} fontFamily="$body"> Prohibir</Text> = bloquear siempre
            </Text>
          </XStack>
        </YStack>
      )}
    </YStack>
  );
}

export default AppPermissions;
