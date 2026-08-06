/**
 * VoiceControls - Control bar for voice conversation
 *
 * Replaces the InputComposer when a voice session is active.
 * Same visual language as InputComposer:
 *   [mute btn] [center field: dot/avatar · state label · waveform mini] [end btn]
 *
 * States:
 *   - listening  → green dot, "Escuchando", red waveform (user audio)
 *   - speaking   → agent avatar (pulsing indigo ring), "Hablando", indigo waveform (agent audio)
 *   - thinking   → green dot, "Pensando...", no waveform
 *   - connecting → green dot (blinking), "Conectando...", no waveform
 *   - muted      → red dot, "Silenciado", no waveform
 *   - idle       → gray dot, "Toca para iniciar", green connect button
 */

import { Mic, MicOff, PhoneOff, Phone } from '@tamagui/lucide-icons';
import React, { useEffect, useRef } from 'react';
import { Animated, Image, Platform } from 'react-native';
import { Button, View, Text, XStack } from 'tamagui';
import { colors } from '../mca/primitives/colors';
import { useColors } from '../mca/primitives/useColors';
import type { VoiceSessionState, VoiceSessionError } from '../../contexts/VoiceSessionContext';

// ─── Waveform constants (same as VoiceRecordingBar) ───────────────────────────
const WAVEFORM_BARS = 10;
const BAR_WIDTH = 3;
const BAR_GAP = 3;
const MIN_BAR_HEIGHT = 2;
const MAX_BAR_HEIGHT = 22;
const TOTAL_WAVEFORM_WIDTH = WAVEFORM_BARS * BAR_WIDTH + (WAVEFORM_BARS - 1) * BAR_GAP; // 58px

// ─── Props ────────────────────────────────────────────────────────────────────

interface VoiceControlsProps {
  state: VoiceSessionState;
  isConnected: boolean;
  isMuted: boolean;
  agentAvatarUrl?: string;
  /** Normalized audio level 0-1 (user mic when listening, agent audio when speaking) */
  audioLevel: number;
  /** AF-7: Error state — when set, shows error label in the status field */
  error?: VoiceSessionError | null;
  onConnect: () => void;
  onDisconnect: () => void;
  onToggleMute: () => void;
}

// ─── Mini waveform (web canvas, native Animated bars) ─────────────────────────

interface WaveformMiniProps {
  samples: number[];
  color: string;
  emptyColor: string;
}

function WaveformMini({ samples, color, emptyColor }: WaveformMiniProps) {
  const emptySlots = Math.max(0, WAVEFORM_BARS - samples.length);

  return (
    <XStack
      width={TOTAL_WAVEFORM_WIDTH}
      height={MAX_BAR_HEIGHT}
      alignItems="center"
      gap={BAR_GAP}
    >
      {Array.from({ length: WAVEFORM_BARS }).map((_, i) => {
        const isEmpty = i < emptySlots;
        const sampleIdx = i - emptySlots;
        const val = !isEmpty && sampleIdx < samples.length ? (samples[sampleIdx] ?? 0) : 0;
        const barH = isEmpty ? MIN_BAR_HEIGHT : MIN_BAR_HEIGHT + val * (MAX_BAR_HEIGHT - MIN_BAR_HEIGHT);

        return (
          <View
            key={i}
            width={BAR_WIDTH}
            height={barH}
            borderRadius={1.5}
            backgroundColor={isEmpty ? emptyColor : color}
          />
        );
      })}
    </XStack>
  );
}

// ─── Agent avatar with pulsing indigo ring ──────────────────────────────────────

