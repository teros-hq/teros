/**
 * ControlsBar — Renderer UX Guide v2 §8.
 *
 * Single-line action bar that appears inside the body of a Tool Call Card
 * when `status === 'pending_permission'`. Layout:
 *
 *   [Shield purple] "Awaiting your approval" (flex:1, nowrap, ellipsis)
 *   [Deny] [Allow] [3-dot menu]
 *
 * The 3-dot menu opens a modal with 4 options:
 *   • Deny always
 *   • Deny
 *   • Allow
 *   • Allow always
 *
 * The request has no expiry — it waits for the user's decision indefinitely
 * (the server-side auto-deny countdown was removed).
 *
 * The ControlsBar never wraps. The middle label uses `numberOfLines={1}`
 * + `ellipsizeMode="tail"`. Buttons stay aligned right; the row collapses
 * gracefully when the card is narrow.
 *
 * The bar is dispatched into the card body via PermissionControlsContext —
 * `withPermissionSupport` provides the context, the `ToolCallCard`
 * consumes it. Renderers do not import `ControlsBar` directly.
 */

import {
  Check,
  MoreVertical,
  Shield,
  ShieldCheck,
  ShieldOff,
  X,
} from './icons';
import { useState } from 'react';
import {
  Modal,
  Platform,
  Pressable,
  TouchableOpacity,
  View,
} from 'react-native';
import { Text, XStack, YStack } from 'tamagui';
import { captureMessage } from '../../../lib/sentry';
import { type PermissionContextValue, usePermissionCallbacks } from '../types';
import { controlsBar as controlsBarTokens } from './colors';
import { MCA_STRINGS } from './strings';
import { useColors } from './useColors';

export interface ControlsBarProps {
  permissionRequestId: string;
  appId?: string;
  toolName: string;
}

export function ControlsBar({ permissionRequestId, appId, toolName }: ControlsBarProps) {
  const c = useColors();
  const callbacks = usePermissionCallbacks();
  const [modalVisible, setModalVisible] = useState(false);

  // Fail loud when the PermissionContext is missing.
  //   - Dev: throw to surface the wiring bug immediately.
  //   - Prod: capture to Sentry as `error` so the team gets paged. Return
  //     null to avoid crashing the chat session, but the log carries the
  //     diagnostic context (toolName, permissionRequestId).
  // Without this, a custom renderer accidentally mounted outside the HOC
  // would silently hide the Allow/Deny UI and leave the LLM hanging.
  if (!callbacks) {
    const message =
      `[ControlsBar] PermissionContext is null for tool "${toolName}" ` +
      `(requestId=${permissionRequestId}). The ControlsBar requires the ` +
      `PermissionContext provider mounted higher in the tree — usually ` +
      `via withPermissionSupport HOC. The permission UI will not render.`;
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      throw new Error(message);
    }
    captureMessage(message, 'error', {
      source: 'ControlsBar',
      toolName,
      permissionRequestId,
      appId,
    });
    return null;
  }

  return (
    <YStack overflow="hidden" borderRadius={6} borderWidth={1} borderColor={c.border}>
      {/* Single-line action row — never wraps */}
      <XStack
        backgroundColor={c.bgCard}
        paddingVertical={6}
        paddingHorizontal={10}
        alignItems="center"
        gap={8}
      >
        <Shield size={12} color={controlsBarTokens.permission.fg} />
        <Text
          flex={1}
          minWidth={0}
          fontSize={10}
          color={c.text2}
          fontWeight="500"
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {MCA_STRINGS.permission.awaiting}
        </Text>

        <DenyButton onPress={() => callbacks.onDeny(permissionRequestId)} />
        <AllowButton onPress={() => callbacks.onGrant(permissionRequestId)} />

        <TouchableOpacity
          onPress={() => setModalVisible(true)}
          activeOpacity={0.7}
          style={{ paddingHorizontal: 4, paddingVertical: 2 }}
          accessibilityRole="button"
          accessibilityLabel={MCA_STRINGS.permission.moreOptions}
        >
          <MoreVertical
            size={12}
            color={c.text3}
          />
        </TouchableOpacity>
      </XStack>

      <PermissionModal
        visible={modalVisible}
        toolName={toolName}
        onClose={() => setModalVisible(false)}
        callbacks={callbacks}
        permissionRequestId={permissionRequestId}
        appId={appId}
      />
    </YStack>
  );
}

// ─── inner button presentation ────────────────────────────────────────────

function DenyButton({ onPress }: { onPress: () => void }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={MCA_STRINGS.permission.deny}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingVertical: 4,
        paddingHorizontal: 10,
        borderRadius: 5,
        backgroundColor: controlsBarTokens.deny.bg,
        borderWidth: 1,
        borderColor: controlsBarTokens.deny.border,
      }}
    >
      <X size={10} color={controlsBarTokens.deny.fg} />
      <Text fontSize={10} color={controlsBarTokens.deny.fg} fontWeight="500">
        {MCA_STRINGS.permission.deny}
      </Text>
    </TouchableOpacity>
  );
}

