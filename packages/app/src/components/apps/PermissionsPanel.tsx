/**
 * PermissionsPanel Component
 *
 * Collapsible panel for tool permissions configuration.
 * Shows all tools without internal scroll - scrolls with the page.
 * Each tool has a triple toggle: allow / ask / forbid
 */

import { Check, ChevronRight, Shield, User, X } from '@tamagui/lucide-icons';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, TouchableOpacity, View } from 'react-native';
import { Text } from 'tamagui';
import { AppSpinner } from '../../components/ui';

// ============================================================================
// Types
// ============================================================================

export type ToolPermission = 'allow' | 'ask' | 'forbid';

export interface ToolWithPermission {
  name: string;
  description?: string;
  permission: ToolPermission;
}

export interface PermissionsPanelProps {
  /** List of tools with their permissions */
  tools: ToolWithPermission[];
  /** Summary counts */
  summary?: {
    allow: number;
    ask: number;
    forbid: number;
  };
  /** Loading state */
  loading?: boolean;
  /** Saving state */
  saving?: boolean;
  /** Callback when a tool's permission changes */
  onToolPermissionChange?: (toolName: string, permission: ToolPermission) => void;
  /** Callback to set all tools to a permission */
  onSetAllPermissions?: (permission: ToolPermission) => void;
  /** Initial expanded state */
  defaultExpanded?: boolean;
}

// ============================================================================
// Colors
// ============================================================================

const colors = {
  // Status
  ready: '#22c55e',
  glowReady: 'rgba(34, 197, 94, 0.5)',

  // Section
  iconShield: '#06b6d4',

  // Permissions
  allow: '#86efac',
  allowBg: 'rgba(34, 197, 94, 0.2)',
  ask: '#fcd34d',
  askBg: 'rgba(251, 191, 36, 0.2)',
  forbid: '#fca5a5',
  forbidBg: 'rgba(239, 68, 68, 0.2)',

  // Badges
  badgeGray: { text: '#a1a1aa', bg: 'rgba(255, 255, 255, 0.06)' },

  // Text
  textPrimary: '#e4e4e7',
  textSecondary: '#a1a1aa',
  textMuted: '#52525b',

  // Backgrounds
  panelBg: 'rgba(39, 39, 42, 0.6)',
  sectionBg: 'rgba(0, 0, 0, 0.15)',
  summaryBg: 'rgba(0, 0, 0, 0.2)',
  toggleBg: 'rgba(0, 0, 0, 0.3)',

  // Borders
  border: 'rgba(255, 255, 255, 0.04)',

  // Chevron
  chevron: '#3f3f46',
};

// ============================================================================
// Status Dot Component
// ============================================================================

