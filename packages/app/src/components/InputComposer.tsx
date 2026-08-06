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
import { useTranslation } from 'react-i18next';
import { Keyboard, Platform, StyleSheet, TextInput } from 'react-native';
import { Button, Text, XStack, YStack } from 'tamagui';
import { useColors } from './mca/primitives/useColors';
import { colors as semanticColors, controlsBar, indicators, surface } from './mca/primitives/colors';
import { STORAGE_KEYS, storage } from '../services/storage';
import { useAudioStore, getPendingAudio } from '../store/audioStore';
import { useToast } from './Toast';
import { type AudioRecording, type RecordingState, VoiceRecordingBar } from './VoiceRecordingBar';

type RecordingError = 'permission_denied' | 'not_supported' | 'unknown' | null;

interface InputComposerProps {
  onSend: (message: string, audio?: AudioRecording) => Promise<{ success: boolean }>;
  onTranscribe?: (audio: AudioRecording) => Promise<string>;
  disabled?: boolean;
  placeholder?: string;
  bottomInset?: number;
  channelId?: string; // For saving/restoring drafts
  windowId?: string;
  isGenerating?: boolean;
  onStop?: (kind: 'soft' | 'hard' | 'queue_only') => void | Promise<void>;
  hasIrreversibleToolInFlight?: boolean;
  irreversibleToolName?: string;
}

// Custom recording options with metering enabled
const RECORDING_OPTIONS_WITH_METERING: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  isMeteringEnabled: true,
};

