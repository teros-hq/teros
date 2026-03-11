/**
 * Permission Request Widget
 *
 * Displays the permission request UI matching the approved design from
 * docs/design/mockups/permission-system-final.html
 *
 * Design features:
 * - Two-section layout: Context Preview + Controls
 * - Risk level indicator (High/Medium/Low)
 * - Natural language description of the action
 * - Key parameters preview as badges
 * - Expandable details section
 * - Purple accent color (#a855f7)
 */

import {
  AlertTriangle,
  Check,
  ChevronDown,
  MoreVertical,
  Shield,
  ShieldCheck,
  ShieldOff,
  X,
} from '@tamagui/lucide-icons';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Modal, Platform, Pressable, ScrollView, TouchableOpacity, View } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';
import { usePermissionCallbacks } from './types';

// ============================================================================
// Types
// ============================================================================

export type RiskLevel = 'high' | 'medium' | 'low';

interface PermissionRequestWidgetProps {
  permissionRequestId: string;
  appId?: string;
  toolName: string;
  input?: Record<string, any>;
}

// ============================================================================
// Risk Level Detection
// ============================================================================

/**
 * Determine risk level based on tool name and input parameters
 */
function getRiskLevel(toolName: string, input?: Record<string, any>): RiskLevel {
  const tool = toolName.toLowerCase();
  const inputStr = JSON.stringify(input || {}).toLowerCase();

  // High risk patterns
  const highRiskPatterns = [
    'delete',
    'remove',
    'rm -rf',
    'drop',
    'truncate',
    'destroy',
    'purge',
    'recursive',
  ];

  // Medium risk patterns
  const mediumRiskPatterns = [
    'write',
    'update',
    'modify',
    'edit',
    'move',
    'rename',
    'chmod',
    'chown',
  ];

  // Check for high risk
  if (highRiskPatterns.some((pattern) => tool.includes(pattern) || inputStr.includes(pattern))) {
    return 'high';
  }

  // Check for medium risk
  if (mediumRiskPatterns.some((pattern) => tool.includes(pattern) || inputStr.includes(pattern))) {
    return 'medium';
  }

  // Default to low risk
  return 'low';
}

/**
 * Generate natural language description of what the tool will do
 */
function getActionDescription(toolName: string, input?: Record<string, any>): string {
  const tool = toolName.toLowerCase();

  // Bash/Shell commands
  if (tool.includes('bash') || tool.includes('shell') || tool.includes('exec')) {
    const cmd = input?.command || input?.cmd;
    if (cmd) {
      if (cmd.includes('rm -rf')) {
        return `Wants to delete all files recursively in the current directory. This action is <strong style="color:#ef4444">irreversible</strong>.`;
      }
      if (cmd.includes('rm ')) {
        return `Wants to delete files using: <code>${cmd}</code>`;
      }
      return `Wants to execute shell command: <code>${cmd}</code>`;
    }
    return 'Wants to execute a shell command on your system.';
  }

  // Filesystem operations
  if (tool.includes('filesystem') || tool.includes('file')) {
    const path = input?.path || input?.filePath;

    if (tool.includes('delete') || tool.includes('remove')) {
      return `Wants to permanently delete a file from the filesystem${path ? `: <code>${path}</code>` : ''}.`;
    }
    if (tool.includes('write')) {
      return `Wants to write or modify a file${path ? `: <code>${path}</code>` : ''}.`;
    }
    if (tool.includes('read')) {
      return `Wants to read file contents${path ? ` from: <code>${path}</code>` : ''}.`;
    }
  }

  // Email operations
  if (tool.includes('mail') || tool.includes('email')) {
    if (tool.includes('send')) {
      const to = input?.to || input?.recipient;
      return `Wants to send an email${to ? ` to: <strong>${to}</strong>` : ''}.`;
    }
    if (tool.includes('delete')) {
      return 'Wants to delete email messages.';
    }
  }

  // Calendar operations
  if (tool.includes('calendar')) {
    if (tool.includes('create') || tool.includes('add')) {
      const title = input?.title || input?.summary;
      return `Wants to create a new calendar event${title ? `: <strong>${title}</strong>` : ''} on your primary calendar.`;
    }
  }

  // Generic fallback
  return `Wants to execute tool: <code>${toolName}</code>`;
}

