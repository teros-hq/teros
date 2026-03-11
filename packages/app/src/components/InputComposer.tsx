/**
 * InputComposer - Native (iOS/Android) version
 *
 * Full-featured input with text and audio recording support.
 * Uses expo-audio for audio recording with real-time waveform visualization.
 */

import { AlertCircle, Mic, Pause, Send, X } from '@tamagui/lucide-icons';
import {
  type RecordingOptions,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard, Platform, StyleSheet, TextInput } from 'react-native';
import { Button, Text, XStack, YStack } from 'tamagui';
import { STORAGE_KEYS, storage } from '../services/storage';
import { type AudioRecording, type RecordingState, VoiceRecordingBar } from './VoiceRecordingBar';

type RecordingError = 'permission_denied' | 'not_supported' | 'unknown' | null;

interface InputComposerProps {
  onSend: (message: string, audio?: AudioRecording) => void;
  disabled?: boolean;
  placeholder?: string;
  bottomInset?: number;
  channelId?: string; // For saving/restoring drafts
}

// Custom recording options with metering enabled
const RECORDING_OPTIONS_WITH_METERING: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  isMeteringEnabled: true,
};

export function InputComposer({
  onSend,
  disabled = false,
  placeholder = 'Escribe un mensaje...',
  bottomInset = 0,
  channelId,
}: InputComposerProps) {
  const [text, setText] = useState('');
  const [keyboardVisible, setKeyboardVisible] = useState(false);

  // Load draft from storage when channelId changes
  useEffect(() => {
    if (!channelId) return;

    const loadDraft = async () => {
      try {
        const draftsJson = await storage.getItem(STORAGE_KEYS.MESSAGE_DRAFTS);
        if (draftsJson) {
          const drafts = JSON.parse(draftsJson);
          if (drafts[channelId]) {
            setText(drafts[channelId]);
          }
        }
      } catch (e) {
        console.error('Failed to load draft:', e);
      }
    };

    loadDraft();
  }, [channelId]);

  // Save draft to storage when text changes (debounced)
  useEffect(() => {
    if (!channelId) return;

    const saveDraft = async () => {
      try {
        const draftsJson = await storage.getItem(STORAGE_KEYS.MESSAGE_DRAFTS);
        const drafts = draftsJson ? JSON.parse(draftsJson) : {};

        if (text.trim()) {
          drafts[channelId] = text;
        } else {
          delete drafts[channelId]; // Remove empty drafts
        }

        await storage.setItem(STORAGE_KEYS.MESSAGE_DRAFTS, JSON.stringify(drafts));
      } catch (e) {
        console.error('Failed to save draft:', e);
      }
    };

    // Debounce to avoid too many writes
    const timeoutId = setTimeout(saveDraft, 500);
    return () => clearTimeout(timeoutId);
  }, [text, channelId]);
  const [recordingState, setRecordingState] = useState<RecordingState>('idle');
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [audioRecording, setAudioRecording] = useState<AudioRecording | null>(null);
  const [recordingError, setRecordingError] = useState<RecordingError>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  const inputRef = useRef<TextInput>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // expo-audio recorder hook with metering enabled
  const recorder = useAudioRecorder(RECORDING_OPTIONS_WITH_METERING);

  // Get recorder state for metering (poll every 100ms for smooth visualization)
  const recorderState = useAudioRecorderState(recorder, 100);

  // Audio player for playback
  const player = useAudioPlayer(audioRecording?.uri || null);
  const playerStatus = useAudioPlayerStatus(player);

  // Calculate playback progress (0-1)
  const playbackProgress =
    playerStatus.duration > 0 ? playerStatus.currentTime / playerStatus.duration : 0;

  // Keyboard listeners
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const showSubscription = Keyboard.addListener(showEvent, () => {
      setKeyboardVisible(true);
    });
    const hideSubscription = Keyboard.addListener(hideEvent, () => {
      setKeyboardVisible(false);
    });

    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopTimer();
    };
  }, []);

  // Timer functions
  const startTimer = useCallback(() => {
    timerRef.current = setInterval(() => {
      setRecordingDuration((prev) => prev + 1);
    }, 1000);
  }, []);

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Start audio recording
  const startRecording = async () => {
    setRecordingError(null);

    try {
      const { granted } = await requestRecordingPermissionsAsync();
      if (!granted) {
        setRecordingError('permission_denied');
        return;
      }

      // Configure audio mode for recording (required on iOS)
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });

      // Prepare and start recording
      await recorder.prepareToRecordAsync();
      recorder.record();

      setRecordingState('recording');
      setRecordingDuration(0);
      startTimer();
    } catch (error) {
      console.error('Failed to start recording:', error);
      setRecordingError('unknown');
    }
  };

  // Stop and finalize recording
  const stopRecording = async () => {
    stopTimer();

    try {
      await recorder.stop();
      const uri = recorder.uri;

      // Reset audio mode after recording
      await setAudioModeAsync({
        allowsRecording: false,
      });

      if (uri) {
        setAudioRecording({
          uri,
          duration: recordingDuration,
        });
      }

      setRecordingState('stopped');
    } catch (error) {
      console.error('Failed to stop recording:', error);
      setRecordingError('unknown');
    }
  };

  // Discard recording
  const discardRecording = useCallback(async () => {
    stopTimer();

    try {
      if (recorder.isRecording) {
        await recorder.stop();
      }
      // Reset audio mode
      await setAudioModeAsync({
        allowsRecording: false,
      });
    } catch {}

    // Stop player if playing
    if (player.playing) {
      player.pause();
    }

    setRecordingState('idle');
    setRecordingDuration(0);
    setAudioRecording(null);
    setIsPlaying(false);
  }, [recorder, player, stopTimer]);

  // Play/stop audio preview
  const togglePlayback = useCallback(async () => {
    if (!audioRecording?.uri) return;

    if (isPlaying) {
      player.pause();
      setIsPlaying(false);
    } else {
      // Make sure audio mode allows playback
      await setAudioModeAsync({
        playsInSilentMode: true,
      });
      player.play();
      setIsPlaying(true);
    }
  }, [audioRecording?.uri, isPlaying, player]);

  // Listen for player status to update isPlaying
  useEffect(() => {
    if (playerStatus.didJustFinish && isPlaying) {
      setIsPlaying(false);
    }
  }, [playerStatus.didJustFinish, isPlaying]);

  // Dismiss error
  const dismissError = useCallback(() => {
    setRecordingError(null);
  }, []);

  // Handle mic button press
  const handleMicPress = () => {
    if (recordingState === 'idle') {
      startRecording();
    }
  };

  // Handle pause (stops recording and goes to preview mode)
  const handlePause = useCallback(() => {
    if (recordingState === 'recording') {
      stopRecording();
    }
  }, [recordingState]);

  // Handle send - if recording, stops and sends; otherwise just sends
  const handleSend = useCallback(async () => {
    // Can send if there's text, audio recording, OR currently recording
    const hasContent =
      text.trim().length > 0 || audioRecording !== null || recordingState === 'recording';
    if (!hasContent || disabled) return;

    // If still recording, stop first and get the recording
    if (recordingState === 'recording') {
      stopTimer();
      try {
        await recorder.stop();
        const uri = recorder.uri;
        await setAudioModeAsync({ allowsRecording: false });

        // Stop player if playing
        if (player.playing) {
          player.pause();
        }

        // Send with the new recording
        const newRecording = uri ? { uri, duration: recordingDuration } : undefined;
        onSend(text.trim(), newRecording);

        // Reset state
        setText('');
        setAudioRecording(null);
        setRecordingState('idle');
        setRecordingDuration(0);
        setIsPlaying(false);
        Keyboard.dismiss();

        // Clear draft from storage
        if (channelId) {
          storage
            .getItem(STORAGE_KEYS.MESSAGE_DRAFTS)
            .then((draftsJson) => {
              const drafts = draftsJson ? JSON.parse(draftsJson) : {};
              delete drafts[channelId];
              storage.setItem(STORAGE_KEYS.MESSAGE_DRAFTS, JSON.stringify(drafts));
            })
            .catch((e) => console.error('Failed to clear draft:', e));
        }
        return;
      } catch (error) {
        console.error('Failed to stop recording:', error);
        setRecordingError('unknown');
        return;
      }
    }

    // Stop player if playing
    if (player.playing) {
      player.pause();
    }

    onSend(text.trim(), audioRecording || undefined);

    // Reset state
    setText('');
    setAudioRecording(null);
    setRecordingState('idle');
    setRecordingDuration(0);
    setIsPlaying(false);
    Keyboard.dismiss();

    // Clear draft from storage
    if (channelId) {
      storage
        .getItem(STORAGE_KEYS.MESSAGE_DRAFTS)
        .then((draftsJson) => {
          const drafts = draftsJson ? JSON.parse(draftsJson) : {};
          delete drafts[channelId];
          storage.setItem(STORAGE_KEYS.MESSAGE_DRAFTS, JSON.stringify(drafts));
        })
        .catch((e) => console.error('Failed to clear draft:', e));
    }
  }, [
    text,
    audioRecording,
    disabled,
    recordingState,
    recordingDuration,
    recorder,
    player,
    stopTimer,
    onSend,
    channelId,
  ]);

  // Get error message
  const getErrorMessage = (error: RecordingError): string => {
    switch (error) {
      case 'permission_denied':
        return 'Microphone permission denied. Enable it in Settings.';
      case 'not_supported':
        return 'Audio recording not supported.';
      default:
        return 'Recording error. Please try again.';
    }
  };

  const hasContent =
    text.trim().length > 0 || audioRecording !== null || recordingState === 'recording';
  const canSend = hasContent && !disabled;
  const effectiveBottomPadding = keyboardVisible ? 8 : bottomInset + 8;
  const isRecordingOrStopped = recordingState !== 'idle';
  const inputPlaceholder = isRecordingOrStopped ? 'Add a note...' : placeholder;

  return (
    <YStack
      backgroundColor="rgba(24, 24, 27, 0.95)"
      borderTopWidth={1}
      borderTopColor="rgba(63, 63, 70, 0.5)"
    >
      {/* Error Banner */}
      {recordingError && (
        <XStack
          paddingHorizontal="$3"
          paddingVertical="$2"
          alignItems="center"
          justifyContent="space-between"
          backgroundColor="#7F1D1D"
          borderBottomWidth={1}
          borderBottomColor="#991B1B"
        >
          <XStack alignItems="center" gap="$2" flex={1}>
            <AlertCircle size={16} color="#FCA5A5" />
            <Text fontSize={12} color="#FCA5A5" flex={1}>
              {getErrorMessage(recordingError)}
            </Text>
          </XStack>
          <Button
            size="$2"
            circular
            chromeless
            onPress={dismissError}
            icon={<X size={14} color="#FCA5A5" />}
          />
        </XStack>
      )}

      {/* Voice Recording Bar */}
      <VoiceRecordingBar
        recordingState={recordingState}
        recordingDuration={recordingDuration}
        metering={recorderState.metering ?? -60}
        audioRecording={audioRecording}
        isPlaying={isPlaying}
        playbackProgress={playbackProgress}
        onTogglePlayback={togglePlayback}
        onDiscard={discardRecording}
      />

      {/* Main Input Area */}
      <YStack paddingHorizontal="$3" paddingTop="$2" paddingBottom={effectiveBottomPadding}>
        <XStack alignItems="flex-end" gap="$2">
          {/* Mic/Pause Button - Mic in idle/stopped, Pause during recording */}
          <Button
            width={44}
            height={44}
            padding={0}
            borderRadius={10}
            backgroundColor={
              recordingState === 'recording'
                ? 'rgba(239, 68, 68, 0.2)' // Red background during recording
                : recordingState === 'stopped'
                  ? 'rgba(6, 182, 212, 0.2)' // Cyan background when stopped
                  : 'rgba(39, 39, 42, 0.8)' // Gray background when idle
            }
            borderWidth={1}
            borderColor={
              recordingState === 'recording'
                ? 'rgba(239, 68, 68, 0.5)' // Red border during recording
                : recordingState === 'stopped'
                  ? 'rgba(6, 182, 212, 0.5)'
                  : 'rgba(63, 63, 70, 0.5)'
            }
            onPress={recordingState === 'recording' ? handlePause : handleMicPress}
            disabled={disabled}
            opacity={disabled ? 0.5 : 1}
            icon={
              recordingState === 'recording' ? (
                <Pause size={20} color="#EF4444" />
              ) : (
                <Mic size={20} color={recordingState === 'stopped' ? '#06B6D4' : '#71717A'} />
              )
            }
          />

          {/* Text Input */}
          <XStack
            flex={1}
            backgroundColor="rgba(39, 39, 42, 0.8)"
            borderRadius="$4"
            borderWidth={1}
            borderColor="rgba(63, 63, 70, 0.5)"
            paddingHorizontal="$3"
            paddingVertical="$2"
            minHeight={44}
            maxHeight={120}
          >
            <TextInput
              ref={inputRef}
              style={styles.input}
              value={text}
              onChangeText={setText}
              placeholder={inputPlaceholder}
              placeholderTextColor="#71717A"
              multiline
              maxLength={4000}
              editable={!disabled}
              returnKeyType="default"
            />
          </XStack>

          {/* Send Button */}
          <Button
            width={44}
            height={44}
            padding={0}
            borderRadius={10}
            backgroundColor={canSend ? '#06B6D4' : 'rgba(39, 39, 42, 0.8)'}
            borderWidth={1}
            borderColor={canSend ? 'rgba(6, 182, 212, 0.5)' : 'rgba(63, 63, 70, 0.5)'}
            onPress={handleSend}
            disabled={!canSend}
            pressStyle={{
              backgroundColor: canSend ? '#0891B2' : 'rgba(39, 39, 42, 0.8)',
              scale: 0.95,
            }}
            icon={<Send size={20} color={canSend ? '#FFFFFF' : '#71717A'} />}
          />
        </XStack>

        {/* Character count for long messages */}
        {text.length > 3500 && (
          <XStack justifyContent="flex-end" paddingTop="$1">
            <Text fontSize={11} color={text.length > 3900 ? '#EF4444' : '#71717A'}>
              {text.length}/4000
            </Text>
          </XStack>
        )}
      </YStack>
    </YStack>
  );
}

const styles = StyleSheet.create({
  input: {
    flex: 1,
    fontSize: 16,
    color: '#E4E4E7',
    paddingTop: 0,
    paddingBottom: 0,
    textAlignVertical: 'center',
  },
});

// Re-export types for convenience
export type { AudioRecording, RecordingState };
