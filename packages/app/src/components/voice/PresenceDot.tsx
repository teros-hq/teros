/**
 * PresenceDot — presence across the whole app (ui-evolution.md §3.7)
 *
 * An 8px dot next to the agent name in the Navbar. Same color language as
 * the PresenceOrb (presence+mode color), reduced animation (a soft blink
 * only while connecting/reconnecting — never audio theatre, AC-UX2).
 *
 * Always-on is visible across the app, not just in one corner (UX §3.1).
 * The state arrives for free: VoiceSessionProvider wraps the Navbar
 * (app/(workspace)/_layout.tsx) — this component just reads the context.
 *
 * Gated by the voice.mode-ui feature flag — the Navbar only mounts it when
 * the v2 presence UI is on (zero regression with the flag off).
 */

import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import type { VoiceActivity, VoiceMode, VoicePresence } from '@teros/shared';
import { colors } from '../mca/primitives/colors';
import { MODE_COLORS } from './ModePicker';

// ─── Props ───────────────────────────────────────────────────────────────────

export interface PresenceDotProps {
  presence: VoicePresence;
  mode: VoiceMode;
  activity: VoiceActivity;
  /** Dot size — 8px in the navbar (§3.7). */
  size?: number;
}

// ─── The dot ──────────────────────────────────────────────────────────────────

export function PresenceDot({ presence, mode, activity, size = 8 }: PresenceDotProps) {
  const blink = useRef(new Animated.Value(1)).current;

  // Soft blink ONLY while connecting / reconnecting — a waiting signal,
  // not an audio simulation (AC-UX2: no animation simulates audio).
  const shouldBlink = presence === 'connecting' || activity === 'reconnecting';

  useEffect(() => {
    if (!shouldBlink) {
      blink.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(blink, { toValue: 0.3, duration: 600, useNativeDriver: true }),
        Animated.timing(blink, { toValue: 1, duration: 600, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [shouldBlink, blink]);

  // Color language — same as the orb: presence first, then mode.
  const dotColor =
    presence === 'error'
      ? colors.red
      : presence === 'connecting'
        ? colors.amber
        : MODE_COLORS[mode];

  // Reduced activity animation: hearing/speaking get a slightly brighter dot
  // (opacity 1 vs the resting 0.85) — quiet, ambient, no waveform.
  const active = activity === 'hearing' || activity === 'speaking';

  return (
    <Animated.View
      accessibilityLabel="voice presence"
      style={[
        styles.dot,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: dotColor,
          opacity: blink.interpolate({ inputRange: [0.3, 1], outputRange: [0.3, active ? 1 : 0.85] }),
        },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  dot: {
    flexShrink: 0,
  },
});