/**
 * Extract key parameters to show as preview badges
 */
function getKeyParameters(
  toolName: string,
  input?: Record<string, any>,
): Array<{ key: string; value: string }> {
  if (!input) return [];

  const tool = toolName.toLowerCase();
  const params: Array<{ key: string; value: string }> = [];

  // Bash/Shell
  if (tool.includes('bash') || tool.includes('shell')) {
    if (input.command) params.push({ key: 'cmd', value: truncate(input.command, 50) });
    if (input.cwd) params.push({ key: 'cwd', value: truncate(input.cwd, 40) });
    return params;
  }

  // Filesystem
  if (tool.includes('filesystem') || tool.includes('file')) {
    if (input.path || input.filePath) {
      params.push({ key: 'path', value: truncate(input.path || input.filePath, 60) });
    }
    return params;
  }

  // Email
  if (tool.includes('mail')) {
    if (input.to) params.push({ key: 'to', value: truncate(input.to, 40) });
    if (input.subject) params.push({ key: 'subject', value: truncate(input.subject, 50) });
    return params;
  }

  // Calendar
  if (tool.includes('calendar')) {
    if (input.title || input.summary) {
      params.push({ key: 'title', value: truncate(input.title || input.summary, 40) });
    }
    if (input.date) params.push({ key: 'date', value: input.date });
    if (input.time) params.push({ key: 'time', value: input.time });
    return params;
  }

  // Generic: show first 3 keys
  return Object.entries(input)
    .slice(0, 3)
    .map(([key, value]) => ({
      key,
      value: truncate(String(value), 40),
    }));
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen) + '...';
}

/**
 * Format input for display in expanded view
 */
