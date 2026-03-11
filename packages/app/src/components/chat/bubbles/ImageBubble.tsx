import { Image as ImageIcon } from '@tamagui/lucide-icons';
import { useState } from 'react';
import { Image, Platform, useWindowDimensions } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';
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
}: {
  url: string;
  caption?: string;
  width?: number;
  height?: number;
  timestamp: Date;
  isUser?: boolean;
  showTimestamp?: boolean;
}) {
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

  return (
    <YStack maxWidth="85%" gap="$2" alignSelf={isUser ? 'flex-end' : 'flex-start'}>
      <YStack borderRadius="$4" overflow="hidden" backgroundColor="rgba(255, 255, 255, 0.05)">
        {imageError ? (
          <XStack
            width={displayWidth}
            height={150}
            backgroundColor="rgba(255, 255, 255, 0.1)"
            alignItems="center"
            justifyContent="center"
            gap="$2"
          >
            <ImageIcon size={24} color="rgba(255, 255, 255, 0.5)" />
            <Text color="rgba(255, 255, 255, 0.5)" fontSize="$3">
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

      {/* Fullscreen modal for web */}
      {Platform.OS === 'web' && isModalOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.8)',
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
