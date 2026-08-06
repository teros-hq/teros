import { Text, XStack } from 'tamagui';
import { useColors } from './useColors';

export type BadgeVariant = 'success' | 'error' | 'info' | 'warning' | 'gray';

interface BadgeProps {
  text: string;
  variant: BadgeVariant;
}

const VARIANT_TO_PALETTE_KEY = {
  success: 'ok',
  error: 'err',
  info: 'info',
  warning: 'warn',
  gray: 'gray',
} as const satisfies Record<BadgeVariant, 'ok' | 'err' | 'info' | 'warn' | 'gray'>;

export function Badge({ text, variant }: BadgeProps) {
  const c = useColors();
  const palette = c.badges[VARIANT_TO_PALETTE_KEY[variant]];

  return (
    <XStack backgroundColor={palette.bg} paddingHorizontal={4} paddingVertical={1} borderRadius={3}>
      <Text color={palette.text} fontSize={9} fontFamily="$mono">
        {text}
      </Text>
    </XStack>
  );
}
