import { Play, Video } from '@tamagui/lucide-icons';
import { Image, Linking, Platform } from 'react-native';
import { getDateLocale } from '../../../i18n';
import { Button, Text, XStack, YStack } from 'tamagui'
import { useColors } from '../../mca/primitives/useColors'
import { colors as semanticColors } from '../../mca/primitives/colors';
import { QueuedIndicator, QueuedShimmer } from '../queuedDecorations';
import { SelectableText } from './shared';
import { formatDuration } from './VoiceBubble';

/**
 * Video message bubble - inline player with native controls
 */
export function VideoBubble({
  url,
  caption,
  duration,
  thumbnailUrl,
  timestamp,
  isUser = false,
  showTimestamp = true,
  status,
}: {
  url: string;
  caption?: string;
  duration?: number;
  thumbnailUrl?: string;
  timestamp: Date;
  isUser?: boolean;
  showTimestamp?: boolean;
  status?: 'sending' | 'sent' | 'failed' | 'queued';
}) {
  const c = useColors()
  const handleOpenExternal = () => {
    if (Platform.OS === 'web') {
      window.open(url, '_blank');
    } else {
      Linking.openURL(url);
    }
  };

  const isQueued = status === 'queued';

  return (
    <YStack
      maxWidth="85%"
      gap="$2"
      alignSelf={isUser ? 'flex-end' : 'flex-start'}
      alignItems={isUser ? 'flex-end' : 'flex-start'}
    >
      <YStack
        borderRadius="$4"
        overflow="hidden"
        backgroundColor={c.bgInner}
        position={isQueued ? 'relative' : undefined}
      >
        {isQueued && <QueuedShimmer />}
        {/* Inline video player */}
        {Platform.OS === 'web' ? (
          <video
            src={url}
            controls
            poster={thumbnailUrl}
            style={{
              width: '100%',
              maxWidth: 400,
              borderRadius: 8,
              backgroundColor: c.bgInner,
            }}
          />
        ) : (
          // Fallback for native - show thumbnail with play button
          <XStack
            height={200}
            backgroundColor={c.bgInner}
            alignItems="center"
            justifyContent="center"
            position="relative"
          >
            {thumbnailUrl ? (
              <Image
                source={{ uri: thumbnailUrl }}
                style={{
                  width: '100%',
                  height: '100%',
                  position: 'absolute',
                }}
                resizeMode="cover"
              />
            ) : (
              <Video size={48} color={c.text3} />
            )}

            <Button
              width={56}
              height={56}
              padding={0}
              borderRadius={12}
              backgroundColor={semanticColors.indigo}
              onPress={handleOpenExternal}
              icon={<Play size={24} color="#FFFFFF" />}
              zIndex={1}
            />

            {duration && (
              <Text
                position="absolute"
                bottom={8}
                right={8}
                backgroundColor={c.bgInner}
                paddingHorizontal="$2"
                paddingVertical="$1"
                borderRadius="$2"
                color="white"
                fontSize="$2"
              >
                {formatDuration(duration)}
              </Text>
            )}
          </XStack>
        )}

        {caption && (
          <YStack padding="$2">
            <SelectableText color={c.text} fontSize="$3" selectable>
              {caption}
            </SelectableText>
          </YStack>
        )}
      </YStack>

      {(showTimestamp || isQueued) && (
        <XStack alignItems="center" gap="$2">
          {isQueued && <QueuedIndicator />}
          {showTimestamp && (
            <SelectableText fontSize="$2" color={c.text3} selectable>
              {timestamp.toLocaleTimeString(getDateLocale(), { hour: '2-digit', minute: '2-digit' })}
            </SelectableText>
          )}
        </XStack>
      )}
    </YStack>
  );
}
