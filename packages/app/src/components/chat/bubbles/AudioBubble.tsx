import { Play, RefreshCw, Square } from '@tamagui/lucide-icons';
import { useEffect, useRef, useState } from 'react';
import { Platform, useWindowDimensions } from 'react-native';
import { Button, Text, View, XStack, YStack } from 'tamagui';
import { TerosLoading } from '../../TerosLoading';
import { SelectableText } from './shared';
import { formatDuration } from './VoiceBubble';

/**
 * Audio message bubble - simple player for music, podcasts, etc.
 * No transcription, just playback controls with progress bar
 */
export function AudioBubble({
  url,
  duration,
  caption,
  mimeType,
  timestamp,
  isUser = false,
  showTimestamp = true,
  status,
  onRetry,
}: {
  url: string;
  duration?: number;
  caption?: string;
  mimeType?: string;
  timestamp: Date;
  isUser?: boolean;
  showTimestamp?: boolean;
  status?: 'sending' | 'sent' | 'failed';
  onRetry?: () => void;
}) {
  const { width: screenWidth } = useWindowDimensions();
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(duration || 0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const progressIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const maxWidth = Math.min(screenWidth * 0.7, 400);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
      }
      if (audioRef.current) {
        audioRef.current.pause();
      }
    };
  }, []);

  const togglePlayback = () => {
    if (Platform.OS === 'web') {
      if (!audioRef.current) {
        audioRef.current = new Audio(url);
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
      }

      if (isPlaying) {
        audioRef.current.pause();
        if (progressIntervalRef.current) {
          clearInterval(progressIntervalRef.current);
        }
        setIsPlaying(false);
      } else {
        audioRef.current.play();
        setIsPlaying(true);
        progressIntervalRef.current = setInterval(() => {
          if (audioRef.current) {
            setCurrentTime(audioRef.current.currentTime);
          }
        }, 100);
      }
    }
    // TODO: Native audio playback with expo-audio
  };

  const progress = audioDuration > 0 ? currentTime / audioDuration : 0;
  const displayDuration = audioDuration || duration || 0;

  return (
    <YStack maxWidth="85%" gap="$2" alignSelf={isUser ? 'flex-end' : 'flex-start'}>
      <YStack
        width={maxWidth}
        padding="$3"
        borderRadius="$4"
        backgroundColor="rgba(255, 255, 255, 0.05)"
        borderWidth={1}
        borderColor="rgba(6, 182, 212, 0.2)"
        gap="$2"
      >
        {/* Player controls */}
        <XStack alignItems="center" gap="$3">
          {/* Play/Pause Button */}
          <Button
            width={44}
            height={44}
            padding={0}
            borderRadius={10}
            backgroundColor="rgba(6, 182, 212, 0.2)"
            borderWidth={1}
            borderColor="rgba(6, 182, 212, 0.5)"
            onPress={togglePlayback}
            icon={
              isPlaying ? <Square size={18} color="#06B6D4" /> : <Play size={18} color="#06B6D4" />
            }
          />

          {/* Progress bar and time */}
          <YStack flex={1} gap="$1">
            {/* Progress bar - clickable for seek */}
            <View
              height={12}
              paddingVertical={4}
              cursor="pointer"
              onPress={(e: any) => {
                if (Platform.OS === 'web' && audioRef.current && audioDuration > 0) {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const clickX = e.clientX - rect.left;
                  const percentage = clickX / rect.width;
                  const newTime = percentage * audioDuration;
                  audioRef.current.currentTime = newTime;
                  setCurrentTime(newTime);
                }
              }}
            >
              <View
                height={4}
                backgroundColor="rgba(255, 255, 255, 0.1)"
                borderRadius="$1"
                overflow="hidden"
              >
                <View
                  height="100%"
                  width={`${progress * 100}%`}
                  backgroundColor="#06B6D4"
                  borderRadius="$1"
                />
              </View>
            </View>

            {/* Time display */}
            <XStack justifyContent="space-between">
              <Text color="rgba(255, 255, 255, 0.5)" fontSize="$1">
                {formatDuration(currentTime)}
              </Text>
              <Text color="rgba(255, 255, 255, 0.5)" fontSize="$1">
                {displayDuration > 0 ? formatDuration(displayDuration) : '--:--'}
              </Text>
            </XStack>
          </YStack>
        </XStack>

        {/* Caption if present */}
        {caption && (
          <SelectableText color="rgba(255, 255, 255, 0.7)" fontSize="$3" selectable>
            {caption}
          </SelectableText>
        )}

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
              <XStack alignItems="center" gap="$2">
                <Text fontSize="$1" color="#EF4444">
                  ⚠️ Error al enviar
                </Text>
                {onRetry && (
                  <Button size="$1" chromeless onPress={onRetry} paddingHorizontal="$2">
                    <XStack alignItems="center" gap="$1">
                      <RefreshCw size={12} color="#FF9800" />
                      <Text fontSize="$1" color="#FF9800">
                        Reintentar
                      </Text>
                    </XStack>
                  </Button>
                )}
              </XStack>
            )}
          </XStack>
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
