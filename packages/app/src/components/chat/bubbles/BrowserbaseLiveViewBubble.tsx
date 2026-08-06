/**
 * BrowserbaseLiveViewBubble
 *
 * Chat bubble rendered when the agent calls session-create on Browserbase.
 * Shows a compact card with session info and a button to open the Live View window.
 */

import { ExternalLink, MonitorPlay } from '@tamagui/lucide-icons';
import React from 'react';
import { getDateLocale } from '../../../i18n';
import { Text, XStack, YStack } from 'tamagui'
import { useColors } from '../../mca/primitives/useColors'
import { colors as semanticColors } from '../../mca/primitives/colors';
import { useTilingStore } from '../../../store/tilingStore';
import { SelectableText } from './shared';

interface Props {
  sessionId: string;
  url: string;
  caption?: string;
  timestamp: Date;
  showTimestamp?: boolean;
}

export function BrowserbaseLiveViewBubble({
  sessionId,
  url,
  caption,
  timestamp,
  showTimestamp = true,
}: Props) {
  const c = useColors()
  const openWindow = useTilingStore((s) => s.openWindow);
  const shortId = sessionId.slice(0, 8);

  const handleOpen = () => {
    openWindow('browserbase-live-view', { sessionId, liveViewUrl: url, caption }, true);
  };

  return (
    <YStack maxWidth="85%" gap="$2" alignSelf="flex-start">
      {/* Card */}
      <YStack
        backgroundColor={`rgba(94,106,210,0.08)`}
        borderRadius={10}
        borderWidth={1}
        borderColor={`rgba(94,106,210,0.25)`}
        overflow="hidden"
        width={320}
      >
        {/* Header */}
        <XStack
          paddingHorizontal={12}
          paddingVertical={8}
          alignItems="center"
          gap={8}
          borderBottomWidth={1}
          borderBottomColor={`rgba(94,106,210,0.15)`}
        >
          <MonitorPlay size={14} color={semanticColors.indigo} />
          <Text color={semanticColors.indigoLight} fontSize={12} fontWeight="600" flex={1}>
            Browserbase Session
          </Text>
          {/* Live dot */}
          <XStack alignItems="center" gap={4}>
            <YStack
              width={6}
              height={6}
              borderRadius={3}
              backgroundColor={semanticColors.green}
              // @ts-ignore web-only
              style={{ animation: 'pulse 2s infinite' }}
            />
            <Text color={semanticColors.green} fontSize={9} fontWeight="700">LIVE</Text>
          </XStack>
        </XStack>

        {/* Session ID row */}
        <XStack
          paddingHorizontal={12}
          paddingVertical={6}
          alignItems="center"
          gap={8}
        >
          <Text color={c.text3} fontSize={10}>Session</Text>
          <Text color={c.text2} fontSize={10} fontFamily="$mono" flex={1}>
            {shortId}…
          </Text>
        </XStack>

        {/* Open Live View button */}
        <XStack
          margin={8}
          marginTop={4}
          backgroundColor={`rgba(94,106,210,0.15)`}
          borderRadius={7}
          borderWidth={1}
          borderColor={`rgba(94,106,210,0.3)`}
          paddingVertical={8}
          paddingHorizontal={12}
          alignItems="center"
          gap={8}
          onPress={handleOpen}
          cursor="pointer"
          pressStyle={{ opacity: 0.7 }}
          hoverStyle={{ backgroundColor: `rgba(94,106,210,0.25)` }}
        >
          <ExternalLink size={12} color={semanticColors.indigoLight} />
          <Text color={semanticColors.indigoLight} fontSize={12} fontWeight="600" flex={1}>
            Open Live View
          </Text>
        </XStack>
      </YStack>

      {caption && (
        <SelectableText color={c.text2} fontSize="$3" selectable>
          {caption}
        </SelectableText>
      )}

      {showTimestamp && (
        <SelectableText fontSize="$2" color={c.text3} selectable>
          {timestamp.toLocaleTimeString(getDateLocale(), { hour: '2-digit', minute: '2-digit' })}
        </SelectableText>
      )}
    </YStack>
  );
}
