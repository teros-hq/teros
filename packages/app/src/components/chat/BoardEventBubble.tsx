// ============================================================================
// BOARD EVENT BUBBLE
//
// Renders messages that come from a board subscription
// (metadata.source === 'board_subscription').
// These are system-level notifications about board activity and should
// be displayed in a compact, visually distinct style — not as regular
// chat bubbles.
// ============================================================================

import React from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { Text, XStack, YStack } from 'tamagui'
import { useColors } from '../mca/primitives/useColors'
import { colors as semanticColors } from '../mca/primitives/colors';
import { getDateLocale } from '../../i18n';
import type { Message } from '../../store/chatStore';

interface BoardEventBubbleProps {
  message: Message;
  showTimestamp?: boolean;
}

export function BoardEventBubble({ message, showTimestamp = true }: BoardEventBubbleProps) {
  const { t } = useTranslation()
  const c = useColors()

  const text =
    message.content.type === 'text'
      ? message.content.text
      : t('conversation.boardEvent');

  return (
    <XStack
      width="100%"
      paddingVertical={6}
      paddingHorizontal={12}
      backgroundColor="rgba(94,106,210,0.05)"
      borderTopWidth={1}
      borderBottomWidth={1}
      borderColor="rgba(94,106,210,0.13)"
      alignItems="flex-start"
      gap={8}
      marginVertical={2}
    >
      {/* Left accent bar */}
      <View
        style={{
          width: 2,
          borderRadius: 1,
          backgroundColor: 'rgba(94,106,210,0.55)',
          alignSelf: 'stretch',
          minHeight: 14,
          flexShrink: 0,
        }}
      />

      <YStack flex={1} gap={2}>
        {/* Board badge + content */}
        <XStack alignItems="center" gap={5} flexWrap="wrap">
          <Text
            fontSize={9}
            fontWeight="600"
            color="rgba(94,106,210,0.75)"
            // @ts-ignore — web-only
            style={{ textTransform: 'uppercase', letterSpacing: 0.8 }}
          >
            📋 {t('conversation.board')}
          </Text>
          <Text fontSize={9} color={c.text3}>
            •
          </Text>
          <Text
            fontSize={12}
            color={c.text2}
            lineHeight={17}
            flex={1}
          >
            {text}
          </Text>
        </XStack>

        {/* Timestamp */}
        {showTimestamp && (
          <Text fontSize={10} color={c.text3}>
            {message.timestamp.toLocaleTimeString(getDateLocale(), {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </Text>
        )}
      </YStack>
    </XStack>
  );
}
