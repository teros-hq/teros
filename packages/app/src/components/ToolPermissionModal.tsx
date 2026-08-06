/**
 * ToolPermissionModal Component
 *
 * Modal dialog for requesting user confirmation before executing a tool.
 * Shows tool name, input parameters, and allow/deny buttons.
 */

import { AlertTriangle, Check, Shield, Wrench, X } from '@tamagui/lucide-icons';
import React from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Modal, ScrollView, TouchableOpacity, View } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';
import { useColors } from './mca/primitives/useColors';
import { colors, controlsBar, indicators } from './mca/primitives/colors';

export interface ToolPermissionRequest {
  requestId: string;
  toolName: string;
  appId: string;
  input: Record<string, any>;
}

interface ToolPermissionModalProps {
  /** Whether the modal is visible */
  visible: boolean;
  /** The permission request data */
  request: ToolPermissionRequest | null;
  /** Callback when user grants permission (one time) */
  onGrant: () => void;
  /** Callback when user grants permission permanently (allow always) */
  onGrantAlways?: () => void;
  /** Callback when user denies permission */
  onDeny: () => void;
}

/**
 * Format input for display - truncate long values
 */
function formatInput(input: Record<string, any>): string {
  try {
    const formatted = JSON.stringify(
      input,
      (key, value) => {
        if (typeof value === 'string' && value.length > 200) {
          return value.substring(0, 200) + '...';
        }
        return value;
      },
      2,
    );
    return formatted;
  } catch {
    return String(input);
  }
}

/**
 * Get a human-readable description of what the tool does
 */
function getToolDescription(toolName: string, input: Record<string, any>, t: TFunction): string {
  // Common tool patterns
  if (toolName.includes('bash') || toolName.includes('shell') || toolName.includes('exec')) {
    return t("permission.executeCommand", { target: input.command || t("permission.defaultCommand") });
  }
  if (toolName.includes('write') || toolName.includes('save')) {
    return t("permission.writeFile", { target: input.filePath || input.path || t("permission.defaultFile") });
  }
  if (toolName.includes('delete') || toolName.includes('remove')) {
    return t("permission.deleteItem", { target: input.filePath || input.path || t("permission.defaultItem") });
  }
  if (toolName.includes('send') && toolName.includes('mail')) {
    return t("permission.sendEmail", { target: input.to || t("permission.defaultRecipient") });
  }
  if (toolName.includes('read') || toolName.includes('get')) {
    return t("permission.readData", { target: input.filePath || input.path || input.url || t("permission.defaultData") });
  }

  return t("permission.executeTool", { target: toolName });
}

export function ToolPermissionModal({
  visible,
  request,
  onGrant,
  onGrantAlways,
  onDeny,
}: ToolPermissionModalProps) {
  const { t } = useTranslation();
  const c = useColors();

  if (!request) return null;

  const description = getToolDescription(request.toolName, request.input, t);
  const formattedInput = formatInput(request.input);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onDeny}>
      <View
        style={{
          flex: 1,
          backgroundColor: c.bgInner,
          justifyContent: 'center',
          alignItems: 'center',
          padding: 20,
        }}
      >
        <YStack
          backgroundColor={c.bgCard}
          borderRadius={16}
          padding={20}
          gap={16}
          maxWidth={500}
          width="100%"
          borderWidth={1}
          borderColor={indicators.risk.border}
        >
          {/* Header */}
          <XStack alignItems="center" gap={12}>
            <View
              style={{
                width: 44,
                height: 44,
                borderRadius: 10,
                backgroundColor: indicators.risk.bg,
                justifyContent: 'center',
                alignItems: 'center',
              }}
            >
              <Shield size={24} color={colors.amber} />
            </View>
            <YStack flex={1}>
              <Text fontSize={18} fontWeight="600" color={c.text}>
                Permiso requerido
              </Text>
              <Text fontSize={13} color={c.text2}>
                This action needs your confirmation
              </Text>
            </YStack>
          </XStack>

          {/* Tool info */}
          <YStack backgroundColor={c.bgInner} padding={14} borderRadius={10} gap={8}>
            <XStack alignItems="center" gap={8}>
              <Wrench size={16} color={c.text3} />
              <Text fontSize={14} fontWeight="600" color={c.text}>
                {request.toolName}
              </Text>
            </XStack>
            <Text fontSize={13} color={c.text2}>
              {description}
            </Text>
          </YStack>

          {/* Input details (collapsible) */}
          <YStack gap={8}>
            <Text fontSize={12} color={c.text3} fontWeight="500">
              Parameters:
            </Text>
            <ScrollView style={{ maxHeight: 150 }} showsVerticalScrollIndicator={true}>
              <YStack backgroundColor={c.bgInner} padding={12} borderRadius={8}>
                <Text fontSize={11} color={c.text2} fontFamily="$mono" style={{ lineHeight: 16 }}>
                  {formattedInput}
                </Text>
              </YStack>
            </ScrollView>
          </YStack>

          {/* Warning */}
          <XStack
            backgroundColor={indicators.risk.bg}
            padding={12}
            borderRadius={8}
            alignItems="flex-start"
            gap={10}
          >
            <AlertTriangle size={16} color={colors.amber} style={{ marginTop: 2 }} />
            <Text fontSize={12} color={colors.amber} flex={1}>
              Review the parameters before allowing. This tool may modify files or
              ejecutar comandos en tu sistema.
            </Text>
          </XStack>

          {/* Action buttons */}
          <YStack gap={10} marginTop={4}>
            {/* Primary actions row */}
            <XStack gap={10}>
              <TouchableOpacity
                onPress={onDeny}
                activeOpacity={0.7}
                style={{
                  flex: 1,
                  backgroundColor: controlsBar.deny.bg,
                  paddingVertical: 12,
                  paddingHorizontal: 14,
                  borderRadius: 10,
                  alignItems: 'center',
                  borderWidth: 1,
                  borderColor: controlsBar.deny.border,
                }}
              >
                <XStack alignItems="center" gap={6}>
                  <X size={16} color={colors.red} />
                  <Text color={colors.red} fontWeight="600" fontSize={13}>
                    Denegar
                  </Text>
                </XStack>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={onGrant}
                activeOpacity={0.7}
                style={{
                  flex: 1,
                  backgroundColor: controlsBar.allow.bg,
                  paddingVertical: 12,
                  paddingHorizontal: 14,
                  borderRadius: 10,
                  alignItems: 'center',
                  borderWidth: 1,
                  borderColor: controlsBar.allow.border,
                }}
              >
                <XStack alignItems="center" gap={6}>
                  <Check size={16} color={colors.green} />
                  <Text color={colors.green} fontWeight="600" fontSize={13}>
                    Permitir
                  </Text>
                </XStack>
              </TouchableOpacity>
            </XStack>

            {/* Allow always button */}
            {onGrantAlways && (
              <TouchableOpacity
                onPress={onGrantAlways}
                activeOpacity={0.7}
                style={{
                  backgroundColor: c.badges.info.bg,
                  paddingVertical: 12,
                  paddingHorizontal: 14,
                  borderRadius: 10,
                  alignItems: 'center',
                  borderWidth: 1,
                  borderColor: c.badges.info.border,
                }}
              >
                <XStack alignItems="center" gap={6}>
                  <Shield size={16} color={colors.indigo} />
                  <Text color={colors.indigo} fontWeight="600" fontSize={13}>
                    Permitir siempre
                  </Text>
                </XStack>
              </TouchableOpacity>
            )}
          </YStack>
        </YStack>
      </View>
    </Modal>
  );
}

export default ToolPermissionModal;
