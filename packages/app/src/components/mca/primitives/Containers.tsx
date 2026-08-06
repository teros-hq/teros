import { Circle } from './icons';
import type React from 'react';
import { Text, XStack, YStack } from 'tamagui';
import { colors } from './colors';
import { useColors } from './useColors';

export function ExpandedContainer({ children }: { children: React.ReactNode }) {
  const c = useColors();
  return (
    <YStack
      backgroundColor={c.bgCard}
      borderRadius={8}
      borderWidth={1}
      borderColor={c.border}
      overflow="hidden"
      width="100%"
    >
      {children}
    </YStack>
  );
}

export function ExpandedBody({ children }: { children: React.ReactNode }) {
  return (
    <YStack padding={8} gap={6}>
      {children}
    </YStack>
  );
}

interface ErrorBlockProps {
  /** @deprecated use `message` instead. Kept for backwards compatibility. */
  error?: string;
  /** Main error message — concise summary of what went wrong. */
  message?: string;
  /** Short heading (e.g. "Patch failed", "Path traversal blocked"). */
  title?: string;
  /** Multi-line stack trace or extra detail. */
  details?: string;
  /** Suggested next action ("Run `read` first.", "Check workspace roots."). */
  hint?: string;
}

export function ErrorBlock(props: ErrorBlockProps) {
  const c = useColors();
  const message = props.message ?? props.error ?? '';
  const { title, details, hint } = props;
  return (
    <YStack
      backgroundColor={c.badges.err.bg}
      borderColor={c.badges.err.border}
      borderWidth={1}
      borderRadius={6}
      paddingVertical={8}
      paddingHorizontal={10}
      gap={4}
    >
      <XStack gap={6} alignItems="center">
        <Circle size={8} color={colors.red} weight="fill" />
        <Text color={c.badges.err.text} fontSize={11} fontWeight="bold">
          {title ?? 'Error'}
        </Text>
      </XStack>
      {message ? (
        <Text color={c.badges.err.text} fontSize={11} fontFamily="$mono" lineHeight={16}>
          {message}
        </Text>
      ) : null}
      {details ? (
        <Text
          color={c.text2}
          fontSize={10}
          fontFamily="$mono"
          lineHeight={14}
          numberOfLines={8}
        >
          {details}
        </Text>
      ) : null}
      {hint ? (
        <Text color={c.text3} fontSize={10} fontStyle="italic">
          {hint}
        </Text>
      ) : null}
    </YStack>
  );
}

export function SuccessBlock({ message }: { message: string }) {
  const c = useColors();
  return (
    <XStack
      backgroundColor={c.badges.ok.bg}
      borderRadius={5}
      paddingVertical={6}
      paddingHorizontal={8}
      alignItems="center"
      gap={6}
    >
      <Circle size={12} color={colors.green} weight="fill" />
      <Text color={c.badges.ok.text} fontSize={10}>
        {message}
      </Text>
    </XStack>
  );
}
