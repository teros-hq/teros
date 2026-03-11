/**
 * VoiceRecordingBar - Recording indicator with waveform visualization
 *
 * Shows recording status, duration, waveform, and playback controls.
 * Used by InputComposer during voice recording.
 */

import { Play, Square, X } from '@tamagui/lucide-icons';
import React, { useRef, useState } from 'react';
import { Animated } from 'react-native';
import { usePulseAnimation } from '../hooks/usePulseAnimation';
import { Button, Text, View, XStack } from 'tamagui';

// Total number of bars in the waveform
const WAVEFORM_BARS = 40;

// Minimum height for bars (for silence)
const MIN_BAR_HEIGHT = 2;
// Maximum height for bars
const MAX_BAR_HEIGHT = 32;

export type RecordingState = 'idle' | 'recording' | 'stopped';

export interface AudioRecording {
  uri?: string;
  blob?: Blob;
  duration: number;
  url?: string;
}

export interface PauseDetection {
  timestamp: number; // When the pause was detected (ms from start)
  duration: number; // How long the pause lasted (ms)
  sampleIndex: number; // Index in the waveform where pause occurred
}

interface VoiceRecordingBarProps {
  recordingState: RecordingState;
  recordingDuration: number;
  metering: number;
  audioRecording: AudioRecording | null;
  isPlaying: boolean;
  playbackProgress?: number; // 0-1 progress during playback
  onTogglePlayback: () => void;
  onDiscard: () => void;
  onPauseDetected?: (pause: PauseDetection) => void; // Callback when pause is detected
}

// Format duration as m:ss
function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Pulsing red dot component
function PulsingDot() {
  const opacity = usePulseAnimation(true, { minOpacity: 0.3, duration: 500 });

  return (
    <Animated.View
      style={{
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: '#EF4444',
        opacity,
      }}
    />
  );
}

// Waveform visualization component
function Waveform({
  samples,
  isRecording,
  playbackProgress,
}: {
  samples: number[]; // Already normalized 0-1 values (always WAVEFORM_BARS length in preview)
  isRecording: boolean;
  playbackProgress?: number;
}) {
  // Calculate which bar the playback progress line is at
  const progressBarIndex =
    playbackProgress !== undefined ? Math.floor(playbackProgress * WAVEFORM_BARS) : -1;

  // During recording: samples grow from right, empty slots on left
  // In preview: samples fill the entire waveform left-to-right
  const emptySlots = isRecording ? WAVEFORM_BARS - samples.length : 0;

  return (
    <XStack
      flex={1}
      height={MAX_BAR_HEIGHT}
      alignItems="center"
      justifyContent="flex-start"
      gap={2}
    >
      {Array.from({ length: WAVEFORM_BARS }).map((_, index) => {
        const isEmptySlot = index < emptySlots;
        const sampleIndex = index - emptySlots;
        const hasSample = !isEmptySlot && sampleIndex < samples.length;
        const normalizedValue = hasSample ? (samples[sampleIndex] ?? 0) : 0;
        const barHeight = hasSample
          ? MIN_BAR_HEIGHT + normalizedValue * (MAX_BAR_HEIGHT - MIN_BAR_HEIGHT)
          : MIN_BAR_HEIGHT;

        // Determine bar color
        let backgroundColor: string;
        if (isEmptySlot) {
          // Empty slots (not yet recorded) - on the left during recording
          backgroundColor = 'rgba(113, 113, 122, 0.3)';
        } else if (isRecording) {
          // Recording mode - all filled bars are red
          backgroundColor = '#EF4444';
        } else if (progressBarIndex >= 0 && index <= progressBarIndex) {
          // Playback mode - already played bars are cyan
          backgroundColor = '#06B6D4';
        } else {
          // Playback mode - not yet played bars are dimmed cyan
          backgroundColor = 'rgba(6, 182, 212, 0.4)';
        }

        return (
          <View
            key={index}
            width={3}
            borderRadius={1.5}
            backgroundColor={backgroundColor}
            height={barHeight}
          />
        );
      })}
    </XStack>
  );
}

// Expand samples array to target length using interpolation
function expandSamples(samples: number[], targetLength: number): number[] {
  if (samples.length === 0) return Array(targetLength).fill(0.3);
  if (samples.length >= targetLength) return samples.slice(0, targetLength);

  const expanded: number[] = [];
  const ratio = (samples.length - 1) / (targetLength - 1);

  for (let i = 0; i < targetLength; i++) {
    const srcIndex = i * ratio;
    const lowIndex = Math.floor(srcIndex);
    const highIndex = Math.min(lowIndex + 1, samples.length - 1);
    const fraction = srcIndex - lowIndex;

    // Linear interpolation between adjacent samples
    const value = samples[lowIndex] * (1 - fraction) + samples[highIndex] * fraction;
    expanded.push(value);
  }

  return expanded;
}

// Fixed metering range for normalization (typical dB range)
const METERING_MIN = -50; // Silence threshold
const METERING_MAX = 0; // Maximum level

// Pause detection threshold (0-1 normalized value)
// Values below this are considered pauses/silence
const PAUSE_THRESHOLD = 0.15;

// Normalize a metering value to 0-1 using fixed range
function normalizeMetering(value: number): number {
  const normalized = (value - METERING_MIN) / (METERING_MAX - METERING_MIN);
  const clampedValue = Math.max(0.05, Math.min(1, normalized));

  // Apply pause detection: boost low values slightly to make pauses more distinct
  if (clampedValue < PAUSE_THRESHOLD) {
    // Reduce very low values even more to emphasize pauses
    return clampedValue * 0.5;
  }

  return clampedValue;
}