function formatInput(input: Record<string, any>): string {
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

// ============================================================================
// Colors (matching mockup)
// ============================================================================

const colors = {
  // Purple accent for permissions
  purple: '#a855f7',
  purpleBorder: 'rgba(168, 85, 247, 0.15)',

  // Risk levels
  riskHigh: '#ef4444',
  riskHighBg: 'rgba(239, 68, 68, 0.15)',
  riskHighBorder: 'rgba(239, 68, 68, 0.2)',

  riskMedium: '#f59e0b',
  riskMediumBg: 'rgba(245, 158, 11, 0.15)',
  riskMediumBorder: 'rgba(245, 158, 11, 0.2)',

  riskLow: '#22c55e',
  riskLowBg: 'rgba(34, 197, 94, 0.15)',
  riskLowBorder: 'rgba(34, 197, 94, 0.2)',

  // Backgrounds
  contextBg: '#18181b', // Dark gray - context preview
  controlsBg: '#27272a', // Medium gray - controls bar
  expandedBg: '#18181b', // Same as context
  paramBadgeBg: 'rgba(39, 39, 42, 0.8)',

  // Text
  primary: '#e4e4e7',
  secondary: '#a1a1aa',
  muted: '#52525b',
  mutedLight: '#71717a',

  // Buttons
  denyBg: 'rgba(239, 68, 68, 0.15)',
  denyBorder: 'rgba(239, 68, 68, 0.2)',
  denyText: '#ef4444',

  allowBg: 'rgba(34, 197, 94, 0.15)',
  allowBorder: 'rgba(34, 197, 94, 0.2)',
  allowText: '#22c55e',

  // Borders
  border: 'rgba(255, 255, 255, 0.06)',
};

// ============================================================================
// Components
// ============================================================================

interface RiskBadgeProps {
  level: RiskLevel;
}

function RiskBadge({ level }: RiskBadgeProps) {
  const config = {
    high: {
      text: 'High Risk',
      color: colors.riskHigh,
      bg: colors.riskHighBg,
      border: colors.riskHighBorder,
      icon: <AlertTriangle size={8} color={colors.riskHigh} />,
    },
    medium: {
      text: 'Medium Risk',
      color: colors.riskMedium,
      bg: colors.riskMediumBg,
      border: colors.riskMediumBorder,
      icon: <AlertTriangle size={8} color={colors.riskMedium} />,
    },
    low: {
      text: 'Low Risk',
      color: colors.riskLow,
      bg: colors.riskLowBg,
      border: colors.riskLowBorder,
      icon: <Check size={8} color={colors.riskLow} />,
    },
  };

  const { text, color, bg, border, icon } = config[level];

  return (
    <XStack
      alignItems="center"
      gap={3}
      paddingHorizontal={6}
      paddingVertical={2}
      borderRadius={4}
      backgroundColor={bg}
      borderWidth={1}
      borderColor={border}
    >
      {icon}
      <Text fontSize={9} fontWeight="600" color={color} textTransform="uppercase" letterSpacing={0.5}>
        {text}
      </Text>
    </XStack>
  );
}

interface ParamBadgeProps {
  paramKey: string;
  value: string;
}

function ParamBadge({ paramKey, value }: ParamBadgeProps) {
  return (
    <XStack
      alignItems="center"
      gap={3}
      paddingHorizontal={6}
      paddingVertical={2}
      borderRadius={4}
      backgroundColor={colors.paramBadgeBg}
      borderWidth={1}
      borderColor={colors.border}
    >
      <Text fontSize={10} fontFamily="$mono" color={colors.muted}>
        {paramKey}:
      </Text>
      <Text fontSize={10} fontFamily="$mono" color={colors.secondary}>
        {value}
      </Text>
    </XStack>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export function PermissionRequestWidget({
  permissionRequestId,
  appId,
  toolName,
  input,
}: PermissionRequestWidgetProps) {
  const permissionCallbacks = usePermissionCallbacks();
  const [expanded, setExpanded] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);

  // Animation for expand/collapse
  const rotateAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(rotateAnim, {
      toValue: expanded ? 1 : 0,
      duration: 200,
      easing: Easing.inOut(Easing.ease),
      useNativeDriver: Platform.OS !== 'web',
    }).start();
  }, [expanded, rotateAnim]);

  const rotation = rotateAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '180deg'],
  });

  if (!permissionCallbacks) {
    return null;
  }

  const riskLevel = getRiskLevel(toolName, input);
  const description = getActionDescription(toolName, input);
  const keyParams = getKeyParameters(toolName, input);
  const formattedInput = input ? formatInput(input) : null;

  // Modal handlers
  const handleAllowAlways = () => {
    if (appId) {
      permissionCallbacks.onGrantAlways(permissionRequestId, appId, toolName);
    } else {
      permissionCallbacks.onGrant(permissionRequestId);
    }
    setModalVisible(false);
  };

  const handleDenyAlways = () => {
    if (appId) {
      permissionCallbacks.onDenyAlways(permissionRequestId, appId, toolName);
    } else {
      permissionCallbacks.onDeny(permissionRequestId);
    }
    setModalVisible(false);
  };

  const handleAllow = () => {
    permissionCallbacks.onGrant(permissionRequestId);
    setModalVisible(false);
  };

  const handleDeny = () => {
    permissionCallbacks.onDeny(permissionRequestId);
    setModalVisible(false);
  };

  // Menu item component for modal
  const MenuItem = ({
    icon,
    label,
    description: desc,
    onPress,
    color = '#ccc',
  }: {
    icon: React.ReactNode;
    label: string;
    description?: string;
    onPress: () => void;
    color?: string;
  }) => (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 14,
        gap: 14,
      }}
    >
      <View
        style={{
          width: 36,
          height: 36,
          borderRadius: 8,
          backgroundColor: `${color}15`,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {icon}
      </View>
      <YStack flex={1}>
        <Text fontSize={15} color={color} fontWeight="600">
          {label}
        </Text>
        {desc && (
          <Text fontSize={12} color={colors.mutedLight} marginTop={2}>
            {desc}
          </Text>
        )}
      </YStack>
    </TouchableOpacity>
  );

  return (
    <>
      <YStack
        marginTop={-4}
        borderWidth={1}
        borderTopWidth={0}
        borderColor={colors.purpleBorder}
        borderBottomLeftRadius="$3"
        borderBottomRightRadius="$3"
        overflow="hidden"
        width="100%"
      >
        {/* Context Preview Section */}
        <YStack backgroundColor={colors.contextBg} padding={12} paddingTop={16} gap={8}>
          {/* Header with title and risk badge */}
          <XStack alignItems="center" gap={6}>
            <Shield size={12} color={colors.purple} />
            <Text
              flex={1}
              fontSize={10}
              fontWeight="600"
              color={colors.purple}
              textTransform="uppercase"
              letterSpacing={0.5}
            >
              Permission Required
            </Text>
            <RiskBadge level={riskLevel} />
          </XStack>

          {/* Description */}
          <Text
            fontSize={11}
            color={colors.secondary}
            lineHeight={16}
            dangerouslySetInnerHTML={{ __html: description }}
          />

          {/* Key parameters */}
          {keyParams.length > 0 && (
            <XStack flexWrap="wrap" gap={4}>
              {keyParams.map((param, idx) => (
                <ParamBadge key={idx} paramKey={param.key} value={param.value} />
              ))}
            </XStack>
          )}
        </YStack>

        {/* Expanded Details (optional) */}
        {expanded && formattedInput && (
          <YStack
            backgroundColor={colors.expandedBg}
            borderTopWidth={1}
            borderTopColor={colors.border}
            padding={12}
            gap={6}
          >
            <Text fontSize={9} color={colors.muted} fontFamily="$mono" textTransform="uppercase">
              Full Parameters
            </Text>
            <ScrollView style={{ maxHeight: 150 }} showsVerticalScrollIndicator={true}>
              <View
                style={{
                  backgroundColor: 'rgba(0, 0, 0, 0.4)',
                  borderRadius: 8,
                  padding: 12,
                }}
              >
                <Text fontSize={10} color={colors.secondary} fontFamily="$mono" lineHeight={16}>
                  {formattedInput}
                </Text>
              </View>
            </ScrollView>
          </YStack>
        )}

        {/* Controls Section */}
        <XStack
          backgroundColor={colors.controlsBg}
          paddingVertical={8}
          paddingHorizontal={12}
          alignItems="center"
          justifyContent="space-between"
        >
          {/* Left: Label */}
          <XStack alignItems="center" gap={5} flex={1}>
            <Shield size={12} color={colors.purple} />
            <Text fontSize={10} color={colors.mutedLight} fontWeight="500">
              Requiere permiso
            </Text>
          </XStack>

          {/* Right: Actions */}
          <XStack gap={6} alignItems="center">
            {/* Deny button */}
            <TouchableOpacity
              onPress={() => permissionCallbacks.onDeny(permissionRequestId)}
              activeOpacity={0.7}
              style={{
                backgroundColor: colors.denyBg,
                paddingVertical: 4,
                paddingHorizontal: 10,
                borderRadius: 5,
                borderWidth: 1,
                borderColor: colors.denyBorder,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <X size={10} color={colors.denyText} />
              <Text fontSize={10} color={colors.denyText} fontWeight="500">
                Deny
              </Text>
            </TouchableOpacity>

            {/* Allow button */}
            <TouchableOpacity
              onPress={() => permissionCallbacks.onGrant(permissionRequestId)}
              activeOpacity={0.7}
              style={{
                backgroundColor: colors.allowBg,
                paddingVertical: 4,
                paddingHorizontal: 10,
                borderRadius: 5,
                borderWidth: 1,
                borderColor: colors.allowBorder,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <Check size={10} color={colors.allowText} />
              <Text fontSize={10} color={colors.allowText} fontWeight="500">
                Allow
              </Text>
            </TouchableOpacity>

            {/* Expand/More button — only shown when there are parameters to display */}
            {formattedInput && (
              <TouchableOpacity
                onPress={() => setExpanded(!expanded)}
                activeOpacity={0.7}
                style={{
                  padding: 2,
                }}
              >
                <Animated.View style={{ transform: [{ rotate: rotation }] }}>
                  <ChevronDown size={14} color={colors.muted} />
                </Animated.View>
              </TouchableOpacity>
            )}

            {/* More options (modal) */}
            <TouchableOpacity
              onPress={() => setModalVisible(true)}
              activeOpacity={0.7}
              style={{
                backgroundColor: 'rgba(255, 255, 255, 0.08)',
                paddingVertical: 6,
                paddingHorizontal: 8,
                borderRadius: 6,
              }}
            >
              <MoreVertical size={12} color={colors.secondary} />
            </TouchableOpacity>
          </XStack>
        </XStack>
      </YStack>

      {/* Modal with full options */}
      <Modal
        visible={modalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setModalVisible(false)}
      >
        <Pressable
          style={{
            flex: 1,
            backgroundColor: 'rgba(0, 0, 0, 0.8)',
            justifyContent: 'center',
            alignItems: 'center',
            padding: 20,
          }}
          onPress={() => setModalVisible(false)}
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            style={{
              backgroundColor: colors.contextBg,
              borderRadius: 16,
              borderWidth: 1,
              borderColor: colors.purpleBorder,
              width: '100%',
              maxWidth: 400,
              overflow: 'hidden',
            }}
          >
            {/* Header */}
            <YStack
              paddingHorizontal={20}
              paddingVertical={16}
              borderBottomWidth={1}
              borderBottomColor={colors.border}
              backgroundColor="rgba(168, 85, 247, 0.05)"
            >
              <XStack alignItems="center" gap={12}>
                <View
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 10,
                    backgroundColor: 'rgba(168, 85, 247, 0.15)',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Shield size={20} color={colors.purple} />
                </View>
                <YStack flex={1}>
                  <Text fontSize={17} fontWeight="600" color={colors.primary}>
                    Permiso requerido
                  </Text>
                  <Text fontSize={13} color={colors.secondary} marginTop={2}>
                    {toolName}
                  </Text>
                </YStack>
              </XStack>
            </YStack>

            {/* Command/Input details */}
            {formattedInput && (
              <YStack
                paddingHorizontal={16}
                paddingVertical={12}
                borderBottomWidth={1}
                borderBottomColor={colors.border}
              >
                <Text fontSize={11} color={colors.mutedLight} fontWeight="500" marginBottom={8}>
                  PARAMETERS
                </Text>
                <ScrollView style={{ maxHeight: 150 }} showsVerticalScrollIndicator={true}>
                  <View
                    style={{
                      backgroundColor: 'rgba(0, 0, 0, 0.4)',
                      borderRadius: 8,
                      padding: 12,
                    }}
                  >
                    <Text fontSize={12} color={colors.secondary} fontFamily="$mono" lineHeight={18}>
                      {formattedInput}
                    </Text>
                  </View>
                </ScrollView>
              </YStack>
            )}

            {/* Options */}
            <YStack paddingVertical={8}>
              <MenuItem
                icon={<ShieldOff size={18} color={colors.riskHigh} />}
                label="Denegar siempre"
                description="No volver a preguntar, bloquear siempre"
                color={colors.riskHigh}
                onPress={handleDenyAlways}
              />
              <MenuItem
                icon={<X size={18} color={colors.denyText} />}
                label="Denegar este"
                description="Reject this execution only"
                color={colors.denyText}
                onPress={handleDeny}
              />

              {/* Divider */}
              <View
                style={{
                  height: 1,
                  backgroundColor: colors.border,
                  marginVertical: 8,
                }}
              />

              <MenuItem
                icon={<Check size={18} color={colors.allowText} />}
                label="Permitir este"
                description="Allow this execution only"
                color={colors.allowText}
                onPress={handleAllow}
              />
              <MenuItem
                icon={<ShieldCheck size={18} color={colors.riskLow} />}
                label="Permitir siempre"
                description="No volver a preguntar, permitir siempre"
                color={colors.riskLow}
                onPress={handleAllowAlways}
              />
            </YStack>

            {/* Cancel button */}
            <TouchableOpacity
              onPress={() => setModalVisible(false)}
              activeOpacity={0.7}
              style={{
                borderTopWidth: 1,
                borderTopColor: colors.border,
                paddingVertical: 14,
                alignItems: 'center',
              }}
            >
              <Text fontSize={15} color={colors.mutedLight}>
                Cancelar
              </Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}
