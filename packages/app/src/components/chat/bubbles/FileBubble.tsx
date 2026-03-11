import { Download, FileText, Image as ImageIcon, Mic, Video } from '@tamagui/lucide-icons';
import { useState } from 'react';
import { Linking, Platform } from 'react-native';
import { Text, View, XStack, YStack } from 'tamagui';
import { SelectableText } from './shared';

/**
 * File/Document message bubble
 */
export function FileBubble({
  url,
  filename,
  caption,
  mimeType,
  size,
  timestamp,
  isUser = false,
  showTimestamp = true,
}: {
  url: string;
  filename: string;
  caption?: string;
  mimeType?: string;
  size?: number;
  timestamp: Date;
  isUser?: boolean;
  showTimestamp?: boolean;
}) {
  const handleDownload = () => {
    if (Platform.OS === 'web') {
      window.open(url, '_blank');
    } else {
      Linking.openURL(url);
    }
  };

  // Format file size
  const formatSize = (bytes?: number) => {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  // Get file icon based on mime type
  const getFileIcon = () => {
    if (mimeType?.startsWith('image/')) return <ImageIcon size={20} color="#06B6D4" />;
    if (mimeType?.startsWith('video/')) return <Video size={20} color="#06B6D4" />;
    if (mimeType?.startsWith('audio/')) return <Mic size={20} color="#06B6D4" />;
    return <FileText size={20} color="#06B6D4" />;
  };

  const [isModalOpen, setIsModalOpen] = useState(false);

  const isImage = mimeType?.startsWith('image/');

  return (
    <YStack maxWidth="85%" gap="$2" alignSelf={isUser ? 'flex-end' : 'flex-start'}>
      <XStack
        padding="$3"
        borderRadius="$4"
        backgroundColor="rgba(255, 255, 255, 0.05)"
        borderWidth={1}
        borderColor="rgba(6, 182, 212, 0.3)"
        alignItems="center"
        gap="$3"
        onPress={handleDownload}
        cursor="pointer"
      >
        <View
          width={40}
          height={40}
          borderRadius="$2"
          backgroundColor="rgba(6, 182, 212, 0.1)"
          alignItems="center"
          justifyContent="center"
        >
          {getFileIcon()}
        </View>

        <YStack flex={1} gap="$1">
          <SelectableText
            color="rgba(255, 255, 255, 0.9)"
            fontSize="$3"
            fontWeight="500"
            selectable
            numberOfLines={1}
          >
            {filename}
          </SelectableText>
          {(size || mimeType) && (
            <Text color="rgba(255, 255, 255, 0.5)" fontSize="$2">
              {[formatSize(size), mimeType?.split('/')[1]?.toUpperCase()]
                .filter(Boolean)
                .join(' • ')}
            </Text>
          )}
        </YStack>

        <Download size={18} color="rgba(6, 182, 212, 0.8)" />
      </XStack>

      {caption && (
        <SelectableText color="rgba(255, 255, 255, 0.7)" fontSize="$3" selectable paddingLeft="$1">
          {caption}
        </SelectableText>
      )}

      {showTimestamp && (
        <SelectableText fontSize="$2" color="rgba(255, 255, 255, 0.4)" selectable>
          {timestamp.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}
        </SelectableText>
      )}

      {isImage && isModalOpen && (
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
          onClick={() => setIsModalOpen(false)}
        >
          <div style={{ maxWidth: '95%', maxHeight: '95%' }} onClick={(e) => e.stopPropagation()}>
            <img
              src={url}
              alt={filename}
              style={{ width: '100%', height: '100%', objectFit: 'contain', borderRadius: 8 }}
            />
          </div>
        </div>
      )}
    </YStack>
  );
}