export function InputComposer({
  onSend,
  disabled = false,
  placeholder,
  bottomInset = 0,
  channelId,
}: InputComposerProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const c = useColors();
  const resolvedPlaceholder = placeholder ?? t("conversation.typeMessage");
  const [text, setText] = useState('');
  const [keyboardVisible, setKeyboardVisible] = useState(false);

  // Load draft from storage when channelId changes
  useEffect(() => {
    if (!channelId) return;

    const loadDraft = async () => {
      try {
        const drafts = await storage.get<Record<string, string>>(STORAGE_KEYS.MESSAGE_DRAFTS);
        if (drafts?.[channelId]) {
          setText(drafts[channelId]);
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
        const drafts = (await storage.get<Record<string, string>>(STORAGE_KEYS.MESSAGE_DRAFTS)) ?? {};

        if (text.trim()) {
          drafts[channelId] = text;
        } else {
          delete drafts[channelId]; // Remove empty drafts
        }

        await storage.set(STORAGE_KEYS.MESSAGE_DRAFTS, drafts);
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

  // Restore pending audio from audioStore on channel change (native)
  const restoredRef = useRef<string | null>(null);
  useEffect(() => {
    if (!channelId || restoredRef.current === channelId) return;
    const pending = getPendingAudio(channelId);
    if (!pending) return;
    restoredRef.current = channelId;

    (async () => {
      try {
        if (Platform.OS === 'web') return;
        const FileSystem = await import('expo-file-system') as any;
        const tempUri = `${FileSystem.cacheDirectory}teros-restored-${Date.now()}.m4a`;
        await FileSystem.writeAsStringAsync(tempUri, pending.base64Data, {
          encoding: FileSystem.EncodingType.Base64,
        });
        setAudioRecording({ uri: tempUri, duration: pending.duration });
        setRecordingState('stopped');
        setRecordingDuration(pending.duration);
      } catch (e) {
        console.error('[InputComposer] Failed to restore audio from store:', e);
        useAudioStore.getState().clearPendingAudio(channelId);
      }
    })();
  }, [channelId]);

  const inputRef = useRef<TextInput>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  // Guard: prevent page reload while recording
  useEffect(() => {
    if (Platform.OS !== 'web') return;

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = ''; // Required for Chrome
    };

    if (recordingState === 'recording') {
      window.addEventListener('beforeunload', handleBeforeUnload);
    }

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [recordingState]);

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
        const duration = recordingDuration;
        setAudioRecording({ uri, duration });

        if (channelId) {
          fetch(uri)
            .then((res) => res.blob())
            .then((blob) => blob.arrayBuffer())
            .then((buf) => {
              const bytes = new Uint8Array(buf);
              let binary = '';
              for (let i = 0; i < bytes.byteLength; i++) {
                binary += String.fromCharCode(bytes[i]);
              }
              useAudioStore.getState().savePendingAudio(channelId, {
                base64Data: btoa(binary),
                mimeType: uri.endsWith('.wav') ? 'audio/wav' : 'audio/m4a',
                duration,
                timestamp: Date.now(),
              });
            })
            .catch((e) => console.warn('[InputComposer] Failed to persist audio:', e));
        }
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
    if (channelId) useAudioStore.getState().clearPendingAudio(channelId);
  }, [recorder, player, stopTimer, channelId]);

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

    let recordingToSend: AudioRecording | undefined = audioRecording || undefined;

    // If still recording, stop first and get the recording
    if (recordingState === 'recording') {
      stopTimer();
      try {
        await recorder.stop();
        const uri = recorder.uri;
        await setAudioModeAsync({ allowsRecording: false });

        recordingToSend = uri ? { uri, duration: recordingDuration } : undefined;
        if (recordingToSend) {
          setAudioRecording(recordingToSend);
          setRecordingState('stopped');
        }
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

    const result = await onSend(text.trim(), recordingToSend);

    if (result.success) {
      setText('');
      setAudioRecording(null);
      setRecordingState('idle');
      setRecordingDuration(0);
      setIsPlaying(false);
      Keyboard.dismiss();

      if (channelId) {
        useAudioStore.getState().clearPendingAudio(channelId);
        storage
          .get<Record<string, string>>(STORAGE_KEYS.MESSAGE_DRAFTS)
          .then((drafts) => {
            const updated = drafts ?? {};
            delete updated[channelId];
            storage.set(STORAGE_KEYS.MESSAGE_DRAFTS, updated);
          })
          .catch((e) => console.error('Failed to clear draft:', e));
      }
    } else {
      if (recordingToSend) {
        toast.error(t('recording.sendFailed'));
      }
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
    toast,
    t,
  ]);

  // Get error message
  const getErrorMessage = (error: RecordingError): string => {
    switch (error) {
      case 'permission_denied':
        return t("recording.micDenied");
      case 'not_supported':
        return t("recording.notSupported");
      default:
        return t("recording.failed");
    }
  };

  const hasContent =
    text.trim().length > 0 || audioRecording !== null || recordingState === 'recording';
  const canSend = hasContent && !disabled;
  const effectiveBottomPadding = keyboardVisible ? 8 : bottomInset + 8;
  const isRecordingOrStopped = recordingState !== 'idle';
  const inputPlaceholder = isRecordingOrStopped ? t("conversation.addNote") : resolvedPlaceholder;

  return (
    <YStack
      backgroundColor={c.bgCard}
      borderTopWidth={1}
      borderTopColor={c.border}
    >
      {/* Error Banner */}
      {recordingError && (
        <XStack
          paddingHorizontal="$3"
          paddingVertical="$2"
          alignItems="center"
          justifyContent="space-between"
          backgroundColor={controlsBar.deny.bg}
          borderBottomWidth={1}
          borderBottomColor={controlsBar.deny.border}
        >
          <XStack alignItems="center" gap="$2" flex={1}>
            <AlertCircle size={16} color={semanticColors.red} />
            <Text fontSize={12} color={semanticColors.red} flex={1}>
              {getErrorMessage(recordingError)}
            </Text>
          </XStack>
          <Button
            size="$2"
            circular
            chromeless
            onPress={dismissError}
            icon={<X size={14} color={semanticColors.red} />}
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
                ? indicators.irreversible.bg
                : recordingState === 'stopped'
                  ? semanticColors.indigoGlow
                  : c.bgInner
            }
            borderWidth={1}
            borderColor={
              recordingState === 'recording'
                ? indicators.irreversible.border
                : recordingState === 'stopped'
                  ? c.badges.info.border
                  : c.border
            }
            onPress={recordingState === 'recording' ? handlePause : handleMicPress}
            disabled={disabled}
            opacity={disabled ? 0.5 : 1}
            icon={
              recordingState === 'recording' ? (
                <Pause size={20} color={semanticColors.red} />
              ) : (
                <Mic size={20} color={recordingState === 'stopped' ? semanticColors.indigo : c.text3} />
              )
            }
          />

          {/* Text Input */}
          <XStack
            flex={1}
            backgroundColor={c.bgInner}
            borderRadius="$4"
            borderWidth={1}
            borderColor={c.border}
            paddingHorizontal="$3"
            paddingVertical="$2"
            minHeight={44}
            maxHeight={120}
          >
            <TextInput
              ref={inputRef}
              style={[styles.input, { color: c.text }]}
              value={text}
              onChangeText={setText}
              placeholder={inputPlaceholder}
              placeholderTextColor={c.text3}
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
            backgroundColor={canSend ? semanticColors.indigo : c.bgInner}
            borderWidth={1}
            borderColor={canSend ? c.badges.info.border : c.border}
            onPress={handleSend}
            disabled={!canSend}
            pressStyle={{
              backgroundColor: canSend ? semanticColors.indigoDark : c.bgInner,
              scale: 0.95,
            }}
            icon={<Send size={20} color={canSend ? surface.dark.text : c.text3} />}
          />
        </XStack>

        {/* Character count for long messages */}
        {text.length > 3500 && (
          <XStack justifyContent="flex-end" paddingTop="$1">
            <Text fontSize={11} color={text.length > 3900 ? semanticColors.red : c.text3}>
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
    fontFamily: "$body",
    fontSize: 16,
    paddingTop: 0,
    paddingBottom: 0,
    textAlignVertical: 'center',
  },
});

// Re-export types for convenience
export type { AudioRecording, RecordingState };
