/**
 * PermissionIndicator — Global navbar badge for pending tool permissions.
 *
 * Shows a Shield icon with a count badge. Clicking opens a dropdown with:
 *   - Each pending permission grouped by conversation
 *   - Tool name + parameter summary
 *   - Inline Aprobar / Denegar buttons (no need to open the chat)
 *   - "Ver en chat" link as secondary action (for when context is needed)
 *
 * Uses the shared usePendingPermissions hook (same source of truth as
 * PendingApprovalsWindow) instead of only reading chatStore channels.
 *
 * DESIGN: Matches the section-header style used by "Agentes", "Proyectos",
 * "Conversations", etc. — icon + uppercase label on the left, action badge
 * on the right.
 */

import { Shield, Check, X, ChevronRight } from '@tamagui/lucide-icons';
import React, { useCallback, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useTilingStore } from '../../store/tilingStore';
import { useWorkspaceStore } from '../../store/workspaceStore';
import { usePendingPermissions } from '../../hooks/usePendingPermissions';
import { colors as semanticColors, surface, controlsBar, indicators } from '../mca/primitives/colors';
import { useColors } from '../mca/primitives/useColors';

interface PermissionIndicatorProps {
  /** Whether the navbar is in collapsed mode */
  collapsed?: boolean;
}

