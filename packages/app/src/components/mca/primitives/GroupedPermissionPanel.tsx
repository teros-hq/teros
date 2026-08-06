/**
 * GroupedPermissionPanel — TER-375.
 *
 * Single panel that gathers ALL tools of a parallel batch that still need
 * approval, anchored below the batch in the chat. Replaces the N stacked
 * per-card `ControlsBar`s. Layout:
 *
 *   🛡  N actions need your approval
 *       (M destructive — decide individually)
 *   ──────────────────────────────────────────
 *   read_file   src/auth.ts          [✗] [✓]
 *   write_file  src/new.ts   ⚠       [✗] [✓]
 *   ──────────────────────────────────────────
 *              [Deny all]   [Allow all]
 *
 * Behaviour (decided in TER-375):
 *   • Per-row [✗]/[✓] → deny/allow that one tool. This is what makes
 *     "approve 2, deny 1" a first-class action (no hidden menu).
 *   • Allow all → grants every REVERSIBLE tool; irreversible ones stay pending
 *     and keep their own row (fail-closed). Hidden when all are destructive.
 *   • Deny all → denies every tool in the batch.
 *
 * Iterates the per-request callbacks from `PermissionContext` — no batch backend
 * endpoint needed. As each tool resolves it leaves `pending_permission`, the
 * grouping recomputes, its row disappears, and the panel shrinks/vanishes.
 */

import { useMemo } from 'react'
import { TouchableOpacity } from 'react-native'
import { Text, XStack, YStack } from 'tamagui'
import {
  requestIdsForAllowAll,
  requestIdsForDenyAll,
} from '../../../hooks/chat/permission-grouping'
import { captureMessage } from '../../../lib/sentry'
import { usePermissionCallbacks } from '../types'
import { controlsBar as t, indicators } from './colors'
import { Check, Shield, ShieldAlert, X } from './icons'
import { MCA_STRINGS } from './strings'
import { useColors } from './useColors'

/** Minimal shape the panel needs — structurally compatible with `GroupedTool`. */
export interface GroupedPermissionTool {
  requestId: string
  toolName: string
  appId?: string
  irreversible: boolean
}

export interface GroupedPermissionPanelProps {
  tools: GroupedPermissionTool[]
}

export function GroupedPermissionPanel({ tools }: GroupedPermissionPanelProps) {
  const c = useColors()
  const callbacks = usePermissionCallbacks()

  const destructiveCount = useMemo(() => tools.filter((tool) => tool.irreversible).length, [tools])
  const hasReversible = destructiveCount < tools.length

  if (!callbacks) {
    const message =
      `[GroupedPermissionPanel] PermissionContext is null for a batch of ${tools.length} ` +
      `tools (${tools.map((tool) => tool.toolName).join(', ')}). The panel requires the ` +
      `PermissionContext provider — usually via ChatView. Permission UI will not render.`
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      throw new Error(message)
    }
    captureMessage(message, 'error', { source: 'GroupedPermissionPanel', count: tools.length })
    return null
  }

  const handleAllowAll = () => {
    for (const requestId of requestIdsForAllowAll(tools)) callbacks.onGrant(requestId)
  }
  const handleDenyAll = () => {
    for (const requestId of requestIdsForDenyAll(tools)) callbacks.onDeny(requestId)
  }

  const subLabel = !hasReversible
    ? MCA_STRINGS.permissionGroup.allDestructiveNote
    : destructiveCount > 0
      ? MCA_STRINGS.permissionGroup.destructiveNote(destructiveCount)
      : undefined

  return (
    <YStack overflow="hidden" borderRadius={8} borderWidth={1} borderColor={c.borderStrong} backgroundColor={c.bgCard}>
      {/* Header */}
      <XStack paddingVertical={8} paddingHorizontal={12} alignItems="center" gap={8}>
        <Shield size={14} color={t.permission.fg} />
        <YStack flex={1} minWidth={0}>
          <Text fontSize={12} color={c.text} fontWeight="600" numberOfLines={1} ellipsizeMode="tail">
            {MCA_STRINGS.permissionGroup.awaiting(tools.length)}
          </Text>
          {subLabel && (
            <Text fontSize={10} color={indicators.irreversible.fg} numberOfLines={1} ellipsizeMode="tail">
              {subLabel}
            </Text>
          )}
        </YStack>
      </XStack>

      {/* Per-tool rows — individual deny/allow (approve 2, deny 1) */}
      <YStack borderTopWidth={1} borderTopColor={c.border}>
        {tools.map((tool) => (
          <XStack
            key={tool.requestId}
            paddingVertical={7}
            paddingHorizontal={12}
            alignItems="center"
            gap={8}
          >
            {tool.irreversible ? (
              <ShieldAlert size={13} color={indicators.irreversible.fg} />
            ) : (
              <Shield size={13} color={c.text3} />
            )}
            <Text
              flex={1}
              minWidth={0}
              fontSize={12}
              color={c.text2}
              fontFamily="$mono"
              numberOfLines={1}
              ellipsizeMode="middle"
            >
              {tool.toolName}
            </Text>
            <IconAction variant="deny" onPress={() => callbacks.onDeny(tool.requestId)} />
            <IconAction variant="allow" onPress={() => callbacks.onGrant(tool.requestId)} />
          </XStack>
        ))}
      </YStack>

      {/* Bulk actions */}
      <XStack
        borderTopWidth={1}
        borderTopColor={c.border}
        paddingVertical={8}
        paddingHorizontal={12}
        justifyContent="flex-end"
        gap={8}
      >
        <TextAction variant="deny" label={MCA_STRINGS.permissionGroup.denyAll} onPress={handleDenyAll} />
        {hasReversible && (
          <TextAction variant="allow" label={MCA_STRINGS.permissionGroup.allowAll} onPress={handleAllowAll} />
        )}
      </XStack>
    </YStack>
  )
}

// ─── action buttons (shared tokens, no hardcoded hex) ───────────────────────

type Variant = 'deny' | 'allow'

/** Compact icon-only button used per row. */
function IconAction({ variant, onPress }: { variant: Variant; onPress: () => void }) {
  const tok = t[variant]
  const Icon = variant === 'deny' ? X : Check
  const label = variant === 'deny' ? MCA_STRINGS.permission.deny : MCA_STRINGS.permission.allow
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{
        width: 28,
        height: 24,
        borderRadius: 5,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: tok.bg,
        borderWidth: 1,
        borderColor: tok.border,
      }}
    >
      <Icon size={12} color={tok.fg} />
    </TouchableOpacity>
  )
}

/** Labelled button used for the bulk Deny all / Allow all row. */
function TextAction({ variant, label, onPress }: { variant: Variant; label: string; onPress: () => void }) {
  const tok = t[variant]
  const Icon = variant === 'deny' ? X : Check
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        paddingVertical: 5,
        paddingHorizontal: 12,
        borderRadius: 6,
        backgroundColor: tok.bg,
        borderWidth: 1,
        borderColor: tok.border,
      }}
    >
      <Icon size={11} color={tok.fg} />
      <Text fontSize={11} color={tok.fg} fontWeight="600">
        {label}
      </Text>
    </TouchableOpacity>
  )
}