function AgentAvatar({ uri, borderColor }: { uri: string; borderColor: string }) {
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 900,
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 900,
          useNativeDriver: true,
        }),
      ])
    ).start();
    return () => pulse.stopAnimation();
  }, [pulse]);

  const shadowOpacity = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 0.5],
  });

  return (
    <Animated.View
      style={{
        width: 28,
        height: 28,
        borderRadius: 14,
        shadowColor: colors.indigo,
        shadowOffset: { width: 0, height: 0 },
        shadowRadius: 6,
        shadowOpacity,
        // Android elevation doesn't support color, use border instead
        borderWidth: 1.5,
        borderColor,
        flexShrink: 0,
      }}
    >
      <Image
        source={{ uri }}
        style={{ width: 25, height: 25, borderRadius: 12.5 }}
        resizeMode="cover"
      />
    </Animated.View>
  );
}

// ─── Blinking dot ─────────────────────────────────────────────────────────────

function StatusDot({ color, blink = false }: { color: string; blink?: boolean }) {
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!blink) {
      opacity.setValue(1);
      return;
    }
    Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.3, duration: 600, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 600, useNativeDriver: true }),
      ])
    ).start();
    return () => opacity.stopAnimation();
  }, [blink, opacity]);

  return (
    <Animated.View
      style={{
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: color,
        opacity,
        flexShrink: 0,
      }}
    />
  );
}

// ─── Waveform sample accumulator hook ─────────────────────────────────────────