export function PermissionIndicator({ collapsed = false }: PermissionIndicatorProps) {
  const { pendingPermissions, groupedArray, handleApprove, handleDeny, handleApproveAll } = usePendingPermissions();
  const [showDropdown, setShowDropdown] = useState(false);
  const { openWindow } = useTilingStore();
  const c = useColors();
  const isDark = c.bgPage === surface.dark.bgPage;

  const count = pendingPermissions.length;
  const active = count > 0;

  const handleNavigate = useCallback(
    (channelId: string, agentName?: string) => {
      setShowDropdown(false);
      openWindow('chat', {
        channelId,
        agentName,
        workspaceId: useWorkspaceStore.getState().activeWorkspaceId ?? undefined,
      });
    },
    [openWindow],
  );

  // Hide completely when there are no pending permissions.
  // Must be placed AFTER all hooks to respect React's Rules of Hooks.
  if (!active) {
    return null;
  }

  // ── Collapsed: centred icon + optional badge ──
  if (collapsed) {
    return (
      <TouchableOpacity
        style={styles.collapsedContainer}
        onPress={() => {
          if (pendingPermissions.length > 0) {
            handleNavigate(pendingPermissions[0].channelId, pendingPermissions[0].agentName);
          }
        }}
      >
        <Shield size={16} color={semanticColors.violet} />
        <View style={[styles.collapsedBadge, { backgroundColor: semanticColors.red }]}>
          <Text style={styles.collapsedBadgeText}>{count > 9 ? '9+' : count}</Text>
        </View>
      </TouchableOpacity>
    );
  }

  // ── Expanded: section-header style ──
  return (
    <>
      <TouchableOpacity
        style={styles.row}
        onPress={() => setShowDropdown(!showDropdown)}
        activeOpacity={0.7}
      >
        {/* Left: icon + label */}
        <View style={styles.sectionHeaderLeft}>
          <Shield size={16} color={semanticColors.violet} />
          <Text style={[styles.sectionTitle, { color: semanticColors.violet }]} numberOfLines={1}>
            Permisos
          </Text>
        </View>

        {/* Right: count badge */}
        <View style={[styles.badge, { backgroundColor: semanticColors.red }]}>
          <Text style={styles.badgeText}>{count > 99 ? '99+' : count}</Text>
        </View>
      </TouchableOpacity>

      {/* Dropdown modal */}
      {showDropdown && (
        <Modal
          transparent
          animationType="fade"
          visible={showDropdown}
          onRequestClose={() => setShowDropdown(false)}
        >
          <Pressable
            style={[styles.modalBackdrop, { backgroundColor: isDark ? 'rgba(0,0,0,0.4)' : 'rgba(10,10,15,0.4)' }]}
            onPress={() => setShowDropdown(false)}
          >
            <View style={[styles.dropdown, { backgroundColor: c.bgCard, borderColor: c.borderStrong }]}>
              {/* Header */}
              <View style={[styles.dropdownHeader, { borderBottomColor: c.borderStrong }]}>
                <Text style={[styles.dropdownTitle, { color: c.text }]}>Permisos pendientes</Text>
                <TouchableOpacity onPress={() => setShowDropdown(false)}>
                  <Text style={[styles.dropdownClose, { color: c.text2 }]}>✕</Text>
                </TouchableOpacity>
              </View>

              {/* Permission groups */}
              <ScrollView style={styles.dropdownScroll}>
                {groupedArray.map((group) => (
                  <View key={group.channelId} style={[styles.group, { borderBottomColor: c.borderStrong }]}>
                    {/* Channel header */}
                    <View style={[styles.groupHeader, { backgroundColor: isDark ? 'rgba(139,92,246,0.06)' : 'rgba(139,92,246,0.04)' }]}>
                      <View style={styles.groupHeaderLeft}>
                        <Shield size={12} color={semanticColors.violet} />
                        <Text style={[styles.groupChannelName, { color: c.text }]} numberOfLines={1}>
                          {group.channelName}
                        </Text>
                      </View>
                      <View style={styles.groupHeaderRight}>
                        <View style={[styles.groupBadge, { backgroundColor: indicators.risk.bg }]}>
                          <Text style={[styles.groupBadgeText, { color: semanticColors.amber }]}>
                            {group.permissions.length}
                          </Text>
                        </View>
                        {/* Navigate to chat */}
                        <TouchableOpacity
                          onPress={() => handleNavigate(group.channelId, group.agentName)}
                          style={styles.chatLink}
                        >
                          <ChevronRight size={14} color={c.text3} />
                        </TouchableOpacity>
                      </View>
                    </View>

                    {/* Permission items */}
                    {group.permissions.map((perm, idx) => (
                      <View
                        key={perm.requestId}
                        style={[
                          styles.permItem,
                          { borderBottomColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)' },
                          idx === group.permissions.length - 1 && { borderBottomWidth: 0 },
                        ]}
                      >
                        {/* Tool name */}
                        <View
                          style={[
                            styles.toolBadge,
                            { backgroundColor: semanticColors.indigoGlow },
                          ]}
                        >
                          <Text style={[styles.toolName, { color: semanticColors.indigo }]}>
                            {perm.toolName}
                          </Text>
                        </View>

                        {/* Parameter summary (compact) */}
                        {perm.input && Object.keys(perm.input).length > 0 && (
                          <Text style={[styles.paramSummary, { color: c.text3 }]} numberOfLines={2}>
                            {formatParamSummary(perm.input)}
                          </Text>
                        )}

                        {/* Action buttons */}
                        <View style={styles.permActions}>
                          <TouchableOpacity
                            onPress={() => handleDeny(perm.requestId)}
                            style={[
                              styles.actionBtn,
                              styles.denyBtn,
                              {
                                backgroundColor: controlsBar.deny.bg,
                                borderColor: controlsBar.deny.border,
                              },
                            ]}
                          >
                            <X size={12} color={controlsBar.deny.fg} />
                            <Text style={[styles.actionBtnText, { color: controlsBar.deny.fg }]}>
                              Denegar
                            </Text>
                          </TouchableOpacity>

                          <TouchableOpacity
                            onPress={() => handleApprove(perm.requestId)}
                            style={[
                              styles.actionBtn,
                              styles.approveBtn,
                              {
                                backgroundColor: controlsBar.allow.bg,
                                borderColor: controlsBar.allow.border,
                              },
                            ]}
                          >
                            <Check size={12} color={controlsBar.allow.fg} />
                            <Text style={[styles.actionBtnText, { color: controlsBar.allow.fg }]}>
                              Aprobar
                            </Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                    ))}

                    {/* Approve all (if >1) */}
                    {group.permissions.length > 1 && (
                      <TouchableOpacity
                        onPress={() => handleApproveAll(group.channelId)}
                        style={[styles.approveAllBtn, { backgroundColor: isDark ? 'rgba(34,197,94,0.08)' : 'rgba(34,197,94,0.06)' }]}
                      >
                        <Text style={[styles.approveAllText, { color: semanticColors.green }]}>
                          Aprobar todas ({group.permissions.length})
                        </Text>
                      </TouchableOpacity>
                    )}
                  </View>
                ))}
              </ScrollView>
            </View>
          </Pressable>
        </Modal>
      )}
    </>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Compact one-line summary of the tool input parameters. */
function formatParamSummary(input: Record<string, any>): string {
  const entries = Object.entries(input);
  if (entries.length === 0) return '';
  const parts = entries.slice(0, 3).map(([key, value]) => {
    const valStr = typeof value === 'string'
      ? value.length > 40 ? value.substring(0, 40) + '…' : value
      : typeof value === 'object'
        ? JSON.stringify(value).substring(0, 40) + (JSON.stringify(value).length > 40 ? '…' : '')
        : String(value);
    return `${key}: ${valStr}`;
  });
  if (entries.length > 3) parts.push(`+${entries.length - 3} más`);
  return parts.join(' · ');
}

// ── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  // ── Collapsed state ──
  collapsedContainer: {
    position: 'relative',
    paddingVertical: 6,
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  collapsedBadge: {
    position: 'absolute',
    top: 2,
    right: 4,
    minWidth: 14,
    height: 14,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  collapsedBadgeText: {
    color: '#fff',
    fontSize: 9,
    fontWeight: '700',
    lineHeight: 14,
  },

  // ── Expanded row ──
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    paddingVertical: 6,
    marginBottom: 2,
  },
  sectionHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '500',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  badge: {
    width: 22,
    height: 22,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
  },

  // ── Dropdown modal ──
  modalBackdrop: {
    flex: 1,
    justifyContent: 'flex-start',
    paddingTop: 80,
    paddingHorizontal: 20,
  },
  dropdown: {
    borderRadius: 12,
    borderWidth: 1,
    maxHeight: 480,
    overflow: 'hidden',
  },
  dropdownHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 12,
    borderBottomWidth: 1,
  },
  dropdownTitle: {
    fontSize: 14,
    fontWeight: '600',
  },
  dropdownClose: {
    fontSize: 14,
  },
  dropdownScroll: {
    maxHeight: 420,
  },

  // ── Permission group (per channel) ──
  group: {
    borderBottomWidth: 1,
  },
  groupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  groupHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flex: 1,
  },
  groupChannelName: {
    fontSize: 12,
    fontWeight: '600',
    flex: 1,
  },
  groupHeaderRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  groupBadge: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 10,
  },
  groupBadgeText: {
    fontSize: 10,
    fontWeight: '700',
  },
  chatLink: {
    padding: 2,
  },

  // ── Individual permission item ──
  permItem: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
    borderBottomWidth: 1,
  },
  toolBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 4,
  },
  toolName: {
    fontSize: 11,
    fontWeight: '600',
    fontFamily: 'monospace',
  },
  paramSummary: {
    fontSize: 11,
    lineHeight: 15,
  },
  permActions: {
    flexDirection: 'row',
    gap: 8,
  },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
  },
  denyBtn: {},
  approveBtn: {},
  actionBtnText: {
    fontSize: 11,
    fontWeight: '600',
  },

  // ── Approve all ──
  approveAllBtn: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    alignItems: 'center',
  },
  approveAllText: {
    fontSize: 11,
    fontWeight: '600',
  },
});
