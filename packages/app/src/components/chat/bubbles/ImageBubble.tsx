import { Image as ImageIcon } from '@tamagui/lucide-icons';
import { useState } from 'react';
import { getDateLocale } from '../../../i18n';
import { Image, Platform, useWindowDimensions } from 'react-native';
import { Text, XStack, YStack } from 'tamagui'
import { useColors } from '../../mca/primitives/useColors'
import { colors as semanticColors } from '../../mca/primitives/colors';
import { QueuedIndicator, QueuedShimmer } from '../queuedDecorations';
import { SelectableText } from './shared';

/**
 * Image message bubble
 */
export function ImageBubble({
  url,
  caption,
  width,
  height,
  timestamp,
  isUser = false,
  showTimestamp = true,
  status,
}: {
  url: string;
  caption?: string;
  width?: number;
  height?: number;
  timestamp: Date;
  isUser?: boolean;
  showTimestamp?: boolean;
  status?: 'sending' | 'sent' | 'failed' | 'queued';
}) {
  const c = useColors()
  const { width: screenWidth } = useWindowDimensions();
  const maxWidth = screenWidth * 0.7;
  const [imageError, setImageError] = useState(false);

  // Calculate aspect ratio
  const aspectRatio = width && height ? width / height : 16 / 9;
  const displayWidth = Math.min(maxWidth, width || maxWidth);
  const displayHeight = displayWidth / aspectRatio;

  const [isModalOpen, setIsModalOpen] = useState(false);
  const openModal = () => setIsModalOpen(true);
  const closeModal = () => setIsModalOpen(false);

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
        {imageError ? (
          <XStack
            width={displayWidth}
            height={150}
            backgroundColor={c.border}
            alignItems="center"
            justifyContent="center"
            gap="$2"
          >
            <ImageIcon size={24} color={c.text3} />
            <Text color={c.text3} fontSize="$3">
              Error loading image
            </Text>
          </XStack>
        ) : Platform.OS === 'web' ? (
          <img
            src={url}
            alt={caption || 'Image'}
            style={{
              maxWidth: displayWidth,
              maxHeight: 400,
              borderRadius: 8,
              objectFit: 'contain',
              cursor: 'zoom-in',
            }}
            onError={() => setImageError(true)}
            onClick={openModal}
          />
        ) : (
          <Image
            source={{ uri: url }}
            style={{
              width: displayWidth,
              height: Math.min(displayHeight, 400),
              borderRadius: 8,
            }}
            resizeMode="contain"
            onError={() => setImageError(true)}
          />
        )}

        {caption && (
          <YStack padding="$2" paddingTop="$1">
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

      {/* Fullscreen modal for web */}
      {Platform.OS === 'web' && isModalOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: c.bgPage,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10000,
          }}
          onClick={closeModal}
        >
          <div style={{ maxWidth: '95%', maxHeight: '95%' }} onClick={(e) => e.stopPropagation()}>
            <img
              src={url}
              alt={caption || 'Image'}
              style={{ width: '100%', height: '100%', objectFit: 'contain', borderRadius: 8 }}
            />
          </div>
        </div>
      )}
    </YStack>
  );
}
