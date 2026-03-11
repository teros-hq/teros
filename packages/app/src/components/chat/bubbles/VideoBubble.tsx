import { Play, Video } from '@tamagui/lucide-icons';
import { Image, Linking, Platform } from 'react-native';
import { Button, Text, XStack, YStack } from 'tamagui';
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
}: {
  url: string;
  caption?: string;
  duration?: number;
  thumbnailUrl?: string;
  timestamp: Date;
  isUser?: boolean;
  showTimestamp?: boolean;
}) {
  const handleOpenExternal = () => {
    if (Platform.OS === 'web') {
      window.open(url, '_blank');
    } else {
      Linking.openURL(url);
    }
  };

  return (
    <YStack maxWidth="85%" gap="$2" alignSelf={isUser ? 'flex-end' : 'flex-start'}>
      <YStack borderRadius="$4" overflow="hidden" backgroundColor="rgba(255, 255, 255, 0.05)">
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
              backgroundColor: 'rgba(0, 0, 0, 0.3)',
            }}
          />
        ) : (
          // Fallback for native - show thumbnail with play button
          <XStack
            height={200}
            backgroundColor="rgba(0, 0, 0, 0.3)"
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
              <Video size={48} color="rgba(255, 255, 255, 0.3)" />
            )}

            <Button
              width={56}
              height={56}
              padding={0}
              borderRadius={12}
              backgroundColor="rgba(6, 182, 212, 0.9)"
              onPress={handleOpenExternal}
              icon={<Play size={24} color="#FFFFFF" />}
              zIndex={1}
            />

            {duration && (
              <Text
                position="absolute"
                bottom={8}
                right={8}
                backgroundColor="rgba(0, 0, 0, 0.7)"
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
            <SelectableText color="rgba(255, 255, 255, 0.8)" fontSize="$3" selectable>
              {caption}
            </SelectableText>
          </YStack>
        )}
      </YStack>

      {showTimestamp && (
        <SelectableText fontSize="$2" color="rgba(255, 255, 255, 0.4)" selectable>
          {timestamp.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}
        </SelectableText>
      )}
    </YStack>
  );
}
