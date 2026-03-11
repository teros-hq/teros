/**
 * Default Tool Call Renderer
 *
 * Generic renderer used when an MCA doesn't provide a custom one.
 * Ultra Compact design matching other renderers (Bash, Filesystem, etc.)
 * Shows tool name, JSON input/output with expand/collapse.
 */

import { ChevronRight, Wrench } from '@tamagui/lucide-icons';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, ScrollView } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';
import { PermissionRequestWidget } from './PermissionRequestWidget';
import type { ToolCallRendererProps } from './types';
import { usePulseAnimation } from '../../hooks/usePulseAnimation';

// ============================================================================
// Colors (matching other renderers)
// ============================================================================

const colors = {
  // Status dot
  success: '#22c55e', // Green - completed
  running: '#06b6d4', // Cyan/Blue - running
  failed: '#ef4444', // Red - failed
  pending: '#f59e0b', // Amber/Yellow - pending/waiting
  pendingPermission: '#a855f7', // Purple - needs user approval

  // Status glow
  glowSuccess: 'rgba(34, 197, 94, 0.5)',
  glowRunning: 'rgba(6, 182, 212, 0.5)',
  glowFailed: 'rgba(239, 68, 68, 0.5)',
  glowPending: 'rgba(245, 158, 11, 0.4)',
  glowPendingPermission: 'rgba(168, 85, 247, 0.5)',

  // Icon
  icon: '#9ca3af',

  // Badges
  badgeSuccess: { text: '#86efac', bg: 'rgba(34,197,94,0.1)' },
  badgeError: { text: '#fca5a5', bg: 'rgba(239,68,68,0.1)' },
  badgeInfo: { text: '#93c5fd', bg: 'rgba(59,130,246,0.1)' },

  // Text
  primary: '#d4d4d8',
  secondary: '#9ca3af',
  muted: '#52525b',
  bright: '#e4e4e7',

  // Backgrounds
  bgInner: 'rgba(0,0,0,0.2)',
  border: 'rgba(255,255,255,0.04)',

  // Chevron
  chevron: '#3f3f46',
};

// ============================================================================
// Utilities
// ============================================================================

function formatDuration(ms?: number): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function getShortToolName(toolName: string): string {
  const parts = toolName.split('_');
  return parts[parts.length - 1] || toolName;
}

function formatJson(obj: any): string {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj);
  }
}

// ============================================================================
// Components
// ============================================================================

interface StatusDotProps {
  status: 'pending' | 'running' | 'completed' | 'failed' | 'pending_permission';
}

function StatusDot({ status }: StatusDotProps) {
  const color =
    status === 'pending'
      ? colors.pending
      : status === 'running'
        ? colors.running
        : status === 'completed'
          ? colors.success
          : status === 'pending_permission'
            ? colors.pendingPermission
            : colors.failed;

  const glow =
    status === 'pending'
      ? colors.glowPending
      : status === 'running'
        ? colors.glowRunning
        : status === 'completed'
          ? colors.glowSuccess
          : status === 'pending_permission'
            ? colors.glowPendingPermission
            : colors.glowFailed;

  const pulseAnim = usePulseAnimation(status === 'running' || status === 'pending_permission');

  return (
    <Animated.View
      style={{
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: color,
        flexShrink: 0,
        opacity: status === 'running' || status === 'pending_permission' ? pulseAnim : 1,
        shadowColor: glow,
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 1,
        shadowRadius: 3,
        elevation: 3,
      }}
    />
  );
}

interface BadgeProps {
  text: string;
  variant: 'success' | 'error' | 'info';
}

function Badge({ text, variant }: BadgeProps) {
  const styles = {
    success: colors.badgeSuccess,
    error: colors.badgeError,
    info: colors.badgeInfo,
  };
  const { text: textColor, bg } = styles[variant];

  return (
    <XStack backgroundColor={bg} paddingHorizontal={4} paddingVertical={1} borderRadius={3}>
      <Text color={textColor} fontSize={9} fontFamily="$mono">
        {text}
      </Text>
    </XStack>
  );
}

interface HeaderRowProps {
  status: 'pending' | 'running' | 'completed' | 'failed' | 'pending_permission';
  icon: React.ReactNode;
  description: string;
  duration?: number;
  badge?: React.ReactNode;
  expanded: boolean;
  onToggle: () => void;
  isInContainer?: boolean;
}

