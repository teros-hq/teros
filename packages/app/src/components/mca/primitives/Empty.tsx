import type React from 'react';
import { Text, YStack } from 'tamagui';
import { useColors } from './useColors';

interface EmptyProps {
  /** Icon opcional encima del mensaje. */
  icon?: React.ReactNode;
  /** Mensaje principal. */
  message: string;
  /** Texto adicional (hint, siguiente acción). */
  hint?: string;
}

/**
 * Estado vacío: icon + mensaje + hint opcional. Centrado con padding
 * generoso para no parecer "bug de data missing".
 */
export function Empty({ icon, message, hint }: EmptyProps): React.ReactNode {
  const c = useColors();
  return (
    <YStack
      paddingVertical={24}
      paddingHorizontal={12}
      alignItems="center"
      justifyContent="center"
      gap={6}
    >
      {icon}
      <Text color={c.text2} fontSize={11} textAlign="center">
        {message}
      </Text>
      {hint && (
        <Text color={c.text3} fontSize={9} fontFamily="$mono" textAlign="center">
          {hint}
        </Text>
      )}
    </YStack>
  );
}
