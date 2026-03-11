import { Platform } from 'react-native';
import { styled, Text } from 'tamagui';

// Selectable Text component for better copy-paste
export const SelectableText = styled(Text, {
  // @ts-ignore - userSelect is valid for web
  userSelect: Platform.OS === 'web' ? 'text' : undefined,
  cursor: Platform.OS === 'web' ? 'text' : undefined,
});