function useWaveformSamples(active: boolean, audioLevel: number) {
  const samplesRef = useRef<number[]>([]);
  // Keep a ref to the latest audioLevel so the interval closure never goes stale
  const audioLevelRef = useRef(audioLevel);
  audioLevelRef.current = audioLevel;
  const [samples, setSamples] = React.useState<number[]>([]);

  useEffect(() => {
    if (!active) {
      samplesRef.current = [];
      setSamples([]);
      return;
    }

    // Poll at ~20fps (50ms). audioLevel is read via ref so the interval is
    // stable and never recreated on every audio level change.
    const interval = setInterval(() => {
      const level = audioLevelRef.current;
      const prev = samplesRef.current;
      const next =
        prev.length < WAVEFORM_BARS
          ? [...prev, level]
          : [...prev.slice(1), level];
      samplesRef.current = next;
      setSamples(next);
    }, 50);

    return () => clearInterval(interval);
  // Only recreate the interval when active changes, not on every audioLevel tick
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  return samples;
}

// ─── Main component ───────────────────────────────────────────────────────────

export function VoiceControls({
  state,
  isConnected,
  isMuted,
  agentAvatarUrl,
  audioLevel,
  error,
  onConnect,
  onDisconnect,
  onToggleMute,
}: VoiceControlsProps) {
  const c = useColors();

  const isIdle = !isConnected && state === 'idle';
  const isConnecting = state === 'connecting';
  const isSpeaking = state === 'speaking';
  const isListening = state === 'listening';
  const isThinking = state === 'thinking';
  const isError = !!error;

  // Waveform only when someone is actually producing audio
  const userWaveActive = isListening && !isMuted;
  const agentWaveActive = isSpeaking;

  const userSamples = useWaveformSamples(userWaveActive, audioLevel);
  const agentSamples = useWaveformSamples(agentWaveActive, audioLevel);

  // ── State label ──
  const stateLabel = isError
    ? 'Error'
    : isMuted
      ? 'Silenciado'
      : isConnecting
        ? 'Conectando...'
        : isListening
          ? 'Escuchando'
          : isSpeaking
            ? 'Hablando'
            : isThinking
              ? 'Pensando...'
              : isIdle
                ? 'Toca para iniciar'
                : 'Conectando...';

  const stateLabelColor = isError
    ? colors.red
    : isMuted
      ? colors.red
      : isListening
        ? colors.green
        : isSpeaking
          ? colors.indigo
          : isThinking
            ? c.text3
            : c.text3;

  // ── Dot ──
  const dotColor = isError
    ? colors.red
    : isMuted
      ? colors.red
      : isConnected
        ? colors.green
        : c.text3;
  const dotBlink = isError || isMuted || isConnecting;

  // ── Left button (mute/unmute) ──
  const micDisabled = isIdle || isConnecting;
  const micBg = isMuted
    ? 'rgba(239,68,68,0.2)'
    : c.bgCard;
  const micBorder = isMuted
    ? 'rgba(239,68,68,0.5)'
    : c.border;
  const MicIcon = isMuted ? MicOff : Mic;
  const micIconColor = isMuted ? colors.red : c.text3;

  // ── Right button (connect/disconnect/retry) ──
  const rightBg = isError
    ? 'rgba(239,68,68,0.2)'
    : isIdle
      ? 'rgba(34,197,94,0.15)'
      : 'rgba(239,68,68,0.2)';
  const rightBorder = isError
    ? 'rgba(239,68,68,0.5)'
    : isIdle
      ? 'rgba(34,197,94,0.4)'
      : 'rgba(239,68,68,0.5)';
  const RightIcon = isError ? Phone : isIdle ? Phone : PhoneOff;
  const rightIconColor = isError ? colors.green : isIdle ? colors.green : colors.red;

  // ── Theme-adaptive colors for backgrounds ──
  const barBg = c.bgPage;
  const barBorder = c.border;
  const fieldBg = c.bgCard;
  const fieldBorder = c.border;
  const waveformEmpty = `${c.text3}4D`; // ~30% opacity

  return (
    <XStack
      backgroundColor={barBg}
      borderTopWidth={1}
      borderTopColor={barBorder}
      borderTopLeftRadius={16}
      borderTopRightRadius={16}
      paddingHorizontal="$3"
      paddingTop="$2"
      paddingBottom="$3"
      alignItems="center"
      gap="$2"
    >
      {/* Left: Mute button */}
      <Button
        width={44}
        height={44}
        padding={0}
        borderRadius={10}
        backgroundColor={micBg}
        borderWidth={1}
        borderColor={micBorder}
        onPress={onToggleMute}
        disabled={micDisabled}
        opacity={micDisabled ? 0.35 : 1}
        pressStyle={{ opacity: 0.7, scale: 0.95 }}
        icon={<MicIcon size={20} color={micIconColor} />}
      />

      {/* Center: status field — same look as text input in InputComposer */}
      <XStack
        flex={1}
        backgroundColor={fieldBg}
        borderRadius={8}
        borderWidth={1}
        borderColor={fieldBorder}
        height={44}
        paddingHorizontal="$3"
        alignItems="center"
        gap="$2"
        overflow="hidden"
      >
        {/* Left indicator: avatar when agent speaks, dot otherwise */}
        {isSpeaking && agentAvatarUrl ? (
          <AgentAvatar uri={agentAvatarUrl} borderColor={`${colors.indigo}99`} />
        ) : (
          <StatusDot color={dotColor} blink={dotBlink} />
        )}

        {/* State label */}
        <Text
          flex={1}
          fontSize={13}
          color={stateLabelColor}
          numberOfLines={1}
        >
          {stateLabel}
        </Text>

        {/* Waveform mini — right side, only when audio is active */}
        {userWaveActive && <WaveformMini samples={userSamples} color={colors.red} emptyColor={waveformEmpty} />}
        {agentWaveActive && <WaveformMini samples={agentSamples} color={colors.indigo} emptyColor={waveformEmpty} />}
      </XStack>

      {/* Right: Connect / Disconnect button */}
      <Button
        width={44}
        height={44}
        padding={0}
        borderRadius={10}
        backgroundColor={rightBg}
        borderWidth={1}
        borderColor={rightBorder}
        onPress={isError ? onConnect : isIdle ? onConnect : onDisconnect}
        disabled={isConnecting}
        opacity={isConnecting ? 0.5 : 1}
        pressStyle={{ opacity: 0.7, scale: 0.95 }}
        icon={<RightIcon size={20} color={rightIconColor} />}
      />
    </XStack>
  );
}
