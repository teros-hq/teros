import { Download, MoreVertical, Pause, Play, RefreshCw, Square } from '@tamagui/lucide-icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, useWindowDimensions } from 'react-native';
import { Button, Popover, Text, View, XStack, YStack } from 'tamagui';
import { TerosLoading } from '../../TerosLoading';
import { SelectableText } from './shared';

// Format duration as m:ss
export function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Voice message bubble with playback controls and transcription
 * Used for voice notes from users or TTS from agents
 */
export function VoiceBubble({
  url,
  data,
  duration,
  transcription,
  timestamp,
  isUser = false,
  showTimestamp = true,
  onRetry,
  onDownload,
  status,
}: {
  url: string;
  data?: string; // Base64 data for offline/retry
  duration?: number;
  transcription?: string;
  timestamp: Date;
  isUser?: boolean;
  showTimestamp?: boolean;
  onRetry?: () => void;
  onDownload?: () => void;
  status?: 'sending' | 'sent' | 'failed';
}) {
  const { width: screenWidth } = useWindowDimensions();
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(duration || 0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const progressIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  // For iOS: calculate max text width based on screen (85% max - padding - button - gap)
  const maxTextWidth = Platform.OS !== 'web' ? screenWidth * 0.85 - 32 - 36 - 16 : undefined;

  // Convert relative URLs to absolute URLs using backend base from env
  const audioUrl = useMemo(() => {
    if (!url) return '';
    if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('blob:')) {
      return url;
    }
    return `${process.env.EXPO_PUBLIC_BACKEND_URL}${url}`;
  }, [url]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
      }
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  // Reset audio when URL changes
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
      setIsPlaying(false);
      setCurrentTime(0);
    }
  }, [audioUrl]);

  const togglePlayback = async () => {
    if (Platform.OS === 'web') {
      try {
        if (!audioRef.current || audioRef.current.src !== audioUrl) {
          // Clean up old audio if exists
          if (audioRef.current) {
            audioRef.current.pause();
          }
          audioRef.current = new Audio(audioUrl);
          audioRef.current.onloadedmetadata = () => {
            if (
              audioRef.current &&
              audioRef.current.duration &&
              isFinite(audioRef.current.duration)
            ) {
              setAudioDuration(audioRef.current.duration);
            }
          };
          audioRef.current.onended = () => {
            setIsPlaying(false);
            setCurrentTime(0);
            if (progressIntervalRef.current) {
              clearInterval(progressIntervalRef.current);
            }
          };
          audioRef.current.onerror = (e) => {
            console.error('[VoiceBubble] Audio error:', e);
            setIsPlaying(false);
          };
        }

        if (isPlaying) {
          audioRef.current.pause();
          if (progressIntervalRef.current) {
            clearInterval(progressIntervalRef.current);
          }
          setIsPlaying(false);
        } else {
          await audioRef.current.play();
          setIsPlaying(true);
          // Update progress every 100ms
          progressIntervalRef.current = setInterval(() => {
            if (audioRef.current) {
              setCurrentTime(audioRef.current.currentTime);
            }
          }, 100);
        }
      } catch (error) {
        console.error('[VoiceBubble] Playback error:', error);
        setIsPlaying(false);
      }
    }
    // TODO: Native audio playback with expo-audio
  };

  // Download audio file
  const handleDownload = () => {
    if (onDownload) {
      onDownload();
      setMenuOpen(false);
      return;
    }

    if (Platform.OS === 'web') {
      const link = document.createElement('a');
      link.href = audioUrl || (data ? `data:audio/webm;base64,${data}` : '');
      link.download = `voice-${timestamp.getTime()}.webm`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
    setMenuOpen(false);
  };

  // Retry sending failed message
  const handleRetry = () => {
    if (onRetry) {
      onRetry();
    }
    setMenuOpen(false);
  };

  const progress = audioDuration > 0 ? currentTime / audioDuration : 0;
  const displayDuration = audioDuration || duration || 0;

  const bgColor = isUser ? '$blue' : 'rgba(255, 255, 255, 0.05)';
  const borderRadius = isUser ? '$4' : '$4';
  const cornerRadius = isUser ? '$1' : '$1';

  return (
    <YStack
      maxWidth="85%"
      {...(Platform.OS !== 'web' ? { width: '85%' } : {})}
      gap="$2"
      alignSelf={isUser ? 'flex-end' : 'flex-start'}
      // @ts-ignore - userSelect is valid for web
      userSelect={Platform.OS === 'web' ? 'text' : undefined}
    >
      <YStack
        padding="$3"
        borderRadius={borderRadius}
        gap="$2"
        backgroundColor={bgColor}
        borderBottomRightRadius={isUser ? cornerRadius : borderRadius}
        borderBottomLeftRadius={isUser ? borderRadius : cornerRadius}
      >
        {/* Transcription with play button */}
        <XStack alignItems="flex-start" gap="$2" flexWrap="nowrap">
          <View
            style={Platform.OS === 'web' ? { flex: 1 } : { flexShrink: 1, maxWidth: maxTextWidth }}
          >
            {transcription ? (
              <SelectableText
                color={isUser ? 'rgba(255, 255, 255, 0.9)' : 'rgba(255, 255, 255, 0.8)'}
                fontSize="$4"
                lineHeight="$2"
                fontStyle="italic"
                selectable
              >
                🎙️ "{transcription}"
              </SelectableText>
            ) : (
              <XStack alignItems="center" gap="$2">
                <TerosLoading
                  size={20}
                  color={isUser ? 'rgba(255, 255, 255, 0.7)' : 'rgba(6, 182, 212, 0.8)'}
                />
                <Text
                  color={isUser ? 'rgba(255, 255, 255, 0.6)' : 'rgba(255, 255, 255, 0.5)'}
                  fontSize="$3"
                  fontStyle="italic"
                >
                  Generating transcription
                </Text>
              </XStack>
            )}
          </View>

          {/* Play/Stop Button */}
          <View style={{ flexShrink: 0 }}>
            <Button
              width={36}
              height={36}
              padding={0}
              borderRadius={8}
              backgroundColor={isUser ? 'rgba(255, 255, 255, 0.2)' : 'rgba(6, 182, 212, 0.2)'}
              borderWidth={1}
              borderColor={isUser ? 'rgba(255, 255, 255, 0.3)' : 'rgba(6, 182, 212, 0.5)'}
              onPress={togglePlayback}
              icon={
                isPlaying ? (
                  <Square size={14} color={isUser ? '#FFFFFF' : '#06B6D4'} />
                ) : (
                  <Play size={14} color={isUser ? '#FFFFFF' : '#06B6D4'} />
                )
              }
            />
          </View>

          {/* Options Menu (three dots) */}
          <Popover open={menuOpen} onOpenChange={setMenuOpen} placement="bottom-end">
            <Popover.Trigger asChild>
              <View style={{ flexShrink: 0 }}>
                <Button
                  size="$2"
                  circular
                  chromeless
                  opacity={0.6}
                  hoverStyle={{ opacity: 1 }}
                  onPress={() => setMenuOpen(true)}
                  icon={<MoreVertical size={14} color={isUser ? '#FFFFFF' : '#888'} />}
                />
              </View>
            </Popover.Trigger>

            <Popover.Content
              backgroundColor="#1a1a1a"
              borderWidth={1}
              borderColor="#333"
              borderRadius={8}
              padding={4}
              elevate
              animation="quick"
              enterStyle={{ opacity: 0, y: -4 }}
              exitStyle={{ opacity: 0, y: -4 }}
            >
              {/* Download option */}
              <XStack
                paddingHorizontal={12}
                paddingVertical={8}
                gap={8}
                alignItems="center"
                borderRadius={4}
                cursor="pointer"
                hoverStyle={{ backgroundColor: 'rgba(6, 182, 212, 0.15)' }}
                onPress={handleDownload}
              >
                <Download size={14} color="#06B6D4" />
                <Text fontSize={13} color="#ccc">
                  Descargar
                </Text>
              </XStack>

              {/* Retry option - only show if failed or has retry handler */}
              {(status === 'failed' || onRetry) && (
                <XStack
                  paddingHorizontal={12}
                  paddingVertical={8}
                  gap={8}
                  alignItems="center"
                  borderRadius={4}
                  cursor="pointer"
                  hoverStyle={{ backgroundColor: 'rgba(255, 152, 0, 0.15)' }}
                  onPress={handleRetry}
                >
                  <RefreshCw size={14} color="#FF9800" />
                  <Text fontSize={13} color="#ccc">
                    Retry sending
                  </Text>
                </XStack>
              )}
            </Popover.Content>
          </Popover>
        </XStack>

        {/* Status indicator for sending/failed */}
        {status && status !== 'sent' && (
          <XStack alignItems="center" gap="$1">
            {status === 'sending' && (
              <>
                <TerosLoading size={12} color="rgba(255, 255, 255, 0.5)" />
                <Text fontSize="$1" color="rgba(255, 255, 255, 0.5)">
                  Enviando...
                </Text>
              </>
            )}
            {status === 'failed' && (
              <>
                <Text fontSize="$1" color="#EF4444">
                  ⚠️ Error al enviar
                </Text>
              </>
            )}
          </XStack>
        )}

        {/* Timestamp */}
        {showTimestamp && (
          <SelectableText
            fontSize="$2"
            color={isUser ? 'rgba(255, 255, 255, 0.7)' : 'rgba(255, 255, 255, 0.4)'}
            selectable
          >
            {timestamp.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}
          </SelectableText>
        )}
      </YStack>
    </YStack>
  );
}