function AllowButton({ onPress }: { onPress: () => void }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={MCA_STRINGS.permission.allow}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingVertical: 4,
        paddingHorizontal: 10,
        borderRadius: 5,
        backgroundColor: controlsBarTokens.allow.bg,
        borderWidth: 1,
        borderColor: controlsBarTokens.allow.border,
      }}
    >
      <Check size={10} color={controlsBarTokens.allow.fg} />
      <Text fontSize={10} color={controlsBarTokens.allow.fg} fontWeight="500">
        {MCA_STRINGS.permission.allow}
      </Text>
    </TouchableOpacity>
  );
}

// ─── modal (3-dot menu) ───────────────────────────────────────────────────

interface PermissionModalProps {
  visible: boolean;
  toolName: string;
  callbacks: PermissionContextValue;
  permissionRequestId: string;
  appId?: string;
  onClose: () => void;
}

function PermissionModal({
  visible,
  toolName,
  callbacks,
  permissionRequestId,
  appId,
  onClose,
}: PermissionModalProps) {
  const c = useColors();
  const handleAllow = () => {
    callbacks.onGrant(permissionRequestId);
    onClose();
  };
  const handleDeny = () => {
    callbacks.onDeny(permissionRequestId);
    onClose();
  };
  const handleAllowAlways = () => {
    if (appId) callbacks.onGrantAlways(permissionRequestId, appId, toolName);
    else callbacks.onGrant(permissionRequestId);
    onClose();
  };
  const handleDenyAlways = () => {
    if (appId) callbacks.onDenyAlways(permissionRequestId, appId, toolName);
    else callbacks.onDeny(permissionRequestId);
    onClose();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType={Platform.OS === 'web' ? 'fade' : 'slide'}
      onRequestClose={onClose}
    >
      <Pressable
        style={{
          flex: 1,
          backgroundColor: 'rgba(0,0,0,0.7)',
          justifyContent: 'center',
          alignItems: 'center',
          padding: 20,
        }}
        onPress={onClose}
        // RN equivalent of `role="dialog" aria-modal="true"`. Trapped
        // focus + screen-reader announce so the menu is recognised as
        // a modal overlay rather than ambient content.
        accessibilityViewIsModal
      >
        <Pressable
          onPress={(e) => e.stopPropagation()}
          accessibilityRole="menu"
          style={{
            backgroundColor: c.bgCard,
            borderRadius: 16,
            borderWidth: 1,
            borderColor: controlsBarTokens.permission.modalBorder,
            width: '100%',
            maxWidth: 380,
            overflow: 'hidden',
          }}
        >
          <YStack padding={16} borderBottomWidth={1} borderBottomColor={c.border}>
            <Text fontSize={15} fontWeight="600" color={c.text}>
              {MCA_STRINGS.permission.permissionRequired}
            </Text>
            <Text fontSize={11} color={c.text3} marginTop={2} fontFamily="$mono">
              {toolName}
            </Text>
          </YStack>

          <YStack paddingVertical={4}>
            <MenuItem
              icon={<ShieldOff size={16} color={controlsBarTokens.deny.fg} />}
              color={controlsBarTokens.deny.fg}
              label={MCA_STRINGS.permission.denyAlways}
              hint={MCA_STRINGS.permission.blockTool}
              onPress={handleDenyAlways}
            />
            <MenuItem
              icon={<X size={16} color={controlsBarTokens.deny.fg} />}
              color={controlsBarTokens.deny.fg}
              label={MCA_STRINGS.permission.deny}
              hint={MCA_STRINGS.permission.rejectOnly}
              onPress={handleDeny}
            />
            <Divider />
            <MenuItem
              icon={<Check size={16} color={controlsBarTokens.allow.fg} />}
              color={controlsBarTokens.allow.fg}
              label={MCA_STRINGS.permission.allow}
              hint={MCA_STRINGS.permission.allowOnly}
              onPress={handleAllow}
            />
            <MenuItem
              icon={<ShieldCheck size={16} color={controlsBarTokens.allow.fg} />}
              color={controlsBarTokens.allow.fg}
              label={MCA_STRINGS.permission.allowAlways}
              hint={MCA_STRINGS.permission.dontAskAgain}
              onPress={handleAllowAlways}
            />
          </YStack>

          <TouchableOpacity
            onPress={onClose}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={MCA_STRINGS.permission.cancel}
            style={{
              borderTopWidth: 1,
              borderTopColor: c.border,
              paddingVertical: 12,
              alignItems: 'center',
            }}
          >
            <Text fontSize={13} color={c.text2}>
              {MCA_STRINGS.permission.cancel}
            </Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Divider() {
  const c = useColors();
  return <View style={{ height: 1, backgroundColor: c.border, marginVertical: 4 }} />;
}

interface MenuItemProps {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  color: string;
  onPress: () => void;
}

function MenuItem({ icon, label, hint, color, onPress }: MenuItemProps) {
  const c = useColors();
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      accessibilityRole="menuitem"
      accessibilityLabel={hint ? `${label}. ${hint}` : label}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 11,
        gap: 12,
      }}
    >
      <View
        style={{
          width: 28,
          height: 28,
          borderRadius: 7,
          backgroundColor: `${color}1A`,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {icon}
      </View>
      <YStack flex={1}>
        <Text fontSize={13} color={color} fontWeight="600">
          {label}
        </Text>
        {hint && (
          <Text fontSize={11} color={c.text3} marginTop={1}>
            {hint}
          </Text>
        )}
      </YStack>
    </TouchableOpacity>
  );
}
