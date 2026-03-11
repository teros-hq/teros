/**
 * Get Subscription Renderer
 */

import type React from 'react';
import { Text, XStack, YStack } from 'tamagui';
import type { ToolCallRendererProps } from '../../types';
import {
  Badge,
  colors,
  ExpandedBody,
  ExpandedContainer,
  formatCharacters,
  HeaderRow,
  parseOutput,
} from './shared';

// MCA returns snake_case fields directly at root level
interface SubscriptionOutput {
  tier?: string;
  character_count?: number;
  character_limit?: number;
  characters_remaining?: number;
  next_character_count_reset_unix?: number;
  voice_limit?: number;
  professional_voice_limit?: number;
  can_extend_character_limit?: boolean;
  allowed_to_extend_character_limit?: boolean;
  can_use_instant_voice_cloning?: boolean;
  can_use_professional_voice_cloning?: boolean;
  currency?: string;
  status?: string;
}

interface SubRendererProps extends ToolCallRendererProps {
  expanded: boolean;
  onToggle: () => void;
}

export function GetSubscriptionRenderer({
  status,
  output,
  error,
  duration,
  expanded,
  onToggle,
}: SubRendererProps) {
  // Output is the subscription object directly (not wrapped in { subscription: ... })
  const sub = parseOutput<SubscriptionOutput>(output);

  const displayError = error || (status === 'failed' ? output : null);

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : sub?.tier
        ? { text: sub.tier, variant: 'blue' as const }
        : undefined;

  const headerProps = {
    status,
    description: 'Get subscription info',
    duration,
    badge,
    expanded,
    onToggle,
  };

  if (!expanded) {
    return <HeaderRow {...headerProps} />;
  }

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        <YStack backgroundColor={colors.bgInnerDark} borderRadius={6} padding={10} gap={6}>
          {displayError ? (
            <XStack alignItems="flex-start" gap={6}>
              <Text color={colors.muted} fontSize={9} width={80}>
                Error
              </Text>
              <Text color={colors.badgeRed.text} fontSize={10} flex={1}>
                {displayError}
              </Text>
            </XStack>
          ) : sub ? (
            <>
              {/* Tier + status */}
              {sub.tier && (
                <XStack alignItems="center" gap={6}>
                  <Text color={colors.muted} fontSize={9} width={80}>
                    Tier
                  </Text>
                  <Badge text={sub.tier} variant="blue" />
                  {sub.status && sub.status !== 'active' && (
                    <Badge text={sub.status} variant="yellow" />
                  )}
                </XStack>
              )}

              {/* Character usage */}
              {sub.character_count !== undefined && sub.character_limit !== undefined && (
                <XStack alignItems="center" gap={6}>
                  <Text color={colors.muted} fontSize={9} width={80}>
                    Characters
                  </Text>
                  <YStack flex={1} gap={2}>
                    <XStack alignItems="center" gap={4}>
                      <Text color={colors.primary} fontSize={10}>
                        {formatCharacters(sub.character_count)} / {formatCharacters(sub.character_limit)}
                      </Text>
                      <Text color={colors.muted} fontSize={9}>
                        ({((sub.character_count / sub.character_limit) * 100).toFixed(1)}%)
                      </Text>
                    </XStack>
                    {/* Progress bar */}
                    <YStack
                      height={4}
                      backgroundColor={colors.bgInner}
                      borderRadius={2}
                      overflow="hidden"
                    >
                      <YStack
                        height={4}
                        backgroundColor={colors.badgeBlue.text}
                        width={`${Math.min((sub.character_count / sub.character_limit) * 100, 100)}%`}
                      />
                    </YStack>
                  </YStack>
                </XStack>
              )}

              {/* Next reset */}
              {sub.next_character_count_reset_unix && (
                <XStack alignItems="center" gap={6}>
                  <Text color={colors.muted} fontSize={9} width={80}>
                    Resets
                  </Text>
                  <Text color={colors.secondary} fontSize={10}>
                    {new Date(sub.next_character_count_reset_unix * 1000).toLocaleDateString()}
                  </Text>
                </XStack>
              )}

              {/* Voice limit */}
              {sub.voice_limit !== undefined && (
                <XStack alignItems="center" gap={6}>
                  <Text color={colors.muted} fontSize={9} width={80}>
                    Voice limit
                  </Text>
                  <Text color={colors.secondary} fontSize={10}>
                    {sub.voice_limit} voices
                  </Text>
                </XStack>
              )}

              {/* Features */}
              {(sub.can_use_instant_voice_cloning || sub.can_use_professional_voice_cloning) && (
                <XStack alignItems="flex-start" gap={6}>
                  <Text color={colors.muted} fontSize={9} width={80}>
                    Features
                  </Text>
                  <XStack gap={4} flexWrap="wrap" flex={1}>
                    {sub.can_use_instant_voice_cloning && (
                      <Badge text="Instant cloning" variant="green" />
                    )}
                    {sub.can_use_professional_voice_cloning && (
                      <Badge text="Pro cloning" variant="purple" />
                    )}
                  </XStack>
                </XStack>
              )}
            </>
          ) : (
            <Text color={colors.muted} fontSize={10}>
              No subscription data
            </Text>
          )}
        </YStack>
      </ExpandedBody>
    </ExpandedContainer>
  );
}
