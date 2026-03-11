/**
 * ToolPermissionModal Component
 *
 * Modal dialog for requesting user confirmation before executing a tool.
 * Shows tool name, input parameters, and allow/deny buttons.
 */

import { AlertTriangle, Check, Shield, Wrench, X } from '@tamagui/lucide-icons';
import React from 'react';
import { Modal, ScrollView, TouchableOpacity, View } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';

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
function getToolDescription(toolName: string, input: Record<string, any>): string {
  // Common tool patterns
  if (toolName.includes('bash') || toolName.includes('shell') || toolName.includes('exec')) {
    return `Ejecutar comando: ${input.command || 'comando del sistema'}`;
  }
  if (toolName.includes('write') || toolName.includes('save')) {
    return `Escribir archivo: ${input.filePath || input.path || 'archivo'}`;
  }
  if (toolName.includes('delete') || toolName.includes('remove')) {
    return `Eliminar: ${input.filePath || input.path || 'elemento'}`;
  }
  if (toolName.includes('send') && toolName.includes('mail')) {
    return `Enviar email a: ${input.to || 'destinatario'}`;
  }
  if (toolName.includes('read') || toolName.includes('get')) {
    return `Leer: ${input.filePath || input.path || input.url || 'datos'}`;
  }

  return `Ejecutar herramienta: ${toolName}`;
}

export function ToolPermissionModal({
  visible,
  request,
  onGrant,
  onGrantAlways,
  onDeny,
}: ToolPermissionModalProps) {
  if (!request) return null;

  const description = getToolDescription(request.toolName, request.input);
  const formattedInput = formatInput(request.input);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onDeny}>
      <View
        style={{
          flex: 1,
          backgroundColor: 'rgba(0, 0, 0, 0.8)',
          justifyContent: 'center',
          alignItems: 'center',
          padding: 20,
        }}
      >
        <YStack
          backgroundColor="#18181B"
          borderRadius={16}
          padding={20}
          gap={16}
          maxWidth={500}
          width="100%"
          borderWidth={1}
          borderColor="rgba(245, 158, 11, 0.3)"
        >
          {/* Header */}
          <XStack alignItems="center" gap={12}>
            <View
              style={{
                width: 44,
                height: 44,
                borderRadius: 10,
                backgroundColor: 'rgba(245, 158, 11, 0.15)',
                justifyContent: 'center',
                alignItems: 'center',
              }}
            >
              <Shield size={24} color="#F59E0B" />
            </View>
            <YStack flex={1}>
              <Text fontSize={18} fontWeight="600" color="#FAFAFA">
                Permiso requerido
              </Text>
              <Text fontSize={13} color="#A1A1AA">
                This action needs your confirmation
              </Text>
            </YStack>
          </XStack>

          {/* Tool info */}
          <YStack backgroundColor="rgba(0, 0, 0, 0.3)" padding={14} borderRadius={10} gap={8}>
            <XStack alignItems="center" gap={8}>
              <Wrench size={16} color="#71717A" />
              <Text fontSize={14} fontWeight="600" color="#E4E4E7">
                {request.toolName}
              </Text>
            </XStack>
            <Text fontSize={13} color="#A1A1AA">
              {description}
            </Text>
          </YStack>

          {/* Input details (collapsible) */}
          <YStack gap={8}>
            <Text fontSize={12} color="#71717A" fontWeight="500">
              Parameters:
            </Text>
            <ScrollView style={{ maxHeight: 150 }} showsVerticalScrollIndicator={true}>
              <YStack backgroundColor="rgba(0, 0, 0, 0.4)" padding={12} borderRadius={8}>
                <Text fontSize={11} color="#A1A1AA" fontFamily="$mono" style={{ lineHeight: 16 }}>
                  {formattedInput}
                </Text>
              </YStack>
            </ScrollView>
          </YStack>

          {/* Warning */}
          <XStack
            backgroundColor="rgba(245, 158, 11, 0.1)"
            padding={12}
            borderRadius={8}
            alignItems="flex-start"
            gap={10}
          >
            <AlertTriangle size={16} color="#F59E0B" style={{ marginTop: 2 }} />
            <Text fontSize={12} color="#F59E0B" flex={1}>
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
                  backgroundColor: 'rgba(239, 68, 68, 0.15)',
                  paddingVertical: 12,
                  paddingHorizontal: 14,
                  borderRadius: 10,
                  alignItems: 'center',
                  borderWidth: 1,
                  borderColor: 'rgba(239, 68, 68, 0.3)',
                }}
              >
                <XStack alignItems="center" gap={6}>
                  <X size={16} color="#EF4444" />
                  <Text color="#EF4444" fontWeight="600" fontSize={13}>
                    Denegar
                  </Text>
                </XStack>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={onGrant}
                activeOpacity={0.7}
                style={{
                  flex: 1,
                  backgroundColor: 'rgba(16, 185, 129, 0.15)',
                  paddingVertical: 12,
                  paddingHorizontal: 14,
                  borderRadius: 10,
                  alignItems: 'center',
                  borderWidth: 1,
                  borderColor: 'rgba(16, 185, 129, 0.3)',
                }}
              >
                <XStack alignItems="center" gap={6}>
                  <Check size={16} color="#10B981" />
                  <Text color="#10B981" fontWeight="600" fontSize={13}>
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
                  backgroundColor: 'rgba(59, 130, 246, 0.1)',
                  paddingVertical: 12,
                  paddingHorizontal: 14,
                  borderRadius: 10,
                  alignItems: 'center',
                  borderWidth: 1,
                  borderColor: 'rgba(59, 130, 246, 0.25)',
                }}
              >
                <XStack alignItems="center" gap={6}>
                  <Shield size={16} color="#3B82F6" />
                  <Text color="#3B82F6" fontWeight="600" fontSize={13}>
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
