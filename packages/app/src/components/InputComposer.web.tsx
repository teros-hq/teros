import { AlertCircle, FileText, Mic, Paperclip, Pause, Play, Send, X } from '@tamagui/lucide-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import RecordRTC, { StereoAudioRecorder } from 'recordrtc';
import { Button, Image, Input, Text, View, XStack, YStack } from 'tamagui';
import { type UploadedFile, useFileUpload } from '../hooks/useFileUpload';
import { STORAGE_KEYS, storage } from '../services/storage';

type WebRecordingState = 'idle' | 'recording' | 'paused';

// Unified audio recording interface for both web and native
export interface AudioRecording {
  uri?: string; // Native: file URI
  blob?: Blob; // Web: Blob object
  duration: number; // seconds
  url?: string; // Object URL for playback (web)
}

interface RecordingErrorInfo {
  type: 'permission_denied' | 'not_found' | 'not_supported' | 'unknown';
  details?: string; // Technical details for debugging
}

type RecordingError = RecordingErrorInfo | null;

interface InputComposerProps {
  onSend: (text: string, audio?: AudioRecording, file?: UploadedFile) => void;
  disabled?: boolean;
  placeholder?: string;
  channelId?: string; // For saving/restoring drafts
}

// Re-export UploadedFile type for consumers
export type { UploadedFile };

const TEXTAREA_MIN_HEIGHT = 40; // pixels
const TEXTAREA_MAX_HEIGHT = 150; // pixels

// Waveform constants
const MIN_BAR_HEIGHT = 4;
const MAX_BAR_HEIGHT = 28;
const BAR_WIDTH = 3;
const BAR_GAP = 2;

// Calculate metering (dB) from analyser node using RMS
function calculateMetering(analyser: AnalyserNode): number {
  const dataArray = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(dataArray);

  // Calculate RMS
  let sum = 0;
  for (let i = 0; i < dataArray.length; i++) {
    const normalized = (dataArray[i] - 128) / 128; // -1 to 1
    sum += normalized * normalized;
  }
  const rms = Math.sqrt(sum / dataArray.length);

  // Convert to dB (typical range -60 to 0)
  const db = 20 * Math.log10(Math.max(rms, 0.0001));
  return Math.max(-60, Math.min(0, db));
}

// Normalize metering value to 0-1
function normalizeMetering(value: number): number {
  const METERING_MIN = -50;
  const METERING_MAX = 0;
  const normalized = (value - METERING_MIN) / (METERING_MAX - METERING_MIN);
  return Math.max(0.1, Math.min(1, normalized));
}

// Format duration as m:ss
function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
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
    const value = samples[lowIndex] * (1 - fraction) + samples[highIndex] * fraction;
    expanded.push(value);
  }

  return expanded;
}