export function VoiceRecordingBar({
  recordingState,
  recordingDuration,
  metering,
  audioRecording,
  isPlaying,
  playbackProgress = 0,
  onTogglePlayback,
  onDiscard,
  onPauseDetected,
}: VoiceRecordingBarProps) {
  // Store already-normalized samples (0-1 values)
  const [samples, setSamples] = useState<number[]>([]);
  // Expanded samples for preview mode (fills entire waveform)
  const [expandedSamples, setExpandedSamples] = useState<number[]>([]);

  const lastMeteringRef = useRef<number | null>(null);
  const recordingStartTimeRef = useRef<number | null>(null);
  const pauseStartRef = useRef<number | null>(null); // Track when a pause started
  const isPausingRef = useRef<boolean>(false); // Track if currently in a pause
  const meteringCountRef = useRef<number>(0); // Counter to control update frequency

  // Reset when starting new recording
  useEffect(() => {
    if (recordingState === 'recording' && samples.length === 0) {
      recordingStartTimeRef.current = Date.now();
      meteringCountRef.current = 0;
    } else if (recordingState === 'idle') {
      setSamples([]);
      setExpandedSamples([]);
      recordingStartTimeRef.current = null;
      meteringCountRef.current = 0;
    }
  }, [recordingState, samples.length]);

  // When recording stops, expand samples to fill entire waveform
  const prevRecordingStateRef = useRef<RecordingState>('idle');
  useEffect(() => {
    // Only expand when transitioning from 'recording' to 'stopped'
    if (
      prevRecordingStateRef.current === 'recording' &&
      recordingState === 'stopped' &&
      samples.length > 0
    ) {
      setExpandedSamples(expandSamples(samples, WAVEFORM_BARS));
    }
    prevRecordingStateRef.current = recordingState;
  }, [recordingState, samples]);

  // Collect and normalize metering samples during recording
  useEffect(() => {
    if (recordingState !== 'recording') return;
    if (metering === lastMeteringRef.current) return;

    lastMeteringRef.current = metering;

    // Normalize immediately using fixed range
    const normalizedValue = normalizeMetering(metering);

    // Pause detection logic
    const isPause = normalizedValue < PAUSE_THRESHOLD;
    const currentTime = Date.now();

    if (isPause && !isPausingRef.current) {
      // Pause started
      isPausingRef.current = true;
      pauseStartRef.current = currentTime;
    } else if (!isPause && isPausingRef.current && pauseStartRef.current) {
      // Pause ended - report it if it lasted at least 200ms
      const pauseDuration = currentTime - pauseStartRef.current;
      if (pauseDuration >= 200 && onPauseDetected) {
        const elapsedMs = recordingStartTimeRef.current
          ? pauseStartRef.current - recordingStartTimeRef.current
          : 0;

        onPauseDetected({
          timestamp: elapsedMs,
          duration: pauseDuration,
          sampleIndex: samples.length,
        });
      }
      isPausingRef.current = false;
      pauseStartRef.current = null;
    }

    // Control update frequency: only add bar every 2nd metering update
    // This slows down the scroll speed to make it more readable
    meteringCountRef.current += 1;
    if (meteringCountRef.current % 2 !== 0) {
      return; // Skip this update
    }

    // Update samples with constant speed scroll effect
    setSamples((prev) => {
      const newSamples = [...prev];

      // If we haven't reached max bars yet, just add
      if (newSamples.length < WAVEFORM_BARS) {
        newSamples.push(normalizedValue);
      } else {
        // Once full, always scroll: shift left and add new bar at the end
        newSamples.shift();
        newSamples.push(normalizedValue);
      }

      return newSamples;
    });
  }, [recordingState, metering, onPauseDetected]);

  // Don't render if idle and no recording
  if (recordingState === 'idle' && !audioRecording) {
    return null;
  }

  const isRecordingMode = recordingState === 'recording';
  const duration = audioRecording?.duration || recordingDuration;

  // Use samples for recording, expanded samples for preview
  const displaySamples = isRecordingMode ? samples : expandedSamples;

  return (
    <XStack
      paddingHorizontal="$3"
      paddingVertical="$3"
      alignItems="center"
      gap="$3"
      borderBottomWidth={1}
      borderBottomColor="rgba(63, 63, 70, 0.5)"
      backgroundColor={isRecordingMode ? 'rgba(239, 68, 68, 0.1)' : 'transparent'}
    >
      {/* Left: Pulsing dot (recording) or Play button (preview) */}
      {isRecordingMode ? (
        <PulsingDot />
      ) : (
        <Button
          width={44}
          height={44}
          padding={0}
          borderRadius={10}
          backgroundColor="rgba(6, 182, 212, 0.2)"
          borderWidth={1}
          borderColor="rgba(6, 182, 212, 0.5)"
          onPress={onTogglePlayback}
          icon={
            isPlaying ? <Square size={20} color="#06B6D4" /> : <Play size={20} color="#06B6D4" />
          }
        />
      )}

      {/* Center: Waveform */}
      <Waveform
        samples={displaySamples}
        isRecording={isRecordingMode}
        playbackProgress={isPlaying ? playbackProgress : undefined}
      />

      {/* Duration */}
      <XStack alignItems="center" gap="$2" minWidth={50} justifyContent="flex-end">
        <Text fontSize={13} color={isRecordingMode ? '#EF4444' : '#06B6D4'}>
          {formatDuration(duration)}
        </Text>
      </XStack>

      {/* Right: Discard button (always X) */}
      <Button
        width={44}
        height={44}
        padding={0}
        borderRadius={10}
        backgroundColor="rgba(39, 39, 42, 0.8)"
        borderWidth={1}
        borderColor="rgba(63, 63, 70, 0.5)"
        onPress={onDiscard}
        icon={<X size={20} color="#71717A" />}
      />
    </XStack>
  );
}
