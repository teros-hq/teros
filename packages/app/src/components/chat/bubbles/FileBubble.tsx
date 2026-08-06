import { Download, FileText, Image as ImageIcon, Mic, Video } from '@tamagui/lucide-icons';
import { useState } from 'react';
import { getDateLocale } from '../../../i18n';
import { Linking, Platform } from 'react-native';
import { Text, View, XStack, YStack } from 'tamagui'
import { useColors } from '../../mca/primitives/useColors'
import { colors as semanticColors } from '../../mca/primitives/colors';
import { QueuedIndicator, QueuedShimmer } from '../queuedDecorations';
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
  status,
}: {
  url: string;
  filename: string;
  caption?: string;
  mimeType?: string;
  size?: number;
  timestamp: Date;
  isUser?: boolean;
  showTimestamp?: boolean;
  status?: 'sending' | 'sent' | 'failed' | 'queued';
}) {
  const c = useColors()
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
    if (mimeType?.startsWith('image/')) return <ImageIcon size={20} color={semanticColors.indigo} />;
    if (mimeType?.startsWith('video/')) return <Video size={20} color={semanticColors.indigo} />;
    if (mimeType?.startsWith('audio/')) return <Mic size={20} color={semanticColors.indigo} />;
    return <FileText size={20} color={semanticColors.indigo} />;
  };

  const [isModalOpen, setIsModalOpen] = useState(false);

  const isImage = mimeType?.startsWith('image/');

  const isQueued = status === 'queued';

  return (
    <YStack
      maxWidth="85%"
      gap="$2"
      alignSelf={isUser ? 'flex-end' : 'flex-start'}
      alignItems={isUser ? 'flex-end' : 'flex-start'}
    >
      <XStack
        padding="$3"
        borderRadius="$4"
        backgroundColor={c.bgInner}
        borderWidth={1}
        borderColor={`rgba(94, 106, 210, 0.3)`}
        alignItems="center"
        gap="$3"
        onPress={handleDownload}
        cursor="pointer"
        overflow={isQueued ? 'hidden' : undefined}
        position={isQueued ? 'relative' : undefined}
      >
        {isQueued && <QueuedShimmer />}
        <View
          width={40}
          height={40}
          borderRadius="$2"
          backgroundColor={semanticColors.indigoGlow}
          alignItems="center"
          justifyContent="center"
        >
          {getFileIcon()}
        </View>

        <YStack flex={1} gap="$1">
          <SelectableText
            color={c.text}
            fontSize="$3"
            fontWeight="500"
            selectable
            numberOfLines={1}
          >
            {filename}
          </SelectableText>
          {(size || mimeType) && (
            <Text color={c.text3} fontSize="$2">
              {[formatSize(size), mimeType?.split('/')[1]?.toUpperCase()]
                .filter(Boolean)
                .join(' • ')}
            </Text>
          )}
        </YStack>

        <Download size={18} color={semanticColors.indigoLight} />
      </XStack>

      {caption && (
        <SelectableText color={c.text2} fontSize="$3" selectable paddingLeft="$1">
          {caption}
        </SelectableText>
      )}

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

      {isImage && isModalOpen && (
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