function HeaderRow({
  status,
  icon,
  description,
  duration,
  badge,
  expanded,
  onToggle,
  isInContainer,
}: HeaderRowProps) {
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
    <XStack
      alignItems="center"
      gap={8}
      paddingVertical={6}
      paddingHorizontal={10}
      backgroundColor={isInContainer ? 'transparent' : 'rgba(39,39,42,0.6)'}
      borderRadius={isInContainer ? 0 : 8}
      borderWidth={isInContainer ? 0 : 1}
      borderColor={isInContainer ? 'transparent' : colors.border}
      borderBottomWidth={isInContainer ? 1 : 1}
      borderBottomColor={colors.border}
      width={isInContainer ? undefined : '100%'}
      pressStyle={{
        backgroundColor: isInContainer ? 'rgba(255,255,255,0.02)' : 'rgba(45,45,50,0.7)',
      }}
      hoverStyle={{
        backgroundColor: isInContainer ? 'rgba(255,255,255,0.02)' : 'rgba(45,45,50,0.7)',
        borderColor: isInContainer ? 'transparent' : 'rgba(255,255,255,0.08)',
      }}
      onPress={onToggle}
      cursor="pointer"
    >
      <StatusDot status={status} />
      {icon}

      <Text flex={1} color={colors.primary} fontSize={11} fontWeight="500" numberOfLines={1}>
        {description}
      </Text>

      {status === 'pending' ? (
        <Text color={colors.pending} fontSize={9} fontFamily="$mono">
          pending
        </Text>
      ) : status === 'running' ? (
        <Text color={colors.running} fontSize={9} fontFamily="$mono">
          running
        </Text>
      ) : status === 'pending_permission' ? (
        <Text color={colors.pendingPermission} fontSize={9} fontFamily="$mono">
          approval
        </Text>
      ) : (
        duration !== undefined && (
          <Text color={colors.muted} fontSize={9} fontFamily="$mono">
            {formatDuration(duration)}
          </Text>
        )
      )}

      {badge}

      <Animated.View style={{ transform: [{ rotate: rotation }] }}>
        <ChevronRight size={10} color={colors.chevron} />
      </Animated.View>
    </XStack>
  );
}

function ExpandedContainer({ children }: { children: React.ReactNode }) {
  return (
    <YStack
      backgroundColor="rgba(39,39,42,0.6)"
      borderRadius={8}
      borderWidth={1}
      borderColor={colors.border}
      overflow="hidden"
      width="100%"
    >
      {children}
    </YStack>
  );
}

function ExpandedBody({ children }: { children: React.ReactNode }) {
  return (
    <YStack padding={8} gap={6}>
      {children}
    </YStack>
  );
}

interface JsonBlockProps {
  content: string;
  label?: string;
  maxHeight?: number;
  variant?: 'default' | 'success' | 'error';
}

function JsonBlock({ content, label, maxHeight = 200, variant = 'default' }: JsonBlockProps) {
  const bgColor =
    variant === 'success'
      ? 'rgba(34,197,94,0.1)'
      : variant === 'error'
        ? 'rgba(239,68,68,0.1)'
        : colors.bgInner;

  const textColor =
    variant === 'success'
      ? colors.badgeSuccess.text
      : variant === 'error'
        ? colors.badgeError.text
        : colors.secondary;

  return (
    <YStack gap={4}>
      {label && (
        <Text color={colors.muted} fontSize={9} fontFamily="$mono">
          {label}
        </Text>
      )}
      <ScrollView
        style={{ maxHeight, backgroundColor: bgColor, borderRadius: 5 }}
        showsVerticalScrollIndicator={true}
      >
        <Text color={textColor} fontSize={10} fontFamily="$mono" padding={8}>
          {content}
        </Text>
      </ScrollView>
    </YStack>
  );
}

// ============================================================================
// Main Renderer
// ============================================================================

export function DefaultToolCallRenderer(props: ToolCallRendererProps) {
  const { toolName, input, status, output, error, duration, appId, permissionRequestId } = props;

  const [expanded, setExpanded] = useState(false);

  // Use status directly - each has its own color now
  const displayStatus = status;

  const shortName = getShortToolName(toolName);
  const description = shortName;

  // Determine badge
  let badge: React.ReactNode = null;
  if (displayStatus === 'completed') {
    badge = <Badge text="done" variant="success" />;
  } else if (displayStatus === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  const icon = <Wrench size={12} color={colors.icon} />;

  const headerProps = {
    status: displayStatus as 'pending' | 'running' | 'completed' | 'failed' | 'pending_permission',
    icon,
    description,
    duration,
    badge,
    expanded,
    onToggle: () => setExpanded(!expanded),
  };

  const hasInput = input && Object.keys(input).length > 0;
  const hasOutput = output && output.length > 0;
  const hasError = error && error.length > 0;

  // Try to parse output as JSON for pretty display
  let outputDisplay = output || '';
  try {
    const parsed = JSON.parse(output || '');
    outputDisplay = formatJson(parsed);
  } catch {
    // Keep as-is
  }

  const content = (
    <>
      {/* Collapsed view */}
      {!expanded && <HeaderRow {...headerProps} />}

      {/* Expanded view */}
      {expanded && (
        <ExpandedContainer>
          <HeaderRow {...headerProps} isInContainer />
          <ExpandedBody>
            {/* Input */}
            {hasInput && <JsonBlock content={formatJson(input)} label="INPUT" />}

            {/* Output */}
            {hasOutput && <JsonBlock content={outputDisplay} label="OUTPUT" variant="success" />}

            {/* Error */}
            {hasError && <JsonBlock content={error || ''} label="ERROR" variant="error" />}
          </ExpandedBody>
        </ExpandedContainer>
      )}
    </>
  );

  // If pending permission, wrap with permission widget
  if (status === 'pending_permission' && permissionRequestId && appId) {
    return (
      <YStack gap={0}>
        {content}
        <PermissionRequestWidget
          permissionRequestId={permissionRequestId}
          appId={appId}
          toolName={toolName}
        />
      </YStack>
    );
  }

  return content;
}
