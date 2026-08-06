/**
 * ContextEditor — unified context editing component for all entity levels.
 *
 * Used by: Workspace, Agent, Project, and Skill windows.
 * Provides a consistent UI with Tamagui TextArea, explicit Save/Cancel,
 * and an optional description header.
 */

import React, { useState, useCallback } from 'react';
import { X, Check, Loader2 } from '@tamagui/lucide-icons';
import { Button, Text, TextArea, XStack, YStack } from 'tamagui';
import { useColors } from './mca/primitives/useColors';
import { colors as semanticColors } from './mca/primitives/colors';

export interface ContextEditorProps {
  /** Visible title above the editor */
  title: string;
  /** Optional explanatory text below the title */
  description?: string;
  /** Current value (controlled) */
  value: string;
  /** Called on every keystroke */
  onChange: (value: string) => void;
  /** Called when user presses Save */
  onSave: () => Promise<void>;
  /** Called when user presses Cancel. If omitted, Cancel is hidden. */
  onCancel?: () => void;
  /** Whether a save is in flight */
  isSaving?: boolean;
  /** Placeholder text for the empty state */
  placeholder?: string;
  /** Minimum height of the text area (px) */
  minHeight?: number;
  /** When true, hides the Save/Cancel footer (use inside forms that have their own buttons) */
  formMode?: boolean;
  /** Disable editing */
  readOnly?: boolean;
}

export function ContextEditor({
  title,
  description,
  value,
  onChange,
  onSave,
  onCancel,
  isSaving = false,
  placeholder = 'Write context here...',
  minHeight = 160,
  formMode = false,
  readOnly = false,
}: ContextEditorProps) {
  const [hasChanges, setHasChanges] = useState(false);
  const c = useColors();

  const handleChange = useCallback(
    (text: string) => {
      onChange(text);
      setHasChanges(true);
    },
    [onChange],
  );

  const handleSave = useCallback(async () => {
    await onSave();
    setHasChanges(false);
  }, [onSave]);

  const handleCancel = useCallback(() => {
    onCancel?.();
    setHasChanges(false);
  }, [onCancel]);

  return (
    <YStack gap={12}>
      {/* Header */}
      <YStack gap={4}>
        <Text fontSize={14} fontWeight="600" color={c.text}>
          {title}
        </Text>
        {description ? (
          <Text fontSize={12} color={c.text2} lineHeight={18}>
            {description}
          </Text>
        ) : null}
      </YStack>

      {/* Editor */}
      <YStack
        backgroundColor={c.bgInner}
        borderRadius={8}
        borderWidth={1}
        borderColor={hasChanges ? semanticColors.indigo : c.border}
        padding={12}
        gap={12}
      >
        <TextArea
          value={value}
          onChangeText={handleChange}
          placeholder={placeholder}
          placeholderTextColor={c.text3}
          multiline
          numberOfLines={8}
          minHeight={minHeight}
          backgroundColor="transparent"
          borderWidth={0}
          color={c.text}
          fontSize={13}
          lineHeight={20}
          padding={8}
          disabled={readOnly || isSaving}
          style={{}}
        />

        {/* Footer — hidden in formMode (parent form handles Save/Cancel) */}
        {!formMode && (
          <XStack justifyContent="space-between" alignItems="center">
            <Text fontSize={11} color={hasChanges ? semanticColors.indigo : c.text3}>
              {isSaving
                ? 'Saving...'
                : hasChanges
                  ? 'Unsaved changes'
                  : 'All changes saved'}
            </Text>

            <XStack gap={8}>
              {onCancel && (
                <Button
                  size="$2"
                  backgroundColor={c.bgCard}
                  color={c.text2}
                  borderRadius={6}
                  paddingHorizontal={12}
                  disabled={isSaving}
                  opacity={isSaving ? 0.5 : 1}
                  icon={<X size={14} color={c.text2} />}
                  onPress={handleCancel}
                  hoverStyle={{ backgroundColor: c.bgCardHover }}
                >
                  Cancel
                </Button>
              )}
              <Button
                size="$2"
                backgroundColor={semanticColors.indigo}
                color={c.text}
                borderRadius={6}
                paddingHorizontal={12}
                disabled={isSaving || !hasChanges}
                opacity={isSaving || !hasChanges ? 0.5 : 1}
                icon={
                  isSaving ? (
                    <Loader2 size={14} color={c.text} />
                  ) : (
                    <Check size={14} color={c.text} />
                  )
                }
                onPress={handleSave}
                hoverStyle={{ backgroundColor: semanticColors.indigoLight }}
              >
                {isSaving ? 'Saving...' : 'Save'}
              </Button>
            </XStack>
          </XStack>
        )}
      </YStack>
    </YStack>
  );
}
