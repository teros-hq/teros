import { Play, RefreshCw, Square } from '@tamagui/lucide-icons';
import { useEffect, useRef, useState } from 'react';
import { getDateLocale } from '../../../i18n';
import { Platform, useWindowDimensions } from 'react-native';
import { Button, Text, View, XStack, YStack } from 'tamagui'
import { useColors } from '../../mca/primitives/useColors'
import { colors as semanticColors } from '../../mca/primitives/colors';
import { TerosLoading } from '../../TerosLoading';
import { SelectableText } from './shared';
import { QueuedIndicator, QueuedShimmer } from '../queuedDecorations';
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
  status?: 'sending' | 'sent' | 'failed' | 'queued';
  onRetry?: () => void;
}) {
  const c = useColors()
  const { width: screenWidth } = useWindowDimensions();
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(duration || 0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const progressIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  const isQueued = status === 'queued';

  return (
    <YStack
      maxWidth="85%"
      gap="$2"
      alignSelf={isUser ? 'flex-end' : 'flex-start'}
      alignItems={isUser ? 'flex-end' : 'flex-start'}
    >
      <YStack
        width={maxWidth}
        padding="$3"
        borderRadius="$4"
        backgroundColor={c.bgInner}
        borderWidth={1}
        borderColor={`rgba(94, 106, 210, 0.2)`}
        gap="$2"
        overflow={isQueued ? 'hidden' : undefined}
        position={isQueued ? 'relative' : undefined}
      >
        {isQueued && <QueuedShimmer />}
        {/* Player controls */}
        <XStack alignItems="center" gap="$3">
          {/* Play/Pause Button */}
          <Button
            width={44}
            height={44}
            padding={0}
            borderRadius={10}
            backgroundColor={semanticColors.indigoGlow}
            borderWidth={1}
            borderColor={`rgba(94, 106, 210, 0.5)`}
            onPress={togglePlayback}
            icon={
              isPlaying ? <Square size={18} color={semanticColors.indigo} /> : <Play size={18} color={semanticColors.indigo} />
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
                backgroundColor={c.border}
                borderRadius="$1"
                overflow="hidden"
              >
                <View
                  height="100%"
                  width={`${progress * 100}%`}
                  backgroundColor={semanticColors.indigo}
                  borderRadius="$1"
                />
              </View>
            </View>

            {/* Time display */}
            <XStack justifyContent="space-between">
              <Text color={c.text3} fontSize="$1">
                {formatDuration(currentTime)}
              </Text>
              <Text color={c.text3} fontSize="$1">
                {displayDuration > 0 ? formatDuration(displayDuration) : '--:--'}
              </Text>
            </XStack>
          </YStack>
        </XStack>

        {/* Caption if present */}
        {caption && (
          <SelectableText color={c.text2} fontSize="$3" selectable>
            {caption}
          </SelectableText>
        )}

        {/* Status indicator for sending/failed */}
        {status && status !== 'sent' && (
          <XStack alignItems="center" gap="$1">
            {status === 'sending' && (
              <>
                <TerosLoading size={12} color={c.text3} />
                <Text fontSize="$1" color={c.text3}>
                  Enviando...
                </Text>
              </>
            )}
            {status === 'failed' && (
              <XStack alignItems="center" gap="$2">
                <Text fontSize="$1" color={semanticColors.red}>
                  ⚠️ Error al enviar
                </Text>
                {onRetry && (
                  <Button size="$1" chromeless onPress={onRetry} paddingHorizontal="$2">
                    <XStack alignItems="center" gap="$1">
                      <RefreshCw size={12} color={semanticColors.amber} />
                      <Text fontSize="$1" color={semanticColors.amber}>
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