export function InputComposer({
  onSend,
  disabled = false,
  placeholder = 'Type a message...',
  channelId,
}: InputComposerProps) {
  const [text, setText] = useState('');
  const [useMultilineLayout, setUseMultilineLayout] = useState(false);

  // File upload hook
  const fileUpload = useFileUpload();

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

  const [textareaHeight, setTextareaHeight] = useState(TEXTAREA_MIN_HEIGHT);
  const [recordingState, setRecordingState] = useState<WebRecordingState>('idle');
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [audioRecording, setAudioRecording] = useState<AudioRecording | null>(null);
  const [recordingError, setRecordingError] = useState<RecordingError>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const [metering, setMetering] = useState<number>(-60);
  const [playbackProgress, setPlaybackProgress] = useState<number>(0);

  // Hover states for buttons that need icon color changes
  const [isMicHovered, setIsMicHovered] = useState(false);
  const [isAttachHovered, setIsAttachHovered] = useState(false);
  const [isDiscardHovered, setIsDiscardHovered] = useState(false);
  const [isPlaybackHovered, setIsPlaybackHovered] = useState(false);
  const [isRecPauseHovered, setIsRecPauseHovered] = useState(false);

  // Waveform samples
  const [samples, setSamples] = useState<number[]>([]);
  const [waveformWidth, setWaveformWidth] = useState(300);
  const waveformContainerRef = useRef<HTMLDivElement>(null);

  const recorderRef = useRef<RecordRTC | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const recordingDurationRef = useRef(0);
  const lastMeteringRef = useRef<number | null>(null);
  const meteringCountRef = useRef<number>(0);

  // Input refs - declared here (before any useEffect that uses them) to avoid TDZ issues
  const singleLineInputRef = useRef<any>(null);
  const multiLineInputRef = useRef<any>(null);
  const textRef = useRef(text);
  const pendingCursorRef = useRef<number | null>(null);
  const useMultilineLayoutRef = useRef(useMultilineLayout);

  // Keep refs in sync with state
  useEffect(() => {
    textRef.current = text;
  }, [text]);

  useEffect(() => {
    useMultilineLayoutRef.current = useMultilineLayout;
  }, [useMultilineLayout]);

  // Calculate number of bars based on container width
  const numBars = Math.max(10, Math.floor(waveformWidth / (BAR_WIDTH + BAR_GAP)));

  const hasText = text.trim().length > 0;
  const hasFileAttachment = fileUpload.selectedFile !== null;
  const isRecording = recordingState === 'recording';
  const isPaused = recordingState === 'paused';
  const isRecordingOrPaused = recordingState !== 'idle';
  const hasAudioRecording = audioRecording !== null;

  // Measure waveform container width
  useEffect(() => {
    const container = waveformContainerRef.current;
    if (!container) return;

    const updateWidth = () => {
      const width = container.offsetWidth;
      if (width > 0) {
        setWaveformWidth(width);
      }
    };

    // Initial measurement
    updateWidth();

    const resizeObserver = new ResizeObserver(() => {
      updateWidth();
    });

    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, [isRecordingOrPaused]);

  // Keep duration ref in sync
  useEffect(() => {
    recordingDurationRef.current = recordingDuration;
  }, [recordingDuration]);

  // Switch to multiline layout when input overflows, go back to inline only when empty
  useEffect(() => {
    if (text.length === 0 && useMultilineLayout) {
      setUseMultilineLayout(false);
      return;
    }

    // Check if inline input is overflowing (text goes beyond visible area)
    if (!useMultilineLayout && singleLineInputRef.current) {
      const input = singleLineInputRef.current;
      // scrollWidth > clientWidth means text is wider than the visible input
      if (input.scrollWidth > input.clientWidth) {
        setUseMultilineLayout(true);
      }
    }
  }, [text, useMultilineLayout]);

  // Calculate metering from analyser during recording
  useEffect(() => {
    if (recordingState !== 'recording' || !analyser) {
      return;
    }

    let animationFrameId: number;

    const updateMetering = () => {
      const db = calculateMetering(analyser);
      setMetering(db);
      animationFrameId = requestAnimationFrame(updateMetering);
    };

    updateMetering();

    return () => {
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
      }
    };
  }, [recordingState, analyser]);

  // Collect samples during recording
  useEffect(() => {
    if (recordingState !== 'recording') return;
    if (metering === lastMeteringRef.current) return;

    lastMeteringRef.current = metering;
    const normalizedValue = normalizeMetering(metering);

    meteringCountRef.current += 1;
    if (meteringCountRef.current % 2 !== 0) return;

    setSamples((prev) => {
      const newSamples = [...prev];
      if (newSamples.length < numBars) {
        newSamples.push(normalizedValue);
      } else {
        newSamples.shift();
        newSamples.push(normalizedValue);
      }
      return newSamples;
    });
  }, [recordingState, metering, numBars]);

  // Reset samples when starting new recording
  useEffect(() => {
    if (recordingState === 'recording' && samples.length === 0) {
      meteringCountRef.current = 0;
    } else if (recordingState === 'idle') {
      setSamples([]);
      meteringCountRef.current = 0;
    }
  }, [recordingState, samples.length]);

  // Track playback progress
  useEffect(() => {
    if (!isPlaying || !audioPlayerRef.current) {
      return;
    }

    let animationFrameId: number;

    const updateProgress = () => {
      const player = audioPlayerRef.current;
      if (player && player.duration > 0) {
        setPlaybackProgress(player.currentTime / player.duration);
      }
      animationFrameId = requestAnimationFrame(updateProgress);
    };

    updateProgress();

    return () => {
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
      }
      setPlaybackProgress(0);
    };
  }, [isPlaying]);

  // Start recording timer
  const startTimer = useCallback(() => {
    timerRef.current = setInterval(() => {
      setRecordingDuration((prev) => prev + 1);
    }, 1000);
  }, []);

  // Stop recording timer
  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Start audio recording with RecordRTC
  const startRecording = async () => {
    setRecordingError(null);

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      console.error('[Recording] getUserMedia not supported');
      setRecordingError({
        type: 'not_supported',
        details: 'navigator.mediaDevices.getUserMedia is not available',
      });
      return;
    }

    try {
      console.log('[Recording] Requesting microphone access...');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      console.log('[Recording] Microphone access granted');

      // Set up Web Audio API for visualization
      try {
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        if (AudioContextClass) {
          const audioContext = new AudioContextClass();
          audioContextRef.current = audioContext;

          if (audioContext.state === 'suspended') {
            await audioContext.resume();
          }

          const source = audioContext.createMediaStreamSource(stream);
          const analyserNode = audioContext.createAnalyser();
          analyserNode.fftSize = 256;
          analyserNode.smoothingTimeConstant = 0.7;
          source.connect(analyserNode);
          setAnalyser(analyserNode);
          console.log('[Recording] Audio analyser set up');
        }
      } catch (e) {
        console.warn('[Recording] Could not set up audio analyser:', e);
      }

      const isIOS =
        /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

      const recorder = new RecordRTC(stream, {
        type: 'audio',
        mimeType: isIOS ? 'audio/wav' : 'audio/webm',
        recorderType: StereoAudioRecorder,
        numberOfAudioChannels: 1,
        desiredSampRate: 16000,
        disableLogs: false,
      });

      recorderRef.current = recorder;
      recorder.startRecording();

      setRecordingState('recording');
      setRecordingDuration(0);
      setSamples([]);
      startTimer();
      console.log('[Recording] Started recording with RecordRTC');
    } catch (error: any) {
      console.error('[Recording] Failed to start recording:', error);

      let errorDetails: string;
      try {
        const errorInfo = {
          name: error?.name,
          message: error?.message,
          stack: error?.stack?.split('\n').slice(0, 3).join(' | '),
          toString: String(error),
          keys: error ? Object.keys(error) : [],
          type: typeof error,
        };
        errorDetails = JSON.stringify(errorInfo, null, 0);
      } catch {
        errorDetails = String(error);
      }

      if (error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError') {
        setRecordingError({ type: 'permission_denied', details: errorDetails });
      } else if (error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError') {
        setRecordingError({ type: 'not_found', details: errorDetails });
      } else if (error?.name === 'NotSupportedError') {
        setRecordingError({ type: 'not_supported', details: errorDetails });
      } else {
        setRecordingError({ type: 'unknown', details: errorDetails });
      }
    }
  };

  // Stop and finalize recording (pause)
  const stopRecording = useCallback(() => {
    if (recorderRef.current) {
      stopTimer();
      setAnalyser(null);

      recorderRef.current.stopRecording(() => {
        const blob = recorderRef.current?.getBlob();
        if (blob) {
          const url = URL.createObjectURL(blob);
          setAudioRecording({
            blob,
            duration: recordingDurationRef.current,
            url,
          });
          console.log('[Recording] Recording stopped, blob size:', blob.size);
        }
      });

      streamRef.current?.getTracks().forEach((track) => track.stop());
      setRecordingState('paused');

      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
    }
  }, [stopTimer]);

  // Discard recording
  const discardRecording = useCallback(() => {
    if (recorderRef.current) {
      recorderRef.current.stopRecording(() => {});
      recorderRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());

    if (audioRecording?.url) {
      URL.revokeObjectURL(audioRecording.url);
    }

    if (audioPlayerRef.current) {
      audioPlayerRef.current.pause();
      audioPlayerRef.current = null;
    }

    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    setAnalyser(null);
    setRecordingState('idle');
    setRecordingDuration(0);
    setAudioRecording(null);
    setIsPlaying(false);
    setSamples([]);
    stopTimer();
  }, [audioRecording?.url, stopTimer]);

  // Play/pause audio preview
  const togglePlayback = useCallback(() => {
    if (!audioRecording?.url) return;

    if (isPlaying && audioPlayerRef.current) {
      audioPlayerRef.current.pause();
      setIsPlaying(false);
    } else {
      if (!audioPlayerRef.current) {
        audioPlayerRef.current = new Audio(audioRecording.url);
        audioPlayerRef.current.onended = () => setIsPlaying(false);
      }
      audioPlayerRef.current.play();
      setIsPlaying(true);
    }
  }, [audioRecording?.url, isPlaying]);

  // Seek in audio
  const handleWaveformClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!audioRecording?.url || !audioPlayerRef.current) return;

      const rect = e.currentTarget.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const percentage = clickX / rect.width;

      if (audioPlayerRef.current.duration) {
        audioPlayerRef.current.currentTime = percentage * audioPlayerRef.current.duration;
        setPlaybackProgress(percentage);
      }
    },
    [audioRecording?.url]
  );

  // Dismiss error
  const dismissError = useCallback(() => {
    setRecordingError(null);
  }, []);

  // Handle send
  const handleSend = useCallback(async () => {
    const hasContentToSend =
      text.trim().length > 0 ||
      audioRecording !== null ||
      recordingState === 'recording' ||
      fileUpload.selectedFile !== null;
    if (!hasContentToSend || disabled) return;

    let uploadedFile: UploadedFile | undefined;
    if (fileUpload.selectedFile && !fileUpload.uploadedFile) {
      const result = await fileUpload.upload();
      if (result) {
        uploadedFile = result;
      } else {
        return;
      }
    } else if (fileUpload.uploadedFile) {
      uploadedFile = fileUpload.uploadedFile;
    }

    // If still recording, stop first and send with the new recording
    if (recordingState === 'recording' && recorderRef.current) {
      stopTimer();
      setAnalyser(null);

      recorderRef.current.stopRecording(() => {
        const blob = recorderRef.current?.getBlob();

        if (audioPlayerRef.current) {
          audioPlayerRef.current.pause();
          audioPlayerRef.current = null;
        }

        if (audioContextRef.current) {
          audioContextRef.current.close();
          audioContextRef.current = null;
        }

        if (blob) {
          const url = URL.createObjectURL(blob);
          const newRecording: AudioRecording = {
            blob,
            duration: recordingDurationRef.current,
            url,
          };
          onSend(text.trim(), newRecording, uploadedFile);
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        } else {
          onSend(text.trim(), undefined, uploadedFile);
        }

        // Reset state
        setText('');
        setAudioRecording(null);
        setRecordingState('idle');
        setRecordingDuration(0);
        setIsPlaying(false);
        setMetering(-60);
        setPlaybackProgress(0);
        setSamples([]);
        fileUpload.clear();

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
      });

      streamRef.current?.getTracks().forEach((track) => track.stop());
      return;
    }

    // Not recording - send existing audio/file or text
    if (audioPlayerRef.current) {
      audioPlayerRef.current.pause();
      audioPlayerRef.current = null;
    }

    onSend(text.trim(), audioRecording || undefined, uploadedFile);

    if (audioRecording?.url) {
      URL.revokeObjectURL(audioRecording.url);
    }

    // Reset state
    setText('');
    setAudioRecording(null);
    setRecordingState('idle');
    setRecordingDuration(0);
    setIsPlaying(false);
    setMetering(-60);
    setPlaybackProgress(0);
    setSamples([]);
    fileUpload.clear();

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
  }, [disabled, recordingState, stopTimer, text, audioRecording, onSend, channelId, fileUpload]);

  // Helper to get the native DOM element from Tamagui ref
  const getNativeInput = useCallback(
    (tamaguiRef: any): HTMLInputElement | HTMLTextAreaElement | null => {
      if (!tamaguiRef) return null;
      if (tamaguiRef instanceof HTMLInputElement || tamaguiRef instanceof HTMLTextAreaElement) {
        return tamaguiRef;
      }
      if (tamaguiRef.tagName === 'INPUT' || tamaguiRef.tagName === 'TEXTAREA') {
        return tamaguiRef;
      }
      const native = tamaguiRef.querySelector?.('input, textarea');
      if (native) return native;
      if (tamaguiRef.native) return tamaguiRef.native;
      return tamaguiRef;
    },
    []
  );

  // Attach native keydown listener
  useEffect(() => {
    const handleNativeKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const singleInput = getNativeInput(singleLineInputRef.current);
      const multiInput = getNativeInput(multiLineInputRef.current);

      if (target !== singleInput && target !== multiInput) {
        return;
      }

      if (e.key === 'Enter') {
        if (e.shiftKey || e.ctrlKey) {
          e.preventDefault();
          e.stopPropagation();

          const input = target as HTMLInputElement | HTMLTextAreaElement;
          const start = input.selectionStart ?? textRef.current.length;
          const end = input.selectionEnd ?? textRef.current.length;
          const newText =
            textRef.current.substring(0, start) + '\n' + textRef.current.substring(end);
          const newCursorPos = start + 1;

          if (!useMultilineLayoutRef.current) {
            pendingCursorRef.current = newCursorPos;
            setUseMultilineLayout(true);
          }

          setText(newText);

          if (useMultilineLayoutRef.current) {
            requestAnimationFrame(() => {
              const currentInput = getNativeInput(multiLineInputRef.current);
              if (currentInput) {
                currentInput.setSelectionRange(newCursorPos, newCursorPos);
              }
            });
          }
          return;
        }

        if (textRef.current.trim().length > 0 || audioRecording !== null) {
          e.preventDefault();
          handleSend();
        }
        return;
      }

      if (e.key === 'Escape' && recordingState !== 'idle') {
        e.preventDefault();
        discardRecording();
      }
    };

    document.addEventListener('keydown', handleNativeKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleNativeKeyDown, true);
    };
  }, [audioRecording, recordingState, handleSend, discardRecording, getNativeInput]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopTimer();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      if (audioRecording?.url) {
        URL.revokeObjectURL(audioRecording.url);
      }
      if (audioPlayerRef.current) {
        audioPlayerRef.current.pause();
      }
      if (audioContextRef.current) {
        audioContextRef.current.close();
      }
      if (recorderRef.current) {
        recorderRef.current.stopRecording(() => {});
      }
    };
  }, [stopTimer, audioRecording?.url]);

  // Get error message for display
  const getErrorMessage = (error: RecordingError): { message: string; details?: string } => {
    if (!error) return { message: '' };

    const baseMessages: Record<string, string> = {
      permission_denied: 'Microphone access denied. Please allow access in your browser settings.',
      not_found: 'No microphone found. Please connect a microphone and try again.',
      not_supported: 'Audio recording is not supported in this browser.',
      unknown: 'Failed to start recording. Please try again.',
    };

    return {
      message: baseMessages[error.type] || baseMessages['unknown'],
      details: error.details,
    };
  };

  // Error banner component
  const ErrorBanner = () => {
    if (!recordingError) return null;

    const { message, details } = getErrorMessage(recordingError);

    return (
      <XStack
        paddingHorizontal="$3"
        paddingVertical="$2"
        alignItems="flex-start"
        justifyContent="space-between"
        backgroundColor="#7F1D1D"
        borderBottomWidth={1}
        borderBottomColor="#991B1B"
      >
        <YStack flex={1} gap="$1">
          <XStack alignItems="center" gap="$2">
            <AlertCircle size={16} color="#FCA5A5" />
            <Text fontSize="$2" color="#FCA5A5" flex={1}>
              {message}
            </Text>
          </XStack>
          {details && (
            <Text
              fontSize="$1"
              color="#FCA5A5"
              opacity={0.7}
              paddingLeft="$5"
              userSelect="text"
              cursor="text"
              style={{ userSelect: 'text', WebkitUserSelect: 'text' } as any}
            >
              {details}
            </Text>
          )}
        </YStack>
        <Button
          size="$2"
          circular
          chromeless
          onPress={dismissError}
          icon={<X size={14} color="#FCA5A5" />}
        />
      </XStack>
    );
  };

  // Waveform component
  const Waveform = () => {
    const displaySamples =
      isRecording
        ? samples
        : isPaused && samples.length > 0
          ? expandSamples(samples, numBars)
          : [];

    const progressBarIndex = isPlaying ? Math.floor(playbackProgress * numBars) : -1;
    const emptySlots = isRecording ? Math.max(0, numBars - displaySamples.length) : 0;

    return (
      <div
        ref={waveformContainerRef}
        onClick={isPaused ? handleWaveformClick : undefined}
        style={{
          flex: 1,
          height: 32,
          display: 'flex',
          alignItems: 'center',
          gap: BAR_GAP,
          cursor: isPaused ? 'pointer' : 'default',
          minWidth: 100,
          overflow: 'hidden',
        }}
      >
        {Array.from({ length: numBars }).map((_, index) => {
          const isEmptySlot = index < emptySlots;
          const sampleIndex = index - emptySlots;
          const hasSample = !isEmptySlot && sampleIndex < displaySamples.length;
          const normalizedValue = hasSample ? (displaySamples[sampleIndex] ?? 0) : 0;
          const barHeight = hasSample
            ? MIN_BAR_HEIGHT + normalizedValue * (MAX_BAR_HEIGHT - MIN_BAR_HEIGHT)
            : MIN_BAR_HEIGHT;

          let backgroundColor: string;
          if (isEmptySlot) {
            backgroundColor = 'rgba(113, 113, 122, 0.3)';
          } else if (isRecording) {
            backgroundColor = '#EF4444';
          } else if (progressBarIndex >= 0 && index <= progressBarIndex) {
            backgroundColor = '#06B6D4';
          } else {
            backgroundColor = 'rgba(6, 182, 212, 0.4)';
          }

          return (
            <div
              key={index}
              style={{
                width: BAR_WIDTH,
                height: barHeight,
                borderRadius: 1.5,
                backgroundColor,
                flexShrink: 0,
              }}
            />
          );
        })}
      </div>
    );
  };

  // Can send logic
  const canSend =
    (hasText || hasAudioRecording || isRecording || hasFileAttachment) && !disabled;

  // Auto-resize textarea
  useEffect(() => {
    if (!useMultilineLayout) {
      setTextareaHeight(TEXTAREA_MIN_HEIGHT);
      return;
    }

    const inputWrapper = multiLineInputRef.current;
    if (!inputWrapper) return;

    const textarea =
      inputWrapper.tagName === 'TEXTAREA'
        ? inputWrapper
        : inputWrapper.querySelector?.('textarea') || inputWrapper;

    if (!textarea || !textarea.scrollHeight) return;

    textarea.style.height = 'auto';
    const scrollHeight = textarea.scrollHeight;
    const newHeight = Math.min(Math.max(scrollHeight, TEXTAREA_MIN_HEIGHT), TEXTAREA_MAX_HEIGHT);
    textarea.style.height = `${newHeight}px`;
    setTextareaHeight(newHeight);
  }, [text, useMultilineLayout]);

  // Transfer focus when layout changes
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const timer = setTimeout(() => {
        const refEl = useMultilineLayout ? multiLineInputRef.current : singleLineInputRef.current;
        const inputEl = getNativeInput(refEl);

        if (inputEl) {
          inputEl.focus();
          const cursorPos = pendingCursorRef.current ?? textRef.current.length;
          pendingCursorRef.current = null;
          if (inputEl.setSelectionRange) {
            inputEl.setSelectionRange(cursorPos, cursorPos);
          }
        }
      }, 0);
      return () => clearTimeout(timer);
    });
    return () => cancelAnimationFrame(raf);
  }, [useMultilineLayout, getNativeInput]);

  // Focus input when clicking container
  const handleContainerPress = useCallback(() => {
    if (isRecordingOrPaused) return; // Don't focus input in recording mode
    const refEl = useMultilineLayout ? multiLineInputRef.current : singleLineInputRef.current;
    const inputEl = getNativeInput(refEl);
    if (inputEl) {
      inputEl.focus();
    }
  }, [useMultilineLayout, getNativeInput, isRecordingOrPaused]);

  // Render different layouts based on state
  const renderContent = () => {
    // Recording or Paused: Show waveform layout
    if (isRecordingOrPaused) {
      return (
        <XStack padding="$2" paddingHorizontal="$3" alignItems="center" gap="$2">
          {/* Left button: Pause (recording) or Play/Pause (paused) */}
          {isRecording ? (
            <Button
              width={42}
              height={42}
              padding={0}
              borderRadius={12}
              backgroundColor="rgba(239, 68, 68, 0.2)"
              borderWidth={1}
              borderColor="rgba(239, 68, 68, 0.5)"
              onPress={stopRecording}
              onMouseEnter={() => setIsRecPauseHovered(true)}
              onMouseLeave={() => setIsRecPauseHovered(false)}
              hoverStyle={{
                backgroundColor: 'rgba(239, 68, 68, 0.3)',
                borderColor: 'rgba(239, 68, 68, 0.7)',
              }}
              pressStyle={{
                backgroundColor: 'rgba(239, 68, 68, 0.4)',
                borderColor: 'rgba(239, 68, 68, 0.8)',
                scale: 0.95,
              }}
              icon={<Pause size={20} color={isRecPauseHovered ? '#F87171' : '#EF4444'} />}
            />
          ) : (
            <Button
              width={42}
              height={42}
              padding={0}
              borderRadius={12}
              backgroundColor="rgba(6, 182, 212, 0.2)"
              borderWidth={1}
              borderColor="rgba(6, 182, 212, 0.5)"
              onPress={togglePlayback}
              onMouseEnter={() => setIsPlaybackHovered(true)}
              onMouseLeave={() => setIsPlaybackHovered(false)}
              hoverStyle={{
                backgroundColor: 'rgba(6, 182, 212, 0.3)',
                borderColor: 'rgba(6, 182, 212, 0.7)',
              }}
              pressStyle={{
                backgroundColor: 'rgba(6, 182, 212, 0.4)',
                borderColor: 'rgba(6, 182, 212, 0.8)',
                scale: 0.95,
              }}
              icon={
                isPlaying ? (
                  <Pause size={20} color={isPlaybackHovered ? '#22D3EE' : '#06B6D4'} />
                ) : (
                  <Play size={20} color={isPlaybackHovered ? '#22D3EE' : '#06B6D4'} />
                )
              }
            />
          )}

          {/* Waveform + Duration */}
          <XStack flex={1} alignItems="center" gap="$2" minWidth={0}>
            <Waveform />
            <Text
              fontSize={13}
              fontWeight="500"
              color={isRecording ? '#EF4444' : '#06B6D4'}
              minWidth={36}
              textAlign="right"
              fontVariant={['tabular-nums']}
            >
              {formatDuration(audioRecording?.duration || recordingDuration)}
            </Text>
          </XStack>

          {/* Discard button */}
          <Button
            width={42}
            height={42}
            padding={0}
            borderRadius={12}
            backgroundColor="rgba(39, 39, 42, 0.8)"
            borderWidth={1}
            borderColor="rgba(63, 63, 70, 0.5)"
            onPress={discardRecording}
            onMouseEnter={() => setIsDiscardHovered(true)}
            onMouseLeave={() => setIsDiscardHovered(false)}
            hoverStyle={{
              backgroundColor: 'rgba(63, 63, 70, 0.8)',
              borderColor: 'rgba(82, 82, 91, 0.6)',
            }}
            pressStyle={{
              backgroundColor: 'rgba(39, 39, 42, 1)',
              borderColor: 'rgba(82, 82, 91, 0.8)',
              scale: 0.95,
            }}
            icon={<X size={18} color={isDiscardHovered ? '#A1A1AA' : '#71717A'} />}
          />

          {/* Send button */}
          <Button
            width={42}
            height={42}
            padding={0}
            borderRadius={12}
            backgroundColor="#06B6D4"
            borderWidth={1}
            borderColor="rgba(6, 182, 212, 0.5)"
            onPress={handleSend}
            hoverStyle={{
              backgroundColor: '#22D3EE',
              borderColor: 'rgba(34, 211, 238, 0.6)',
            }}
            pressStyle={{
              backgroundColor: '#0891B2',
              borderColor: 'rgba(8, 145, 178, 0.8)',
              scale: 0.95,
            }}
            icon={<Send size={20} color="#FFFFFF" />}
          />
        </XStack>
      );
    }

    // Idle state: Attach | Input | Mic/Send
    const rightButton = hasText || hasFileAttachment ? (
      <Button
        width={42}
        height={42}
        padding={0}
        borderRadius={12}
        backgroundColor="#06B6D4"
        borderWidth={1}
        borderColor="rgba(6, 182, 212, 0.5)"
        onPress={handleSend}
        disabled={!canSend}
        hoverStyle={{
          backgroundColor: '#22D3EE',
          borderColor: 'rgba(34, 211, 238, 0.6)',
        }}
        pressStyle={{
          backgroundColor: '#0891B2',
          borderColor: 'rgba(8, 145, 178, 0.8)',
          scale: 0.95,
        }}
        disabledStyle={{
          backgroundColor: 'rgba(6, 182, 212, 0.4)',
          borderColor: 'rgba(6, 182, 212, 0.2)',
        }}
        icon={<Send size={20} color="#FFFFFF" />}
      />
    ) : (
      <Button
        width={42}
        height={42}
        padding={0}
        borderRadius={12}
        backgroundColor="rgba(39, 39, 42, 0.8)"
        borderWidth={1}
        borderColor="rgba(63, 63, 70, 0.5)"
        onPress={startRecording}
        disabled={disabled}
        onMouseEnter={() => setIsMicHovered(true)}
        onMouseLeave={() => setIsMicHovered(false)}
        hoverStyle={{
          backgroundColor: 'rgba(239, 68, 68, 0.15)',
          borderColor: 'rgba(239, 68, 68, 0.4)',
        }}
        pressStyle={{
          backgroundColor: 'rgba(239, 68, 68, 0.25)',
          borderColor: 'rgba(239, 68, 68, 0.6)',
          scale: 0.95,
        }}
        icon={<Mic size={20} color={isMicHovered ? '#EF4444' : '#71717A'} />}
      />
    );

    if (useMultilineLayout) {
      return (
        <>
          <YStack paddingHorizontal="$3" paddingTop="$2">
            <Input
              ref={multiLineInputRef}
              backgroundColor="transparent"
              borderWidth={0}
              outlineWidth={0}
              focusStyle={{ borderWidth: 0, outlineWidth: 0 }}
              paddingHorizontal="$2"
              paddingVertical="$1"
              fontSize="$4"
              color="$color"
              placeholderTextColor="$placeholderColor"
              placeholder={placeholder}
              value={text}
              onChangeText={setText}
              multiline
              disabled={disabled}
              height={textareaHeight}
              maxHeight={TEXTAREA_MAX_HEIGHT}
              overflow="hidden"
              style={
                {
                  overflowY: textareaHeight >= TEXTAREA_MAX_HEIGHT ? 'auto' : 'hidden',
                  overflowX: 'hidden',
                } as any
              }
            />
          </YStack>
          <XStack padding="$3" paddingTop="$1" alignItems="center" justifyContent="space-between">
            <XStack alignItems="center" gap="$2">
              <Button
                width={42}
                height={42}
                padding={0}
                borderRadius={12}
                backgroundColor={hasFileAttachment ? 'rgba(6, 182, 212, 0.2)' : 'rgba(39, 39, 42, 0.8)'}
                borderWidth={1}
                borderColor={hasFileAttachment ? 'rgba(6, 182, 212, 0.5)' : 'rgba(63, 63, 70, 0.5)'}
                onPress={fileUpload.pickFile}
                disabled={disabled || fileUpload.isUploading}
                onMouseEnter={() => setIsAttachHovered(true)}
                onMouseLeave={() => setIsAttachHovered(false)}
                hoverStyle={hasFileAttachment ? {
                  backgroundColor: 'rgba(6, 182, 212, 0.3)',
                  borderColor: 'rgba(6, 182, 212, 0.7)',
                } : {
                  backgroundColor: 'rgba(63, 63, 70, 0.8)',
                  borderColor: 'rgba(82, 82, 91, 0.6)',
                }}
                pressStyle={hasFileAttachment ? {
                  backgroundColor: 'rgba(6, 182, 212, 0.4)',
                  borderColor: 'rgba(6, 182, 212, 0.8)',
                  scale: 0.95,
                } : {
                  backgroundColor: 'rgba(39, 39, 42, 1)',
                  borderColor: 'rgba(82, 82, 91, 0.8)',
                  scale: 0.95,
                }}
                icon={<Paperclip size={20} color={
                  hasFileAttachment 
                    ? (isAttachHovered ? '#22D3EE' : '#06B6D4')
                    : (isAttachHovered ? '#A1A1AA' : '#71717A')
                } />}
              />
            </XStack>
            {rightButton}
          </XStack>
        </>
      );
    }

    // Single line layout
    return (
      <XStack padding="$2" paddingHorizontal="$3" alignItems="center" gap="$2">
        <Button
          width={42}
          height={42}
          padding={0}
          borderRadius={12}
          backgroundColor={hasFileAttachment ? 'rgba(6, 182, 212, 0.2)' : 'rgba(39, 39, 42, 0.8)'}
          borderWidth={1}
          borderColor={hasFileAttachment ? 'rgba(6, 182, 212, 0.5)' : 'rgba(63, 63, 70, 0.5)'}
          onPress={fileUpload.pickFile}
          disabled={disabled || fileUpload.isUploading}
          onMouseEnter={() => setIsAttachHovered(true)}
          onMouseLeave={() => setIsAttachHovered(false)}
          hoverStyle={hasFileAttachment ? {
            backgroundColor: 'rgba(6, 182, 212, 0.3)',
            borderColor: 'rgba(6, 182, 212, 0.7)',
          } : {
            backgroundColor: 'rgba(63, 63, 70, 0.8)',
            borderColor: 'rgba(82, 82, 91, 0.6)',
          }}
          pressStyle={hasFileAttachment ? {
            backgroundColor: 'rgba(6, 182, 212, 0.4)',
            borderColor: 'rgba(6, 182, 212, 0.8)',
            scale: 0.95,
          } : {
            backgroundColor: 'rgba(39, 39, 42, 1)',
            borderColor: 'rgba(82, 82, 91, 0.8)',
            scale: 0.95,
          }}
          icon={<Paperclip size={20} color={
            hasFileAttachment 
              ? (isAttachHovered ? '#22D3EE' : '#06B6D4')
              : (isAttachHovered ? '#A1A1AA' : '#71717A')
          } />}
        />
        <Input
          ref={singleLineInputRef}
          flex={1}
          backgroundColor="transparent"
          borderWidth={0}
          outlineWidth={0}
          focusStyle={{ borderWidth: 0, outlineWidth: 0 }}
          paddingHorizontal="$2"
          paddingVertical="$1"
          fontSize="$4"
          color="$color"
          placeholderTextColor="$placeholderColor"
          placeholder={placeholder}
          value={text}
          onChangeText={setText}
          disabled={disabled}
        />
        {rightButton}
      </XStack>
    );
  };

  return (
    <YStack
      borderTopWidth={1}
      borderTopColor="rgba(63, 63, 70, 0.5)"
      borderTopLeftRadius={16}
      borderTopRightRadius={16}
      backgroundColor="rgba(39, 39, 42, 0.92)"
      onPress={handleContainerPress}
      cursor={isRecordingOrPaused ? 'default' : 'text'}
    >
      <ErrorBanner />

      {/* File attachment preview */}
      {hasFileAttachment && (
        <XStack
          paddingHorizontal="$3"
          paddingVertical="$2"
          alignItems="center"
          justifyContent="space-between"
          backgroundColor="rgba(6, 182, 212, 0.1)"
          borderBottomWidth={1}
          borderBottomColor="rgba(6, 182, 212, 0.2)"
        >
          <XStack alignItems="center" gap="$2" flex={1}>
            {fileUpload.previewUrl ? (
              <Image
                source={{ uri: fileUpload.previewUrl }}
                width={48}
                height={48}
                borderRadius={6}
                resizeMode="cover"
              />
            ) : (
              <YStack
                width={48}
                height={48}
                borderRadius={6}
                backgroundColor="rgba(6, 182, 212, 0.2)"
                alignItems="center"
                justifyContent="center"
              >
                <FileText size={24} color="#06B6D4" />
              </YStack>
            )}

            <YStack flex={1}>
              <Text fontSize="$3" color="$color" numberOfLines={1}>
                {fileUpload.selectedFile?.name}
              </Text>
              <Text fontSize="$2" color="$colorSubtle">
                {fileUpload.isUploading
                  ? `Uploading... ${fileUpload.progress}%`
                  : `${((fileUpload.selectedFile?.size || 0) / 1024).toFixed(1)} KB`}
              </Text>
              {fileUpload.error && (
                <Text fontSize="$2" color="#EF4444">
                  {fileUpload.error}
                </Text>
              )}
            </YStack>
          </XStack>

          <Button
            size="$2"
            circular
            chromeless
            onPress={fileUpload.clear}
            disabled={fileUpload.isUploading}
            icon={<X size={16} color="#71717A" />}
          />
        </XStack>
      )}

      {renderContent()}
    </YStack>
  );
}