function StatusDot() {
  return (
    <View
      style={{
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: colors.ready,
        flexShrink: 0,
        shadowColor: colors.glowReady,
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
}

function Badge({ text }: BadgeProps) {
  return (
    <View
      style={{
        backgroundColor: colors.badgeGray.bg,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 4,
      }}
    >
      <Text color={colors.badgeGray.text} fontSize={11} fontFamily="$mono" fontWeight="500">
        {text}
      </Text>
    </View>
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
// Bulk Actions Component
// ============================================================================

interface BulkActionsProps {
  onSetAll: (permission: ToolPermission) => void;
  disabled?: boolean;
}

function BulkActions({ onSetAll, disabled }: BulkActionsProps) {
  const buttons: { key: ToolPermission; icon: React.ReactNode }[] = [
    { key: 'allow', icon: <Check size={12} color={colors.textMuted} /> },
    { key: 'ask', icon: <User size={12} color={colors.textMuted} /> },
    { key: 'forbid', icon: <X size={12} color={colors.textMuted} /> },
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
// Summary Bar Component
// ============================================================================

interface SummaryBarProps {
  summary: { allow: number; ask: number; forbid: number };
  onSetAll?: (permission: ToolPermission) => void;
  disabled?: boolean;
}

function SummaryBar({ summary, onSetAll, disabled }: SummaryBarProps) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: 12,
        paddingHorizontal: 16,
        backgroundColor: colors.summaryBg,
        borderTopWidth: 1,
        borderTopColor: colors.border,
      }}
    >
      {/* Counts */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <Check size={12} color={colors.allow} />
          <Text fontSize={12} fontFamily="$mono" color={colors.allow}>
            {summary.allow}
          </Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <User size={12} color={colors.ask} />
          <Text fontSize={12} fontFamily="$mono" color={colors.ask}>
            {summary.ask}
          </Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <X size={12} color={colors.forbid} />
          <Text fontSize={12} fontFamily="$mono" color={colors.forbid}>
            {summary.forbid}
          </Text>
        </View>
      </View>

      {/* Bulk actions */}
      {onSetAll && <BulkActions onSetAll={onSetAll} disabled={disabled} />}
    </View>
  );
}

// ============================================================================
// Tool Row Component
// ============================================================================

interface ToolRowProps {
  tool: ToolWithPermission;
  onPermissionChange: (permission: ToolPermission) => void;
  disabled?: boolean;
  isLast?: boolean;
}

function ToolRow({ tool, onPermissionChange, disabled, isLast }: ToolRowProps) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: 10,
        paddingHorizontal: 16,
        borderBottomWidth: isLast ? 0 : 1,
        borderBottomColor: colors.border,
      }}
    >
      <Text
        fontSize={13}
        fontFamily="$mono"
        color={colors.textSecondary}
        numberOfLines={1}
        style={{ flex: 1, marginRight: 12 }}
      >
        {tool.name}
      </Text>
      <TripleToggle value={tool.permission} onChange={onPermissionChange} disabled={disabled} />
    </View>
  );
}

// ============================================================================
// Legend Component
// ============================================================================

function Legend() {
  return (
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
  );
}

// ============================================================================
// Main PermissionsPanel Component
// ============================================================================

export function PermissionsPanel({
  tools,
  summary: propSummary,
  loading = false,
  saving = false,
  onToolPermissionChange,
  onSetAllPermissions,
  defaultExpanded = true,
}: PermissionsPanelProps) {
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

  // Calculate summary if not provided
  const summary =
    propSummary ||
    tools.reduce(
      (acc, tool) => {
        acc[tool.permission]++;
        return acc;
      },
      { allow: 0, ask: 0, forbid: 0 },
    );

  const totalTools = tools.length;

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
        <StatusDot />
        <Shield size={18} color={colors.iconShield} />
        <Text flex={1} fontSize={14} fontWeight="500" color={colors.textPrimary}>
          Permisos
        </Text>
        {loading ? (
          <AppSpinner size="sm" variant="muted" />
        ) : (
          <Badge text={`${totalTools} tools`} />
        )}
        <Animated.View style={{ transform: [{ rotate: rotation }] }}>
          <ChevronRight size={14} color={colors.chevron} />
        </Animated.View>
      </TouchableOpacity>

      {/* Content - NO SCROLL, all tools visible */}
      {expanded && (
        <View style={{ backgroundColor: colors.sectionBg }}>
          {/* Summary bar with bulk actions */}
          <SummaryBar
            summary={summary}
            onSetAll={onSetAllPermissions}
            disabled={saving || !onSetAllPermissions}
          />

          {/* Tools list - renders all tools, no ScrollView */}
          <View>
            {tools.map((tool, index) => (
              <ToolRow
                key={tool.name}
                tool={tool}
                onPermissionChange={(perm) => onToolPermissionChange?.(tool.name, perm)}
                disabled={saving || !onToolPermissionChange}
                isLast={index === tools.length - 1}
              />
            ))}
          </View>

          {/* Legend */}
          <Legend />
        </View>
      )}
    </View>
  );
}

export default PermissionsPanel;
